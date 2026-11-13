// 🎛 Starting values; retune from real nights (design_M5 §7.5).
export interface MotionParams {
  /** Epoch (actigraphy bin) length in seconds. */
  epochSec: number;
  /** Time constant of the gravity baseline EMA, in seconds. */
  baselineTauSec: number;
  /** Deviations below this (m/s²) are treated as sensor noise. */
  deadbandMs2: number;
  /** A second counts as "moving" when its max deviation exceeds this (m/s²). */
  moveThresholdMs2: number;
  /** Samples closer than this (ms) to the previous one are dropped. */
  minDtMs: number;
  /** A gap longer than this (ms) is an interruption: the baseline is reset. */
  maxDtMs: number;
  /** Decision rule: below this median rate only the binary moved/not-moved is trusted. */
  minRateHz: number;
  /** Decision rule: a larger share of empty epochs downgrades quality to binary. */
  maxGapEpochRatio: number;
}

export const DEFAULT_MOTION_PARAMS: MotionParams = {
  epochSec: 30,
  baselineTauSec: 1.0,
  deadbandMs2: 0.02,
  moveThresholdMs2: 0.1,
  minDtMs: 5,
  maxDtMs: 200,
  minRateHz: 10,
  maxGapEpochRatio: 0,
};
