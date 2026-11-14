// Event state machine: noise floor + hysteresis + pre/post-roll + merge/split,
// with the snore rhythm tracker layered on top. Time is counted in frames only.
import type { FrameFeatures } from './bands.ts';
import { FloorTracker, dequantizeDb } from './levels.ts';
import { FRAME_SEC, secToFrames } from './params.ts';
import type { DetectParams } from './params.ts';
import { SnoreTracker, median } from './snore.ts';
import type { Burst } from './snore.ts';

export type DetectorAction =
  // fromFrame = 觸發窗口起點 − pre-roll;coreFromFrame = 窗口內第一個超過觸發門檻的幀;continuesKey = 長事件切段時的前一段
  | { type: 'event-start'; eventKey: number; fromFrame: number; coreFromFrame: number; tentative: boolean; continuesKey: number | null }
  // tentative → 正式。snoreLike 只在 keepSnoreAudio 時出現
  | { type: 'event-commit'; eventKey: number; snoreLike: boolean }
  | { type: 'event-discard'; eventKey: number; asSnore: true } // tentative 判定為打呼，丟掉音訊
  // toFrame 不含;coreToFrame = 開始 post-roll 的那一幀(沒有 post-roll 時 = toFrame)
  | { type: 'event-end'; eventKey: number; toFrame: number; coreToFrame: number; reason: 'released' | 'split' | 'gap' | 'snore-confirmed' | 'floor-shift' }
  | { type: 'snore-start'; episodeKey: number; fromFrame: number; sampleEventKeys: number[]; bursts: Burst[] }
  | { type: 'snore-burst'; episodeKey: number; burst: Burst }
  | { type: 'snore-end'; episodeKey: number; toFrame: number; reason: 'quiet' | 'gap' };

export interface DetectorSnapshot {
  floorDb: number | null; triggerDb: number | null; releaseDb: number | null;
  state: 'warmup' | 'idle' | 'active' | 'post-roll';
  inSnoreEpisode: boolean;
}

interface OpenEvent {
  key: number;
  fromFrame: number;   // audio start of this segment
  tentative: boolean;
}

interface OpenBurst {
  start: number;
  ms: number;
  lowMs: number;
  peakQ: number;
  quiet: number;
  tooLong: boolean;
}

const RECENT_EVENTS = 32;

export class Detector {
  private readonly p: DetectParams;
  private readonly triggerMargin: number;
  private readonly releaseMargin: number;
  private readonly keepSnoreAudio: boolean;
  private readonly floor: FloorTracker;
  private readonly shortFloor: FloorTracker; // last floorShiftSec, same percentile
  private readonly shiftFrames: number;
  private readonly snore: SnoreTracker;

  private readonly warmFrames: number;
  private readonly releaseFrames: number;
  private readonly postFrames: number;
  private readonly preFrames: number;
  private readonly maxEventFrames: number;
  private readonly burstEndFrames: number;
  private readonly maxBurstFrames: number;
  private readonly winSize: number;

  // trigger window (ring of the last winSize frames)
  private readonly wFrame: Float64Array;
  private readonly wAbove: Uint8Array;
  private readonly wMs: Float64Array;
  private readonly wLow: Float64Array;
  private readonly wQ: Uint8Array;
  private wHead = 0;
  private wLen = 0;
  private wAboveCount = 0;

  private warm = false;
  private event: OpenEvent | null = null;
  private evState: 'idle' | 'active' | 'post-roll' = 'idle';
  private quietRun = 0;
  private postCount = 0;
  private coreTo = 0;
  private burst: OpenBurst | null = null;
  private episodeKey: number | null = null;
  private recent: Array<{ key: number; from: number; to: number }> = [];
  private lastTo = 0;
  private gapFrame = 0;
  private nextEventKey = 0;
  private nextEpisodeKey = 0;
  private cur = 0; // frame being processed
  private floorNow: number | null = null;
  private eventCoreFrom = 0; // core start of the open event, kept across splits

