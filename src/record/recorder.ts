// PCM -> per-frame features -> Detector -> sound events, audio chunks and
// snore episodes in IndexedDB. Time is derived from sample counts, not timers.
import { FRAME_SIZE, SAMPLE_RATE } from '../detect/params.ts';
import type { DetectParams } from '../detect/params.ts';
import { HighPass, LowPass, computeFeatures } from '../detect/bands.ts';
import { Detector, burstStats } from '../detect/detector.ts';
import type { DetectorAction, DetectorSnapshot } from '../detect/detector.ts';
import { dequantizeDb } from '../detect/levels.ts';
import { computeCalibration, effectiveMargins } from '../detect/calibrate.ts';
import type { Burst } from '../detect/snore.ts';
import type { NightRecord, SnoreEpisodeRecord, SoundEventRecord } from '../monitor/types';
import { dropEventAudio, putNight, putSnoreEpisode, putSoundEvent, saveChunk } from '../storage/db';
import { Int16Ring } from './ring.ts';

export interface RecorderStatus {
  snapshot: DetectorSnapshot;
  soundEventCount: number;     // 本晚已提交的事件數(含其他 session;長事件的後續段不重複計)
  snoreEpisodeCount: number;
  audioSecUsed: number;
}

export interface RecorderHooks {
  /** Reported as an 'error' state event by the session. */
  onError: (detail: string) => void;
  /** Counts already stored for this night (a resumed night). */
  priorEventCount: number;
  priorSnoreCount: number;
  /** Quantized dB of the calibration's quiet phase; seeds the noise floor. */
  seedFloor: Uint8Array | null;
}

const FRAME_MS = (FRAME_SIZE / SAMPLE_RATE) * 1000;
/** A snore sample event counts as "just snoring" when its core starts no earlier than this before the episode. */
const SAMPLE_GRACE_MS = 1000;
const CHUNK_SAMPLES = SAMPLE_RATE;           // write about once per second of audio
const MAX_PENDING_SAMPLES = 30 * SAMPLE_RATE; // audio kept in memory while writes fail

interface LiveEvent {
  rec: SoundEventRecord;
  tentative: boolean;
  writtenTo: number;          // absolute sample index written into `pending` so far
  pending: Int16Array[];
  pendingLen: number;
  seq: number;
  persisted: boolean;         // the record has been queued for writing at least once
}

interface LiveEpisode {
  rec: SnoreEpisodeRecord;
  bursts: Burst[];
}

type Task =
  | { kind: 'event'; rec: SoundEventRecord }
  | { kind: 'episode'; rec: SnoreEpisodeRecord }
  | { kind: 'night' }
  | { kind: 'drop-audio'; ev: SoundEventRecord }
  | { kind: 'chunk'; ev: SoundEventRecord; seq: number; pcm: Int16Array };

export class Recorder {
  private readonly night: NightRecord;
  private readonly sessionId: string;
  private readonly p: DetectParams;
  private readonly hooks: RecorderHooks;
  private readonly detector: Detector;
  private readonly lp: LowPass;
  private readonly hp: HighPass;
  private readonly scratch = new Float32Array(FRAME_SIZE);
  private readonly ring: Int16Ring;

  private nextFrame = 0;
  private anchor: { frame: number; wallMs: number } | null = null;
  private prevCtx: { time: number; samples: number } | null = null;
  private readonly recentQ = new Uint8Array(16);

  private readonly events = new Map<number, LiveEvent>();
  private readonly recentRecords = new Map<number, SoundEventRecord>(); // finished, for snore samples
  private lastEndedSplit: { key: number; id: string } | null = null;
  private episode: LiveEpisode | null = null;
  private eventCount: number;
  private snoreCount: number;
  private audioSecQueued: number;
  private finished = false;
  private finishing = false;

  private readonly queue: Task[] = [];
  private draining: Promise<void> | null = null;
  private failing = false;

