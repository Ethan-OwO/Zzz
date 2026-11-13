import { msToDb } from '../audio/features';
import type { WorkletStats } from './types';

export interface PeriodStats {
  frames: number;
  zeroFrames: number;
  noInputQuanta: number;
  minDb: number | null;
  meanDb: number | null;
  maxDb: number | null;
  lastDb: number | null;
}

/** 累加 worklet 傳來的 WorkletStats,take() 取出本期統計並歸零。 */
export class StatsAccumulator {
  private frames = 0;
  private zeroFrames = 0;
  private noInputQuanta = 0;
  private minMs: number | null = null;
  private maxMs: number | null = null;
  private sumMs = 0;
  private lastDb: number | null = null;
  /** Frames of the most recent WorkletStats (≈ frames in the last second). */
  lastFrames = 0;

  add(s: WorkletStats): void {
    this.frames += s.frames;
    this.zeroFrames += s.zeroFrames;
    this.noInputQuanta += s.noInputQuanta;
    this.sumMs += s.sumMs;
    if (s.minMs !== null) this.minMs = this.minMs === null ? s.minMs : Math.min(this.minMs, s.minMs);
    if (s.maxMs !== null) this.maxMs = this.maxMs === null ? s.maxMs : Math.max(this.maxMs, s.maxMs);
    this.lastFrames = s.frames;
    this.lastDb = s.frames > 0 ? msToDb(s.sumMs / s.frames) : null;
  }

  take(): PeriodStats {
    const out: PeriodStats = {
      frames: this.frames,
      zeroFrames: this.zeroFrames,
      noInputQuanta: this.noInputQuanta,
      minDb: this.frames > 0 && this.minMs !== null ? msToDb(this.minMs) : null,
      meanDb: this.frames > 0 ? msToDb(this.sumMs / this.frames) : null,
      maxDb: this.frames > 0 && this.maxMs !== null ? msToDb(this.maxMs) : null,
      lastDb: this.lastDb,
    };
    this.frames = 0;
    this.zeroFrames = 0;
    this.noInputQuanta = 0;
    this.minMs = null;
    this.maxMs = null;
    this.sumMs = 0;
    return out;
  }

  /** Latest per-second volume, for the live overlay. */
  get latestDb(): number | null {
    return this.lastDb;
  }
}

/** 每 intervalSec 呼叫一次 onTick。實際間隔 > 1.5 × intervalSec 時，先呼叫 onGap(實際間隔毫秒)。回傳停止函式。 */
export function startTicker(intervalSec: number, onTick: () => void, onGap: (gapMs: number) => void): () => void {
  const intervalMs = intervalSec * 1000;
  let last = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const schedule = () => {
    // Aim at last + interval so small delays do not accumulate drift.
    const delay = Math.max(0, last + intervalMs - Date.now());
    timer = setTimeout(fire, delay);
  };
  const fire = () => {
    if (stopped) return;
    const now = Date.now();
    const actual = now - last;
    last = now;
    // A long gap means JavaScript was frozen (or the timer was throttled).
    if (actual > 1.5 * intervalMs) onGap(actual);
    onTick();
    schedule();
  };
  schedule();
  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}