  /** triggerMarginDb / releaseMarginDb 來自睡前校準;eventKey / episodeKey 從 0 遞增。 */
  constructor(p: DetectParams, triggerMarginDb: number, releaseMarginDb: number, keepSnoreAudio = false) {
    this.p = p;
    this.triggerMargin = triggerMarginDb;
    this.releaseMargin = releaseMarginDb;
    this.keepSnoreAudio = keepSnoreAudio;
    this.floor = new FloorTracker(secToFrames(p.floorWindowSec), p.floorPercentile);
    this.snore = new SnoreTracker(p);
    this.shiftFrames = p.floorShiftSec > 0 ? secToFrames(p.floorShiftSec) : 0;
    this.shortFloor = new FloorTracker(Math.max(1, this.shiftFrames), p.floorPercentile);
    this.warmFrames = secToFrames(p.floorMinSec);
    this.releaseFrames = secToFrames(p.releaseSec);
    this.postFrames = secToFrames(p.postRollSec);
    this.preFrames = secToFrames(p.preRollSec);
    this.maxEventFrames = secToFrames(p.maxEventSec);
    this.burstEndFrames = secToFrames(p.burstEndSec);
    this.maxBurstFrames = secToFrames(p.snoreMaxBurstSec);
    this.winSize = Math.max(1, p.triggerWindowFrames);
    this.wFrame = new Float64Array(this.winSize);
    this.wAbove = new Uint8Array(this.winSize);
    this.wMs = new Float64Array(this.winSize);
    this.wLow = new Float64Array(this.winSize);
    this.wQ = new Uint8Array(this.winSize);
  }

  /**
   * 睡前校準第 1 步的量化 dB 依序推入噪音基準。校準已經量過背景，所以視同暖機完成。
   */
  seedFloor(q: Uint8Array): void {
    for (let i = 0; i < q.length; i++) this.floor.push(q[i]!);
    if (this.floor.count > 0) this.warm = true;
    this.floorNow = this.floor.floorDb();
  }

  /** 每幀呼叫一次，依序回傳要執行的動作(可能為空陣列)。 */
  push(f: FrameFeatures): DetectorAction[] {
    const out: DetectorAction[] = [];
    const fi = f.frameIndex;
    this.cur = fi;

    // 1. floor (zero frames are a pipeline fault, not background)
    if (!f.zero) {
      this.floor.push(f.q);
      this.shortFloor.push(f.q);
    }
    if (!this.warm && this.floor.count >= this.warmFrames) this.warm = true;
    this.floorNow = this.floor.floorDb();
    if (!this.warm || this.floorNow === null) return out;

    const triggerDb = this.floorNow + this.triggerMargin;
    const releaseDb = this.floorNow + this.releaseMargin;
    const db = dequantizeDb(f.q);
    const above = !f.zero && db >= triggerDb;
    const below = f.zero || db < releaseDb;
    this.windowPush(fi, above, f);
    const triggered = this.wAboveCount >= this.p.triggerMinFrames;

    // 2. the current burst
    const b = this.burst;
    if (b) {
      b.ms += f.ms;
      b.lowMs += f.lowMs;
      if (!f.zero && f.q > b.peakQ) b.peakQ = f.q;
      b.quiet = below ? b.quiet + 1 : 0;
      if (b.quiet >= this.burstEndFrames) {
        this.endBurst(fi + 1 - b.quiet, out);
      } else if (!b.tooLong && fi + 1 - b.start > this.maxBurstFrames) {
        b.tooLong = true;
        if (this.event?.tentative) this.commit(false, out);
      }
    }

    // 3. snore episode timeout
    const so = this.snore.onFrame(fi);
    if (so?.type === 'ended') this.endEpisode('quiet', so.lastBurstEndFrame, out);

    // 4. event body: release, post-roll, merge
    const ev = this.event;
    if (ev) {
      if (this.evState === 'post-roll' && triggered) {
        if (this.snore.inEpisode && !ev.tentative) {
          // In a snore episode every new sound starts its own tentative event, so a
          // committed event does not swallow the following snores.
          this.endEvent('released', fi + 1, out);
        } else {
          this.evState = 'active'; // merge adjacent sounds into one event
          this.quietRun = 0;
        }
      } else if (this.evState === 'active') {
        this.quietRun = below ? this.quietRun + 1 : 0;
        if (this.quietRun >= this.releaseFrames) {
          this.evState = 'post-roll';
          this.coreTo = fi + 1 - this.quietRun;
          this.postCount = 0;
        }
      } else if (this.evState === 'post-roll') {
        if (++this.postCount >= this.postFrames) this.endEvent('released', fi + 1, out);
      }
    }

    // 5. trigger
    if (triggered && !this.burst) this.startBurst();
    if (triggered && !this.event) this.startEvent(fi, this.snore.inEpisode, out);

    // 5b. background step (design: N1 tuning). The event has been loud for floorShiftSec and even
    // the quietest floorPercentile % of that time stays above release: it never went back to quiet,
    // so this is a new background (AC, fan), not a sound. End it and rebase the floor on that time,
    // instead of waiting for the long window (~0.8 × floorWindowSec) to catch up.
    const e1 = this.event;
    if (this.shiftFrames > 0 && e1 && !e1.tentative && this.evState === 'active' &&
        fi + 1 - this.eventCoreFrom >= this.shiftFrames && this.shortFloor.count >= this.shiftFrames) {
      const sf = this.shortFloor.floorDb();
      if (sf !== null && sf >= releaseDb) {
        this.endEvent('floor-shift', fi + 1, out);
        this.floor.rebaseFrom(this.shortFloor);
        this.floorNow = this.floor.floorDb();
        this.burst = null;
        this.clearWindow();
        return out;
      }
    }

    // 6. split long events
    const e2 = this.event;
    if (e2 && !e2.tentative && fi + 1 - e2.fromFrame >= this.maxEventFrames) {
      const prevKey = e2.key;
      const state = this.evState;
      const quietRun = this.quietRun;
      const postCount = this.postCount;
      const coreTo = this.coreTo;
      this.endEvent('split', fi + 1, out);
      const key = this.nextEventKey++;
      this.event = { key, fromFrame: fi + 1, tentative: false };
      this.evState = state;
      this.quietRun = quietRun;
      this.postCount = postCount;
      this.coreTo = coreTo;
      this.remember(key, fi + 1);
      out.push({ type: 'event-start', eventKey: key, fromFrame: fi + 1, coreFromFrame: fi + 1, tentative: false, continuesKey: prevKey });
    }
    return out;
  }

