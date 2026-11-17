// 以下全是起始值，預計依真實夜晚調校。調整規則見 design_M3 §7.5。
// No runtime imports: scripts/unit.mjs loads src/detect/* directly through
// Node's TypeScript type stripping.

export const SAMPLE_RATE = 16000;
export const FRAME_SIZE = 512; // must equal FRAME_SIZE in src/audio/features.ts
export const FRAME_SEC = FRAME_SIZE / SAMPLE_RATE; // 0.032

export interface DetectParams {
  floorWindowSec: number;      // sliding window of the noise floor
  floorPercentile: number;     // which percentile of that window is the floor
  floorMinSec: number;         // the floor must hold this much audio before anything triggers
  triggerMarginDb: number;     // trigger = floor + this (overwritten by the pre-sleep calibration)
  releaseGapDb: number;        // release threshold = trigger threshold - this
  triggerWindowFrames: number; // look at the last N frames (10 = 320 ms)
  triggerMinFrames: number;    // ...and trigger when at least this many are >= the trigger threshold
  releaseSec: number;          // this long below release -> the event body ends
  preRollSec: number;
  postRollSec: number;
  maxEventSec: number;         // longer events are split (seamlessly continued)
  burstEndSec: number;         // one "burst" (single snore) ends after this long below release
  snoreLowCutHz: number;       // cutoff of the low-band energy ratio
  snoreMinLowRatio: number;    // a snore-like burst has at least this low-band ratio
  snoreMinBurstSec: number;
  snoreMaxBurstSec: number;
  snoreMinIntervalSec: number; // start-to-start interval range between two snores
  snoreMaxIntervalSec: number;
  snoreIntervalTolerance: number; // max relative error of each interval vs their median
  snoreConfirmBursts: number;  // this many matching bursts in a row confirm a snore episode
  snoreEndSec: number;         // no matching burst for this long -> the episode ends
  audioBudgetSec: number;      // max seconds of audio stored per night (~230 MB)
  testMarginOffsetDb: number;  // test mode: trigger margin is lowered by this much (clamped to 6 dB)
  levelHighPassHz: number;     // the level compared with the thresholds is high-passed here first (0 = off)
  floorShiftSec: number;       // an event this long whose quietest 20% stays above release = new background
  minAboveSec: number;         // an event whose frames above trigger add up to less than this is discarded
  motionVetoActiveSec: number; // this many moving seconds in the current or last motion epoch block snore confirmation (0 = off)
}

// Background in a quiet iPhone bedroom measured about -66..-70 dBFS in M2;
// the calibration measures it every night, so these defaults do not depend on it.
export const DEFAULT_PARAMS: DetectParams = Object.freeze({
  floorWindowSec: 300,
  floorPercentile: 20,
  floorMinSec: 30,
  triggerMarginDb: 10,
  releaseGapDb: 4,
  triggerWindowFrames: 10,
  triggerMinFrames: 8,
  releaseSec: 2,
  preRollSec: 5,
  postRollSec: 3,
  maxEventSec: 60,
  // N2 (2026-11-17): 0.32 s cut one 13 s turn-over rustle into 4 "snores". Real snores are
  // separated by a quiet exhale of 1.5 s or more, so a shorter dip belongs to the same sound.
  burstEndSec: 0.8,
  snoreLowCutHz: 500,
  snoreMinLowRatio: 0.55,
  snoreMinBurstSec: 0.3,
  snoreMaxBurstSec: 3.0,
  snoreMinIntervalSec: 2.0,
  snoreMaxIntervalSec: 8.0,
  snoreIntervalTolerance: 0.4,
  snoreConfirmBursts: 4,
  snoreEndSec: 15,
  audioBudgetSec: 7200,
  // N1 (2026-11-14): 3 dB made test nights record a ~90 Hz hum barely above the trigger.
  testMarginOffsetDb: 1,
  // N1: a steady ~90 Hz hum (AC / fan) triggered most events; 4th-order 150 Hz cut it by ~18 dB.
  // N2: with the phone on the bed, 14 of 27 events were thumps below ~200 Hz that 150 Hz barely
  // touches (-8 dB at 120 Hz). 300 Hz takes ~24 dB off 150 Hz and ~32 dB off 120 Hz; speech is
  // untouched and snores keep their harmonics.
  levelHighPassHz: 300,
  // N1: a background step took the 300 s p20 floor ~4 min to absorb; rebase after 30 s instead.
  floorShiftSec: 30,
  // N2: 6 of 27 events were 0.3–0.6 s knocks.
  minAboveSec: 0.5,
  // N2: the turn-over had 20 moving seconds in its epoch; other small movements had 1–7.
  motionVetoActiveSec: 3,
});

/** 把秒數換成幀數，四捨五入，至少 1。 */
export function secToFrames(sec: number): number {
  return Math.max(1, Math.round(sec / FRAME_SEC));
}
