// Pre-sleep calibration: quiet phase + one spoken sentence -> trigger margin.
import { dequantizeDb, percentileQ } from './levels.ts';
import type { DetectParams } from './params.ts';

export interface CalibrationResult {
  floorDb: number;        // 安靜階段的第 20 百分位
  quietSpreadDb: number;  // 安靜階段第 95 百分位 - floorDb(背景起伏)
  speechDb: number | null;// 說話階段的第 90 百分位;沒偵測到說話為 null
  triggerMarginDb: number;
  releaseMarginDb: number;
  status: 'ok' | 'no-speech' | 'too-noisy';
}

export const MIN_MARGIN_DB = 6;
export const MAX_MARGIN_DB = 20;

function clampMargin(db: number): number {
  return Math.min(MAX_MARGIN_DB, Math.max(MIN_MARGIN_DB, db));
}

function releaseOf(margin: number, p: DetectParams): number {
  return Math.max(3, margin - p.releaseGapDb);
}

/** quietQ、speechQ 為兩個階段各自的量化 dB 序列(已排除 zero 幀)。 */
export function computeCalibration(quietQ: Uint8Array, speechQ: Uint8Array, p: DetectParams): CalibrationResult {
  const fq = percentileQ(quietQ, 20);
  const floorDb = fq === null ? -120 : dequantizeDb(fq);
  const q95 = percentileQ(quietQ, 95);
  const quietSpreadDb = q95 === null ? 0 : dequantizeDb(q95) - floorDb;
  const sq = percentileQ(speechQ, 90);
  const speech = sq === null ? null : dequantizeDb(sq);

  if (speech === null || speech - floorDb < 8) {
    const margin = p.triggerMarginDb;
    return {
      floorDb, quietSpreadDb, speechDb: null,
      triggerMarginDb: margin, releaseMarginDb: releaseOf(margin, p), status: 'no-speech',
    };
  }
  const gap = speech - floorDb;
  const mid = gap / 2;
  const margin = Math.round(clampMargin(Math.max(mid, quietSpreadDb + 2)) * 2) / 2;
  // ">=": when the spread band touches the speech band they can no longer be told apart.
  const tooNoisy = quietSpreadDb + 2 >= gap - 2;
  return {
    floorDb, quietSpreadDb, speechDb: speech,
    triggerMarginDb: margin, releaseMarginDb: releaseOf(margin, p),
    status: tooNoisy ? 'too-noisy' : 'ok',
  };
}

/** 使用者按 − / + 微調後重新算 release;margin 夾在 6..20,步長 1 dB。 */
export function adjustMargin(r: CalibrationResult, deltaDb: number, p: DetectParams): CalibrationResult {
  const margin = clampMargin(r.triggerMarginDb + deltaDb);
  return { ...r, triggerMarginDb: margin, releaseMarginDb: releaseOf(margin, p) };
}
