import { AudioCapture, errText } from '../audio/capture';
import { HighPass, LowPass, computeFeatures } from '../detect/bands.ts';
import { DEFAULT_PARAMS, FRAME_SIZE, SAMPLE_RATE } from '../detect/params.ts';
import { startMotion } from '../motion/index';
import { Recorder } from '../record/recorder';
import type { RecorderStatus } from '../record/recorder';
import { addEvents, addHeartbeat, getNightData, putNight, putSession } from '../storage/db';
import { StatsAccumulator, startTicker } from './heartbeat';
import type {
  CtxState, WorkletStats, HeartbeatRecord, MonitorEvent, MonitorEventType, NightRecord, SessionRecord, WakeLockStatus,
} from './types';
import { ScreenWakeLock } from './wake-lock';

export interface LiveStatus {
  elapsedMs: number; lastFrames: number; lastDb: number | null;
  ctxState: CtxState; wakeLock: WakeLockStatus; needsGesture: boolean;
}

export type CalibrationListener = (q: number, zero: boolean) => void;

export interface RunningSession {
  readonly id: string;
  readonly nightId: string;
  /** 只在使用者點擊恢復浮層時呼叫(在 gesture 內)。 */
  recoverFromGesture(): void;
  /** 校準階段：每幀的量化 dB 與 zero 旗標。設為 null 後不再呼叫。 */
  setCalibrationListener(fn: CalibrationListener | null): void;
  /** 校準結束，開始偵測與錄音。seedFloor = 校準第 1 步的量化 dB(恢復的 session 為 null,重新暖機)。 */
  beginDetection(night: NightRecord, seedFloor: Uint8Array | null): Promise<void>;
  /** 停止 recorder 與麥克風;night 不為 null 時標記為 stopped。 */
  stop(night?: NightRecord | null): Promise<SessionRecord>;
}

/** M2 interruption signals that also end the current sound event (design_M3 §5 session). */
const GAP_EVENTS: ReadonlySet<MonitorEventType> = new Set<MonitorEventType>([
  'timer-gap', 'track-mute', 'track-ended', 'recovery-attempt',
]);

interface AudioSessionLike extends EventTarget {
  readonly state?: string;
}
interface BatteryLike {
  readonly level: number;
  readonly charging: boolean;
}
type NavigatorExtras = Navigator & {
  audioSession?: AudioSessionLike;
  getBattery?: () => Promise<BatteryLike>;
};

/** Delays after the first immediate retry when the wake lock is taken away while visible. */
const WAKE_LOCK_RETRY_MS = [5000, 30000];

/**
 * 必須在「開始」的 click handler 內同步呼叫。失敗時 reject,並已清掉 AudioContext、wake lock 和這個 session 的所有紀錄。
 *
 * Nothing is written to IndexedDB until the microphone is running, so a failed
 * start leaves no records: events raised before that are held in memory and
 * dropped on failure.
 */
