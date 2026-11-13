import { EpochAccumulator, decideQuality } from './actigraphy.ts';
import { putEpochs, putMotionSession } from './motion-db.ts';
import type { MotionParams } from './params.ts';
import type { MotionEpoch, MotionLiveStatus, MotionPermission, MotionSessionRecord, Placement } from './types.ts';

export interface MotionHandle {
  readonly live: MotionLiveStatus;
  stop(): Promise<void>;
}

function warn(err: unknown): void {
  console.warn('[zzz-motion]', err);
}

/**
 * Listens to devicemotion for one session and writes one record per epoch.
 * Returns null unless placement is 'bed'. Never throws into the caller: motion
 * is optional and must not disturb the audio pipeline.
 */
export function startMotionRecorder(
  sessionId: string, placement: Placement, permission: MotionPermission, params: MotionParams,
): MotionHandle | null {
  if (placement !== 'bed') return null;
  try {
    return start(sessionId, permission, params);
  } catch (err) {
    warn(err);
    return null;
  }
}

function start(sessionId: string, permission: MotionPermission, params: MotionParams): MotionHandle {
  const startPerf = performance.now();
  const record: MotionSessionRecord = {
    sessionId,
    placement: 'bed',
    permission,
    startedAt: Date.now(),
    stoppedAt: null,
    reportedIntervalMs: null,
    hasAcceleration: null,
    firstEventDelayMs: null,
    quality: null,
    paramsVersion: 1,
    params: { ...params },
  };
  const acc = new EpochAccumulator(sessionId, record.startedAt, startPerf, params);
  const live: MotionLiveStatus = { rateHz: null, lastActiveSec: null, epochs: 0 };
  const all: MotionEpoch[] = [];

  // ---------- one serialized writer ----------
  const queue: MotionEpoch[] = [];
  let chain: Promise<void> = putMotionSession(record).catch(warn);
  let firstMetaSaved = false;
  const flush = (): Promise<void> => {
    chain = chain.then(async () => {
      const batch = queue.splice(0);
      if (batch.length === 0) return;
      try {
        await putEpochs(batch);
      } catch (err) {
        queue.unshift(...batch); // retried with the next batch
        warn(err);
      }
    });
    return chain;
  };
  const saveMeta = () => {
    chain = chain.then(() => putMotionSession(record)).catch(warn);
  };
  const closed = (list: MotionEpoch[]) => {
    if (list.length === 0) return;
    for (const e of list) {
      all.push(e);
      live.epochs++;
      live.rateHz = e.rateHz;
      live.lastActiveSec = e.activeSec;
    }
    queue.push(...list);
    void flush();
  };

  // ---------- listeners ----------
  const onMotion = (ev: Event) => {
    const e = ev as DeviceMotionEvent;
    const a = e.accelerationIncludingGravity;
    if (!a || a.x === null || a.y === null || a.z === null) return;
    if (!firstMetaSaved) {
      firstMetaSaved = true;
      record.reportedIntervalMs = Number.isFinite(e.interval) ? e.interval : null;
      record.hasAcceleration = e.acceleration !== null && e.acceleration.x !== null;
      record.firstEventDelayMs = Math.round(performance.now() - startPerf);
      saveMeta();
    }
    closed(acc.addSample(a.x, a.y, a.z, e.timeStamp));
  };
  const onVisibility = () => acc.setHidden(document.visibilityState === 'hidden', performance.now());

  window.addEventListener('devicemotion', onMotion, { passive: true });
  document.addEventListener('visibilitychange', onVisibility);
  if (document.visibilityState === 'hidden') acc.setHidden(true, startPerf);
  // Timers keep running while the screen is locked (M2 P3), so empty epochs still close.
  const timer = setInterval(() => closed(acc.tick(performance.now())), 1000);

  let stopped = false;
  return {
    live,
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      try {
        clearInterval(timer);
        window.removeEventListener('devicemotion', onMotion);
        document.removeEventListener('visibilitychange', onVisibility);
        closed(acc.finish(performance.now()));
        await flush();
        record.stoppedAt = Date.now();
        record.quality = decideQuality(all, params);
        saveMeta();
        await chain;
      } catch (err) {
        warn(err);
      }
    },
  };
}
