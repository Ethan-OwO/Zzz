import { AudioCapture, errText } from '../audio/capture';
import { addEvents, addHeartbeat, putSession } from '../storage/db';
import { StatsAccumulator, startTicker } from './heartbeat';
import type {
  CtxState, HeartbeatRecord, MonitorEvent, MonitorEventType, SessionRecord, WakeLockStatus,
} from './types';
import { ScreenWakeLock } from './wake-lock';

export interface LiveStatus {
  elapsedMs: number; lastFrames: number; lastDb: number | null;
  ctxState: CtxState; wakeLock: WakeLockStatus; needsGesture: boolean;
}

export interface RunningSession {
  readonly id: string;
  /** 只在使用者點擊恢復浮層時呼叫(在 gesture 內)。 */
  recoverFromGesture(): void;
  stop(): Promise<SessionRecord>;
}

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
  scenario: string;
  heartbeatIntervalSec: number;
  onLiveStatus: (s: LiveStatus) => void;
}): Promise<RunningSession> {
  const nav = navigator as NavigatorExtras;
  const id = crypto.randomUUID();
  const record: SessionRecord = {
    id,
    scenario: opts.scenario,
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

  const logEvent = (type: MonitorEventType, detail: string) => {
    pendingEvents.push({ sessionId: id, t: Date.now(), type, detail });
    void flush();
    onStateEvent(type);
  };

  // ---------- audio, wake lock, stats ----------
  const acc = new StatsAccumulator();
  let needsGesture = false;
  let recovering = false;
  let wakeRetryIndex = 0;
  let wakeRetryTimer: ReturnType<typeof setTimeout> | undefined;

  // Start order matters (iOS user activation): all three calls happen before any await.
  const capture = new AudioCapture((s) => acc.add(s), (type, detail) => logEvent(type, detail));
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
  logEvent('start', opts.scenario);

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
    recoverFromGesture(): void {
      // Inside the tap: start both before any await so user activation applies.
      void capture.resumeContext();
      void wakeLock.request();
      void runRecovery('gesture').then((ok) => {
        if (ok) needsGesture = false;
      });
    },
    async stop(): Promise<SessionRecord> {
      stopping = true;
      stopTicker();
      clearInterval(liveTimer);
      clearTimeout(wakeRetryTimer);
      for (const [target, name, fn] of listeners) target.removeEventListener(name, fn);
      pendingHeartbeats.push(makeHeartbeat());
      logEvent('stop', '');
      await capture.stop();
      await wakeLock.release();
      record.stoppedAt = Date.now();
      await flush();
      await putSession(record);
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