export async function startSession(opts: {
  nightId: string;
  heartbeatIntervalSec: number;
  onLiveStatus: (s: LiveStatus & { recorder: RecorderStatus | null }) => void;
}): Promise<RunningSession> {
  const nav = navigator as NavigatorExtras;
  const id = crypto.randomUUID();
  const record: SessionRecord = {
    id,
    nightId: opts.nightId,
    scenario: 'night',
    startedAt: Date.now(),
    stoppedAt: null,
    heartbeatIntervalSec: opts.heartbeatIntervalSec,
    userAgent: navigator.userAgent,
    ctxSampleRate: null,
    ctxBaseLatency: null,
    trackSettings: null,
    storagePersisted: null,
  };

  // ---------- persistence: one serialized writer ----------
  let dbReady = false;
  let stopping = false;
  const pendingEvents: MonitorEvent[] = [];
  const pendingHeartbeats: HeartbeatRecord[] = [];
  let chain: Promise<void> = Promise.resolve();

  const flush = (): Promise<void> => {
    chain = chain.then(async () => {
      if (!dbReady) return;
      const hbs = pendingHeartbeats.splice(0);
      const evs = pendingEvents.splice(0);
      let hbDone = 0;
      try {
        for (const hb of hbs) {
          await addHeartbeat(hb);
          hbDone++;
        }
        if (evs.length > 0) await addEvents(evs);
      } catch (err) {
        // Keep everything unwritten for the next successful write, plus a note.
        pendingHeartbeats.unshift(...hbs.slice(hbDone));
        pendingEvents.unshift(...evs);
        pendingEvents.push({ sessionId: id, t: Date.now(), type: 'error', detail: `db write ${errText(err)}` });
      }
    });
    return chain;
  };

  let recorder: Recorder | null = null;
  let calListener: CalibrationListener | null = null;
  const calLp = new LowPass(DEFAULT_PARAMS.snoreLowCutHz, SAMPLE_RATE);
  const calHp = new HighPass(DEFAULT_PARAMS.levelHighPassHz, SAMPLE_RATE);
  const calScratch = new Float32Array(FRAME_SIZE);
  let calFrame = 0;

  const logEvent = (type: MonitorEventType, detail: string) => {
    pendingEvents.push({ sessionId: id, t: Date.now(), type, detail });
    void flush();
    if (recorder && !stopping && (GAP_EVENTS.has(type) || (type === 'ctx-state' && detail !== 'running'))) {
      recorder.onGap(type);
    }
    onStateEvent(type);
  };

  const onStats = (s: WorkletStats) => {
    acc.add(s);
    if (stopping || !s.pcm) return;
    if (recorder) {
      recorder.onPcm(s.pcm, s.ctxTime, Date.now());
    } else if (calListener) {
      for (let off = 0; off + FRAME_SIZE <= s.pcm.length; off += FRAME_SIZE) {
        // The listener may clear itself mid-batch when a calibration step ends.
        const fn = calListener;
        if (!fn) break;
        const f = computeFeatures(s.pcm, off, calFrame++, calLp, calHp, calScratch);
        fn(f.q, f.zero);
      }
    }
  };

  // ---------- audio, wake lock, stats ----------
  const acc = new StatsAccumulator();
  let needsGesture = false;
  let recovering = false;
  let wakeRetryIndex = 0;
  let wakeRetryTimer: ReturnType<typeof setTimeout> | undefined;

  // Start order matters (iOS user activation): all three calls happen before any await.
  const capture = new AudioCapture(onStats, (type, detail) => logEvent(type, detail));
  const wakeLock = new ScreenWakeLock((type, detail) => logEvent(type, detail));
  const wakePromise = wakeLock.request();
  const capturePromise = capture.start();

  const isVisible = () => document.visibilityState === 'visible';

  async function runRecovery(reason: string): Promise<boolean> {
    if (recovering || stopping) return false;
    recovering = true;
    try {
      logEvent('recovery-attempt', reason);
      const failed: string[] = [];
      if (wakeLock.status !== 'held' && wakeLock.status !== 'unsupported') {
        await wakeLock.request();
        if ((wakeLock.status as WakeLockStatus) !== 'held') failed.push('wakelock');
      }
      if (capture.ctxState !== 'running' && !(await capture.resumeContext())) failed.push('ctx');
      const track = capture.track;
      if ((!track || track.readyState === 'ended') && !(await capture.restartTrack())) failed.push('track');
      if (stopping) return false;
      if (failed.length === 0) {
        logEvent('recovery-success', reason);
        needsGesture = false;
        wakeRetryIndex = 0;
        return true;
      }
      logEvent('recovery-failed', failed.join(','));
      if (!needsGesture) {
        needsGesture = true;
        logEvent('needs-gesture', failed.join(','));
      }
      return false;
    } finally {
      recovering = false;
    }
  }

  function onWakeLockReleased(): void {
    if (stopping || !isVisible()) return;
    // First retry immediately, then after 5 s and 30 s; after that wait for the next trigger.
    void runRecovery('wakelock-released').then(() => scheduleWakeRetry());
  }

  function scheduleWakeRetry(): void {
    if (stopping || wakeLock.status === 'held' || wakeLock.status === 'unsupported') {
      wakeRetryIndex = 0;
      return;
    }
    const delay = WAKE_LOCK_RETRY_MS[wakeRetryIndex];
    if (delay === undefined) return;
    wakeRetryIndex++;
    clearTimeout(wakeRetryTimer);
    wakeRetryTimer = setTimeout(() => {
      if (!isVisible()) return;
      void runRecovery('wakelock-retry').then(() => scheduleWakeRetry());
    }, delay);
  }

  /** Reacts to state events that should start a recovery. */
  function onStateEvent(type: MonitorEventType): void {
    if (stopping || !dbReady) return;
    if (type === 'wakelock-released') onWakeLockReleased();
    else if (type === 'ctx-state' && capture.ctxState !== 'running') void runRecovery(`ctx-${capture.ctxState}`);
    else if (type === 'track-ended') void runRecovery('track-ended');
  }

  // ---------- wait for the microphone ----------
  try {
    await Promise.all([capturePromise, wakePromise]);
  } catch (err) {
    stopping = true;
    await capture.stop();
    await wakeLock.release();
    pendingEvents.length = 0;
    throw err;
  }

  // ---------- running ----------
  dbReady = true;
  const startedPerf = performance.now();
  await putSession(record);
  logEvent('start', 'night');
  // Optional motion recording (M5); returns null on the nightstand and never throws.
  const motion = startMotion(id);

  try {
    const persisted = navigator.storage?.persist ? await navigator.storage.persist() : null;
    record.storagePersisted = persisted;
  } catch {
    record.storagePersisted = null;
  }
  record.ctxSampleRate = capture.sampleRate;
  record.ctxBaseLatency = capture.baseLatency;
  record.trackSettings = trackSettingsOf(capture.track);
  await putSession(record);

  let battery: BatteryLike | null = null;
  if (typeof nav.getBattery === 'function') {
    nav.getBattery().then((b) => { battery = b; }, () => {});
  }

  let seq = 0;
  const makeHeartbeat = (): HeartbeatRecord => {
    const p = acc.take();
    const track = capture.track;
    return {
      sessionId: id,
      seq: seq++,
      t: Date.now(),
      perfNow: performance.now(),
      frames: p.frames,
      zeroFrames: p.zeroFrames,
      noInputQuanta: p.noInputQuanta,
      minDb: p.minDb,
      meanDb: p.meanDb,
      maxDb: p.maxDb,
      ctxState: capture.ctxState,
      ctxTime: capture.ctxTime,
      wakeLock: wakeLock.status,
      visibility: document.visibilityState,
      trackReadyState: track ? track.readyState : 'none',
      trackMuted: track ? track.muted : null,
      audioSessionState: nav.audioSession?.state ?? null,
      battery: battery ? { level: battery.level, charging: battery.charging } : null,
      floorDb: recorder ? recorder.status().snapshot.floorDb : null,
      soundEventCount: recorder ? recorder.status().soundEventCount : 0,
    };
  };

  const stopTicker = startTicker(
    opts.heartbeatIntervalSec,
    () => {
      pendingHeartbeats.push(makeHeartbeat());
      void flush();
    },
    (gapMs) => logEvent('timer-gap', String(gapMs)),
  );

  const liveTimer = setInterval(() => {
    opts.onLiveStatus({
      elapsedMs: performance.now() - startedPerf,
      lastFrames: acc.lastFrames,
      lastDb: acc.latestDb,
      ctxState: capture.ctxState,
      wakeLock: wakeLock.status,
      needsGesture,
      recorder: recorder ? recorder.status() : null,
    });
  }, 1000);

  // ---------- page lifecycle ----------
  const listeners: Array<[EventTarget, string, EventListener]> = [];
  const on = (target: EventTarget, name: string, fn: EventListener) => {
    target.addEventListener(name, fn);
    listeners.push([target, name, fn]);
  };
  on(document, 'visibilitychange', () => {
    logEvent('visibility', document.visibilityState);
    if (isVisible()) void runRecovery('visible').then(() => scheduleWakeRetry());
  });
  on(window, 'pagehide', (e) => logEvent('pagehide', `persisted=${(e as PageTransitionEvent).persisted}`));
  on(window, 'pageshow', (e) => logEvent('pageshow', `persisted=${(e as PageTransitionEvent).persisted}`));
  if ('onfreeze' in document) on(document, 'freeze', () => logEvent('freeze', ''));
  if ('onresume' in document) on(document, 'resume', () => logEvent('resume', ''));
  const audioSession = nav.audioSession;
  if (audioSession && typeof audioSession.addEventListener === 'function') {
    on(audioSession, 'statechange', () => logEvent('audiosession-state', String(audioSession.state)));
  }

  // The start-up phase may already have seen a release or a non-running context.
  if (capture.ctxState !== 'running') void runRecovery(`ctx-${capture.ctxState}`);

  return {
    id,
    nightId: opts.nightId,
    setCalibrationListener(fn: CalibrationListener | null): void {
      calListener = fn;
    },
    async beginDetection(night: NightRecord, seedFloor: Uint8Array | null): Promise<void> {
      if (recorder || stopping) return;
      calListener = null;
      // Counts from earlier sessions of a resumed night.
      const prior = await getNightData(night.id).catch(() => null);
      const priorEventCount = prior ? prior.soundEvents.filter((e) => e.continuesFrom === null).length : 0;
      const priorSnoreCount = prior ? prior.snoreEpisodes.length : 0;
      if (stopping) return;
      recorder = new Recorder(night, id, night.params, {
        onError: (detail) => logEvent('error', detail),
        priorEventCount,
        priorSnoreCount,
        seedFloor,
      });
    },
    recoverFromGesture(): void {
      // Inside the tap: start both before any await so user activation applies.
      void capture.resumeContext();
      void wakeLock.request();
      void runRecovery('gesture').then((ok) => {
        if (ok) needsGesture = false;
      });
    },
    async stop(night?: NightRecord | null): Promise<SessionRecord> {
      stopping = true;
      calListener = null;
      if (recorder) {
        try {
          await recorder.finish();
        } catch (err) {
          pendingEvents.push({ sessionId: id, t: Date.now(), type: 'error', detail: `recorder finish ${errText(err)}` });
        }
      }
      stopTicker();
      clearInterval(liveTimer);
      clearTimeout(wakeRetryTimer);
      for (const [target, name, fn] of listeners) target.removeEventListener(name, fn);
      pendingHeartbeats.push(makeHeartbeat());
      logEvent('stop', '');
      await motion?.stop();
      await capture.stop();
      await wakeLock.release();
      record.stoppedAt = Date.now();
      await flush();
      await putSession(record);
      if (night) {
        night.status = 'stopped';
        night.stoppedAt = record.stoppedAt;
        await putNight({ ...night });
      }
      return { ...record };
    },
  };
}

function trackSettingsOf(track: MediaStreamTrack | null): Record<string, string | number | boolean> | null {
  if (!track || typeof track.getSettings !== 'function') return null;
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(track.getSettings())) {
    if (key === 'deviceId' || key === 'groupId') continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') out[key] = value;
  }
  return out;
}