  /** 管線中斷(gap)時呼叫：結束進行中的事件與打呼時段，清空觸發窗口;噪音基準保留。 */
  handleGap(atFrame: number): DetectorAction[] {
    const out: DetectorAction[] = [];
    this.cur = atFrame;
    if (this.event) {
      if (this.event.tentative) this.commit(false, out); // 寧可多存
      this.endEvent('gap', atFrame, out);
    }
    if (this.episodeKey !== null) this.endEpisode('gap', atFrame, out);
    this.snore.reset();
    this.burst = null;
    this.clearWindow();
    this.gapFrame = Math.max(this.gapFrame, atFrame);
    this.lastTo = Math.max(this.lastTo, atFrame);
    return out;
  }

  /** 從頭開始(恢復後的新 session):清空噪音基準與一切狀態，重新暖機。 */
  resetAll(): void {
    this.floor.reset();
    this.shortFloor.reset();
    this.snore.reset();
    this.clearWindow();
    this.warm = false;
    this.event = null;
    this.evState = 'idle';
    this.quietRun = 0;
    this.postCount = 0;
    this.burst = null;
    this.episodeKey = null;
    this.recent = [];
    this.lastTo = 0;
    this.gapFrame = 0;
    this.floorNow = null;
  }

  snapshot(): DetectorSnapshot {
    const floorDb = this.floorNow;
    const live = this.warm && floorDb !== null;
    return {
      floorDb,
      triggerDb: live ? floorDb + this.triggerMargin : null,
      releaseDb: live ? floorDb + this.releaseMargin : null,
      state: live ? this.evState : 'warmup',
      inSnoreEpisode: this.snore.inEpisode,
    };
  }

  // ---------- internals ----------

  private windowPush(frame: number, above: boolean, f: FrameFeatures): void {
    const i = this.wHead;
    if (this.wLen === this.winSize) this.wAboveCount -= this.wAbove[i]!;
    else this.wLen++;
    this.wFrame[i] = frame;
    this.wAbove[i] = above ? 1 : 0;
    this.wMs[i] = f.ms;
    this.wLow[i] = f.lowMs;
    this.wQ[i] = f.zero ? 0 : f.q;
    if (above) this.wAboveCount++;
    this.wHead = (i + 1) % this.winSize;
  }

  private clearWindow(): void {
    this.wHead = 0;
    this.wLen = 0;
    this.wAboveCount = 0;
  }

  /** Oldest-first index of the k-th entry in the window. */
  private wIndex(k: number): number {
    return (this.wHead - this.wLen + k + this.winSize * 2) % this.winSize;
  }

  private windowStart(fi: number): number {
    return this.wLen > 0 ? this.wFrame[this.wIndex(0)]! : fi;
  }

  private firstAboveInWindow(fi: number): number {
    for (let k = 0; k < this.wLen; k++) {
      const i = this.wIndex(k);
      if (this.wAbove[i] === 1) return this.wFrame[i]!;
    }
    return fi;
  }

  /** A burst starts at the first above-trigger frame of the window. */
  private startBurst(): void {
    let k = 0;
    while (k < this.wLen && this.wAbove[this.wIndex(k)] === 0) k++;
    const b: OpenBurst = { start: this.wFrame[this.wIndex(k)]!, ms: 0, lowMs: 0, peakQ: 0, quiet: 0, tooLong: false };
    for (; k < this.wLen; k++) {
      const i = this.wIndex(k);
      b.ms += this.wMs[i]!;
      b.lowMs += this.wLow[i]!;
      if (this.wQ[i]! > b.peakQ) b.peakQ = this.wQ[i]!;
    }
    this.burst = b;
  }

