// Pure actigraphy: accelerometer samples → fixed-length epochs. No DOM.
import type { MotionParams } from './params.ts';
import type { MotionEpoch, MotionQuality } from './types.ts';

const RAD_TO_DEG = 180 / Math.PI;

/**
 * Turns raw accelerationIncludingGravity samples into epochs.
 *
 * d = |‖a‖ − EMA(‖a‖)|: the magnitude makes it orientation-independent, and
 * subtracting a ~1 s low-pass removes gravity (the DC part) and slow drift,
 * which is a first-order high-pass. Epoch boundaries come from a fixed grid
 * (startPerf + idx × epochSec), so late events never shift the grid.
 */
export class EpochAccumulator {
  private readonly sessionId: string;
  private readonly startWall: number;
  private readonly startPerf: number;
  private readonly p: MotionParams;
  private readonly epochMs: number;
  private readonly secMax: Float64Array;

  private idx = 0;
  private lastT: number | null = null;
  private baseline = 0;
  private hasBaseline = false;

  // current-epoch accumulators
  private samples = 0;
  private coveredSec = 0;
  private activity = 0;
  private peak = 0;
  private gx = 0;
  private gy = 0;
  private gz = 0;
  private hiddenMs = 0;
  private hiddenSince: number | null = null;

  private prevGravity: [number, number, number] | null = null;

  constructor(sessionId: string, startWall: number, startPerf: number, params: MotionParams) {
    this.sessionId = sessionId;
    this.startWall = startWall;
    this.startPerf = startPerf;
    this.p = params;
    this.epochMs = params.epochSec * 1000;
    this.secMax = new Float64Array(Math.ceil(params.epochSec));
  }

  addSample(x: number, y: number, z: number, tMs: number): MotionEpoch[] {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z) || !Number.isFinite(tMs)) return [];
    const closed = this.advanceTo(tMs);
    if (tMs < this.startPerf) return closed;
    const m = Math.sqrt(x * x + y * y + z * z);
    const last = this.lastT;
    if (last !== null) {
      const dt = tMs - last;
      if (dt < this.p.minDtMs) return closed; // duplicate or out-of-order timestamp: drop
      if (dt > this.p.maxDtMs) {
        // Interruption: restart the baseline, do not accumulate this sample.
        this.lastT = tMs;
        this.baseline = m;
        this.hasBaseline = true;
        return closed;
      }
    }
    this.lastT = tMs;
    if (!this.hasBaseline || last === null) {
      this.baseline = m;
      this.hasBaseline = true;
      this.accumulate(0, 0, x, y, z, tMs);
      return closed;
    }
    const dt = tMs - last;
    const alpha = 1 - Math.exp(-dt / (this.p.baselineTauSec * 1000));
    this.baseline += alpha * (m - this.baseline);
    const d = Math.abs(m - this.baseline);
    this.accumulate(d, dt, x, y, z, tMs);
    return closed;
  }

  tick(nowPerf: number): MotionEpoch[] {
    return this.advanceTo(nowPerf);
  }

  setHidden(hidden: boolean, nowPerf: number): void {
    if (hidden) {
      if (this.hiddenSince === null) this.hiddenSince = nowPerf;
      return;
    }
    if (this.hiddenSince !== null) {
      // Split hidden time across epochs that already closed via advanceTo.
      this.hiddenMs += Math.max(0, nowPerf - Math.max(this.hiddenSince, this.epochStartPerf()));
      this.hiddenSince = null;
    }
  }

  /** Stop: closes every remaining epoch, the last one cut short at nowPerf. */
  finish(nowPerf: number): MotionEpoch[] {
    const closed = this.advanceTo(nowPerf);
    if (nowPerf > this.epochStartPerf()) closed.push(this.close(nowPerf));
    return closed;
  }

  private epochStartPerf(): number {
    return this.startPerf + this.idx * this.epochMs;
  }

  private accumulate(d: number, dtMs: number, x: number, y: number, z: number, tMs: number): void {
    this.samples++;
    this.coveredSec += dtMs / 1000;
    this.activity += Math.max(0, d - this.p.deadbandMs2) * (dtMs / 1000);
    if (d > this.peak) this.peak = d;
    const sec = Math.min(this.secMax.length - 1, Math.max(0, Math.floor((tMs - this.epochStartPerf()) / 1000)));
    if (d > (this.secMax[sec] ?? 0)) this.secMax[sec] = d;
    this.gx += x;
    this.gy += y;
    this.gz += z;
  }

  /** Closes every epoch whose end is ≤ tMs. */
  private advanceTo(tMs: number): MotionEpoch[] {
    const out: MotionEpoch[] = [];
    while (tMs >= this.epochStartPerf() + this.epochMs) {
      out.push(this.close(this.epochStartPerf() + this.epochMs));
    }
    return out;
  }

  private close(endPerf: number): MotionEpoch {
    const startPerf = this.epochStartPerf();
    let hiddenMs = this.hiddenMs;
    if (this.hiddenSince !== null) {
      hiddenMs += Math.max(0, endPerf - Math.max(this.hiddenSince, startPerf));
    }
    let activeSec = 0;
    for (let i = 0; i < this.secMax.length; i++) {
      if ((this.secMax[i] ?? 0) > this.p.moveThresholdMs2) activeSec++;
    }
    let tiltDeg: number | null = null;
    if (this.samples > 0) {
      const g: [number, number, number] = [this.gx / this.samples, this.gy / this.samples, this.gz / this.samples];
      if (this.prevGravity) tiltDeg = angleDeg(this.prevGravity, g);
      this.prevGravity = g;
    }
    const epoch: MotionEpoch = {
      sessionId: this.sessionId,
      idx: this.idx,
      startAt: this.startWall + (startPerf - this.startPerf),
      endAt: this.startWall + (endPerf - this.startPerf),
      samples: this.samples,
      rateHz: this.samples > 0 ? this.samples / Math.max(this.coveredSec, 1e-3) : 0,
      activity: this.activity,
      peak: this.peak,
      activeSec,
      tiltDeg,
      hiddenMs: Math.round(hiddenMs),
    };
    this.idx++;
    this.samples = 0;
    this.coveredSec = 0;
    this.activity = 0;
    this.peak = 0;
    this.gx = this.gy = this.gz = 0;
    this.hiddenMs = 0;
    this.secMax.fill(0);
    return epoch;
  }
}