  /** night 由 session 建立後傳入。detector 用 night.calibration 的 margin 建立。 */
  constructor(night: NightRecord, sessionId: string, p: DetectParams, hooks: RecorderHooks) {
    this.night = night;
    this.sessionId = sessionId;
    this.p = p;
    this.hooks = hooks;
    const cal = night.calibration ?? computeCalibration(new Uint8Array(0), new Uint8Array(0), p);
    const { trigger, release } = effectiveMargins(cal, night.mode, p);
    this.detector = new Detector(p, trigger, release, night.mode === 'test');
    if (hooks.seedFloor && hooks.seedFloor.length > 0) this.detector.seedFloor(hooks.seedFloor);
    this.lp = new LowPass(p.snoreLowCutHz, SAMPLE_RATE);
    this.hp = new HighPass(p.levelHighPassHz, SAMPLE_RATE);
    this.ring = new Int16Ring((p.preRollSec + p.snoreMaxBurstSec + 2) * SAMPLE_RATE);
    this.eventCount = hooks.priorEventCount;
    this.snoreCount = hooks.priorSnoreCount;
    this.audioSecQueued = night.audioSecUsed;
  }

  /** 每收到一份 WorkletStats.pcm 呼叫一次。依序切成 512 樣本的幀，逐幀 computeFeatures → detector.push → 執行動作。 */
  onPcm(pcm: Int16Array, ctxTime: number, receivedAt: number): void {
    if (this.finished || this.finishing) return;
    if (this.prevCtx && ctxTime - this.prevCtx.time > this.prevCtx.samples / SAMPLE_RATE + 0.5) {
      this.onGap('ctx-jump');
    }
    this.prevCtx = { time: ctxTime, samples: pcm.length };
    if (!this.anchor) {
      this.anchor = { frame: this.nextFrame, wallMs: receivedAt - (pcm.length / SAMPLE_RATE) * 1000 };
    }
    for (let off = 0; off + FRAME_SIZE <= pcm.length; off += FRAME_SIZE) {
      this.ring.push(pcm.subarray(off, off + FRAME_SIZE));
      const f = computeFeatures(pcm, off, this.nextFrame, this.lp, this.hp, this.scratch);
      this.recentQ.copyWithin(0, 1);
      this.recentQ[this.recentQ.length - 1] = f.zero ? 0 : f.q;
      const db = dequantizeDb(f.q);
      for (const ev of this.events.values()) {
        if (!f.zero && db > ev.rec.peakDb) ev.rec.peakDb = db;
      }
      const actions = this.detector.push(f);
      this.nextFrame++;
      for (const a of actions) this.apply(a);
      this.pump();
    }
    this.kick();
  }

  /** session 偵測到中斷時呼叫(timer-gap、ctx-state 非 running、track-mute / ended、recovery-*)。 */
  onGap(_reason: string): void {
    if (this.finished) return;
    for (const a of this.detector.handleGap(this.nextFrame)) this.apply(a);
    this.ring.clear();
    this.anchor = null;
    this.prevCtx = null;
    this.kick();
  }

  /** 停止時呼叫：結束進行中的事件與時段，寫完所有待寫資料。 */
  async finish(): Promise<void> {
    if (this.finished) return;
    this.finishing = true;
    for (const a of this.detector.handleGap(this.nextFrame)) this.apply(a, true);
    this.finished = true;
    this.kick();
    await this.drained();
    if (this.queue.length > 0) {
      // One more attempt for anything a failed write left behind.
      this.failing = false;
      this.kick();
      await this.drained();
    }
  }

  status(): RecorderStatus {
    return {
      snapshot: this.detector.snapshot(),
      soundEventCount: this.eventCount,
      snoreEpisodeCount: this.snoreCount,
      audioSecUsed: this.night.audioSecUsed,
    };
  }

  // ---------- actions ----------

  private wall(frame: number): number {
    const a = this.anchor ?? { frame: this.nextFrame, wallMs: Date.now() };
    return Math.round(a.wallMs + (frame - a.frame) * FRAME_MS);
  }