  private endBurst(endFrame: number, out: DetectorAction[]): void {
    const b = this.burst!;
    this.burst = null;
    const burst: Burst = {
      startFrame: b.start,
      endFrame,
      peakDb: dequantizeDb(b.peakQ),
      lowRatio: b.ms > 0 ? b.lowMs / b.ms : 0,
    };
    const r = this.snore.onBurst(burst);
    if (r?.type === 'confirmed') {
      const from = r.episodeStartFrame;
      const sampleEventKeys = this.recent.filter((e) => e.to > from && e.from < endFrame).map((e) => e.key);
      if (this.event) {
        if (this.event.tentative) this.commit(false, out);
        this.endEvent('snore-confirmed', this.cur + 1, out);
      }
      const episodeKey = this.nextEpisodeKey++;
      this.episodeKey = episodeKey;
      out.push({ type: 'snore-start', episodeKey, fromFrame: from, sampleEventKeys, bursts: r.bursts });
    } else if (r?.type === 'continued') {
      if (this.event?.tentative) {
        if (this.keepSnoreAudio) this.commit(true, out);
        else this.discard(out);
      }
      out.push({ type: 'snore-burst', episodeKey: this.episodeKey!, burst });
    } else if (this.event?.tentative) {
      this.commit(false, out);
    }
  }

  private endEpisode(reason: 'quiet' | 'gap', toFrame: number, out: DetectorAction[]): void {
    if (this.episodeKey !== null) out.push({ type: 'snore-end', episodeKey: this.episodeKey, toFrame, reason });
    this.episodeKey = null;
    if (this.event?.tentative) this.commit(false, out);
  }

  private startEvent(fi: number, tentative: boolean, out: DetectorAction[]): void {
    const floorFrom = Math.max(this.lastTo, this.gapFrame, 0);
    const ws = this.windowStart(fi);
    const coreFromFrame = Math.max(this.firstAboveInWindow(fi), floorFrom);
    const fromFrame = Math.max(ws - this.preFrames, floorFrom);
    const key = this.nextEventKey++;
    this.event = { key, fromFrame, tentative };
    this.eventCoreFrom = coreFromFrame;
    this.evState = 'active';
    this.quietRun = 0;
    this.postCount = 0;
    this.remember(key, fromFrame);
    out.push({ type: 'event-start', eventKey: key, fromFrame, coreFromFrame, tentative, continuesKey: null });
  }

  private commit(snoreLike: boolean, out: DetectorAction[]): void {
    const ev = this.event!;
    ev.tentative = false;
    out.push({ type: 'event-commit', eventKey: ev.key, snoreLike });
  }

  private discard(out: DetectorAction[]): void {
    const ev = this.event!;
    this.recent = this.recent.filter((e) => e.key !== ev.key);
    out.push({ type: 'event-discard', eventKey: ev.key, asSnore: true });
    this.event = null;
    this.evState = 'idle';
    this.quietRun = 0;
  }

  private endEvent(reason: 'released' | 'split' | 'gap' | 'snore-confirmed' | 'floor-shift', toFrame: number, out: DetectorAction[]): void {
    const ev = this.event!;
    const coreToFrame = this.evState === 'post-roll' ? this.coreTo : toFrame;
    out.push({ type: 'event-end', eventKey: ev.key, toFrame, coreToFrame, reason });
    const r = this.recent.find((e) => e.key === ev.key);
    if (r) r.to = toFrame;
    this.lastTo = Math.max(this.lastTo, toFrame);
    this.event = null;
    this.evState = 'idle';
    this.quietRun = 0;
    this.postCount = 0;
  }

  private remember(key: number, from: number): void {
    this.recent.push({ key, from, to: Infinity });
    if (this.recent.length > RECENT_EVENTS) this.recent.shift();
  }
}

/** Summary numbers of a snore episode from its bursts (start-to-start intervals in seconds). */
export function burstStats(bursts: Burst[]): { medianIntervalSec: number; meanPeakDb: number; meanLowRatio: number } {
  const ivs: number[] = [];
  for (let i = 1; i < bursts.length; i++) ivs.push((bursts[i]!.startFrame - bursts[i - 1]!.startFrame) * FRAME_SEC);
  const n = Math.max(1, bursts.length);
  return {
    medianIntervalSec: median(ivs),
    meanPeakDb: bursts.reduce((s, b) => s + b.peakDb, 0) / n,
    meanLowRatio: bursts.reduce((s, b) => s + b.lowRatio, 0) / n,
  };
}