function angleDeg(a: [number, number, number], b: [number, number, number]): number {
  const na = Math.hypot(a[0], a[1], a[2]);
  const nb = Math.hypot(b[0], b[1], b[2]);
  if (na === 0 || nb === 0) return 0;
  const cos = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (na * nb);
  return Math.acos(Math.min(1, Math.max(-1, cos))) * RAD_TO_DEG;
}

/**
 * Roadmap M5 decision rule: median rate of non-empty epochs below minRateHz, or
 * more empty epochs than maxGapEpochRatio allows → 'binary'. No samples → 'none'.
 * The last epoch is excluded from the gap count (it is cut short at stop).
 */
export function decideQuality(epochs: MotionEpoch[], params: MotionParams): MotionQuality {
  const filled = epochs.filter((e) => e.samples > 0);
  if (filled.length === 0) return 'none';
  const rates = filled.map((e) => e.rateHz).sort((a, b) => a - b);
  const mid = rates.length >> 1;
  const median = rates.length % 2 === 1 ? (rates[mid] ?? 0) : ((rates[mid - 1] ?? 0) + (rates[mid] ?? 0)) / 2;
  if (median < params.minRateHz) return 'binary';
  const sorted = [...epochs].sort((a, b) => a.idx - b.idx);
  const counted = sorted.slice(0, -1);
  const gaps = counted.filter((e) => e.samples === 0).length;
  if (counted.length > 0 && gaps / counted.length > params.maxGapEpochRatio) return 'binary';
  return 'full';
}

/** Binary judgement: at least one moving second. The only signal M6 uses when quality is 'binary'. */
export function isMoved(e: MotionEpoch): boolean {
  return e.activeSec >= 1;
}