  private apply(a: DetectorAction, stopping = false): void {
    switch (a.type) {
      case 'event-start': {
        const peak = Math.max(...this.recentQ);
        const continuesFrom = a.continuesKey !== null && this.lastEndedSplit?.key === a.continuesKey
          ? this.lastEndedSplit.id : null;
        const rec: SoundEventRecord = {
          id: crypto.randomUUID(),
          nightId: this.night.id,
          sessionId: this.sessionId,
          startAt: this.wall(a.fromFrame),
          endAt: null,
          coreStartAt: this.wall(a.coreFromFrame),
          coreEndAt: null,
          peakDb: dequantizeDb(peak),
          floorDbAtStart: this.detector.snapshot().floorDb ?? -120,
          endReason: null,
          continuesFrom,
          hasAudio: this.audioSecQueued < this.p.audioBudgetSec,
          audioIncomplete: false,
          sampleCount: 0,
          snoreEpisodeId: null,
          snoreLike: false,
        };
        const ev: LiveEvent = {
          rec, tentative: a.tentative, writtenTo: a.fromFrame * FRAME_SIZE,
          pending: [], pendingLen: 0, seq: 0, persisted: false,
        };
        this.events.set(a.eventKey, ev);
        if (!a.tentative) this.commitEvent(ev, continuesFrom !== null);
        break;
      }
      case 'event-commit': {
        const ev = this.events.get(a.eventKey);
        if (!ev) break;
        ev.tentative = false;
        ev.rec.snoreLike = a.snoreLike;
        this.commitEvent(ev, false);
        break;
      }
      case 'event-discard':
        this.events.delete(a.eventKey);
        break;
      case 'event-end': {
        const ev = this.events.get(a.eventKey);
        if (!ev) break;
        this.pumpEvent(ev, a.toFrame * FRAME_SIZE);
        this.flushEvent(ev);
        ev.rec.endAt = this.wall(a.toFrame);
        ev.rec.coreEndAt = this.wall(a.coreToFrame);
        ev.rec.endReason = stopping && a.reason === 'gap' ? 'stopped' : a.reason;
        this.enqueue({ kind: 'event', rec: ev.rec });
        this.events.delete(a.eventKey);
        this.recentRecords.set(a.eventKey, ev.rec);
        if (this.recentRecords.size > 32) this.recentRecords.delete(this.recentRecords.keys().next().value!);
        this.lastEndedSplit = a.reason === 'split' ? { key: a.eventKey, id: ev.rec.id } : null;
        break;
      }
      case 'snore-start': {
        const st = burstStats(a.bursts);
        const rec: SnoreEpisodeRecord = {
          id: crypto.randomUUID(),
          nightId: this.night.id,
          sessionId: this.sessionId,
          startAt: this.wall(a.fromFrame),
          endAt: null,
          burstCount: a.bursts.length,
          ...st,
          endReason: null,
        };
        this.episode = { rec, bursts: [...a.bursts] };
        this.snoreCount++;
        this.enqueue({ kind: 'episode', rec });
        for (const key of a.sampleEventKeys) {
          const r = this.recentRecords.get(key) ?? this.events.get(key)?.rec;
          if (!r) continue;
          r.snoreEpisodeId = rec.id;
          // Formal mode stores no snore audio. Only drop it when the event is essentially the
          // snores themselves (it started with the first snore), so sound before them is kept.
          if (this.night.mode === 'formal' && r.hasAudio && r.coreStartAt >= rec.startAt - SAMPLE_GRACE_MS) {
            this.enqueue({ kind: 'drop-audio', ev: r });
          } else {
            this.enqueue({ kind: 'event', rec: r });
          }
        }
        break;
      }
      case 'snore-burst': {
        const ep = this.episode;
        if (!ep) break;
        ep.bursts.push(a.burst);
        ep.rec.burstCount = ep.bursts.length;
        Object.assign(ep.rec, burstStats(ep.bursts));
        if (ep.rec.burstCount % 10 === 0) this.enqueue({ kind: 'episode', rec: ep.rec });
        break;
      }
      case 'snore-end': {
        const ep = this.episode;
        if (!ep) break;
        ep.rec.endAt = this.wall(a.toFrame);
        ep.rec.endReason = stopping && a.reason === 'gap' ? 'stopped' : a.reason;
        this.enqueue({ kind: 'episode', rec: ep.rec });
        this.episode = null;
        break;
      }
    }
  }

  private commitEvent(ev: LiveEvent, isContinuation: boolean): void {
    if (!isContinuation) this.eventCount++;
    ev.persisted = true;
    this.enqueue({ kind: 'event', rec: ev.rec });
    // Audio from fromFrame up to now is still in the ring (tentative events are short).
    this.pumpEvent(ev, this.nextFrame * FRAME_SIZE);
  }

  /** Moves committed events' audio from the ring into their pending buffers. */
  private pump(): void {
    for (const ev of this.events.values()) {
      if (!ev.tentative) this.pumpEvent(ev, this.nextFrame * FRAME_SIZE);
    }
  }

  private pumpEvent(ev: LiveEvent, to: number): void {
    if (ev.tentative || to <= ev.writtenTo) return;
    if (!ev.rec.hasAudio) {
      ev.writtenTo = to;
      return;
    }
    if (ev.writtenTo < this.ring.oldestIndex) ev.rec.audioIncomplete = true;
    const part = this.ring.read(ev.writtenTo, to);
    ev.writtenTo = to;
    if (part.length > 0) {
      ev.pending.push(part);
      ev.pendingLen += part.length;
    }
    if (ev.pendingLen >= CHUNK_SAMPLES) this.flushEvent(ev);
  }

  private flushEvent(ev: LiveEvent): void {
    if (ev.pendingLen === 0) return;
    const pcm = new Int16Array(ev.pendingLen);
    let o = 0;
    for (const p of ev.pending) {
      pcm.set(p, o);
      o += p.length;
    }
    ev.pending = [];
    ev.pendingLen = 0;
    this.audioSecQueued += pcm.length / SAMPLE_RATE;
    this.enqueue({ kind: 'chunk', ev: ev.rec, seq: ev.seq++, pcm });
  }

  // ---------- serialized writes ----------

  private enqueue(t: Task): void {
    if (t.kind === 'event' || t.kind === 'episode') {
      // A queued put writes the latest state anyway; skip duplicates still waiting.
      const dup = this.queue.some((q, i) => i > 0 && q.kind === t.kind && q.rec === t.rec);
      if (dup) return;
    }
    this.queue.push(t);
    if (t.kind === 'chunk') this.capPending();
  }

  /** Drops the oldest unwritten audio when writes keep failing. */
  private capPending(): void {
    let total = 0;
    for (const t of this.queue) if (t.kind === 'chunk') total += t.pcm.length;
    while (total > MAX_PENDING_SAMPLES) {
      const i = this.queue.findIndex((t, k) => k > 0 && t.kind === 'chunk');
      if (i < 0) break;
      const t = this.queue[i] as Extract<Task, { kind: 'chunk' }>;
      this.queue.splice(i, 1);
      total -= t.pcm.length;
      this.audioSecQueued -= t.pcm.length / SAMPLE_RATE;
      t.ev.audioIncomplete = true;
      this.queue.push({ kind: 'event', rec: t.ev });
    }
  }

  private kick(): void {
    if (this.draining || this.queue.length === 0) return;
    this.draining = this.drain().finally(() => {
      this.draining = null;
    });
  }

  private async drained(): Promise<void> {
    while (this.draining) await this.draining;
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const t = this.queue[0]!;
      try {
        await this.run(t);
        this.queue.shift();
        if (this.failing) {
          this.failing = false;
          this.hooks.onError('db write recovered');
        }
      } catch (err) {
        if (!this.failing) {
          this.failing = true;
          this.hooks.onError(`recorder db write ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
        }
        return; // retried on the next onPcm
      }
    }
  }

  private async run(t: Task): Promise<void> {
    switch (t.kind) {
      case 'event':
        await putSoundEvent({ ...t.rec });
        return;
      case 'episode':
        await putSnoreEpisode({ ...t.rec });
        return;
      case 'night':
        await putNight({ ...this.night });
        return;
      case 'drop-audio': {
        const sec = t.ev.sampleCount / SAMPLE_RATE;
        const ev = { ...t.ev, hasAudio: false, sampleCount: 0 };
        await dropEventAudio(ev, { ...this.night, audioSecUsed: Math.max(0, this.night.audioSecUsed - sec) });
        t.ev.hasAudio = false;
        t.ev.sampleCount = 0;
        this.night.audioSecUsed = Math.max(0, this.night.audioSecUsed - sec);
        this.audioSecQueued = Math.max(0, this.audioSecQueued - sec);
        return;
      }
      case 'chunk': {
        const n = t.pcm.length;
        const ev = { ...t.ev, sampleCount: t.ev.sampleCount + n };
        const night = { ...this.night, audioSecUsed: this.night.audioSecUsed + n / SAMPLE_RATE };
        const buf = t.pcm.buffer.byteLength === n * 2 ? t.pcm.buffer : t.pcm.slice().buffer;
        await saveChunk({ eventId: t.ev.id, seq: t.seq, pcm: buf as ArrayBuffer }, ev, night);
        t.ev.sampleCount += n;
        this.night.audioSecUsed += n / SAMPLE_RATE;
        return;
      }
    }
  }
}
