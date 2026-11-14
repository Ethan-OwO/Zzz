// Rule-based classifier: EventFeatures → snore / talk / other (§5.4). Pure function of
// features + params, so scripts/eval-labels.mjs can re-run it on exported JSON.
import { FEATURES_VERSION, type EventFeatures } from './event-features.ts';

export type SoundClass = 'snore' | 'talk' | 'other';

export interface ClassifyParams {
  version: number; // 規則版本;改了任何數值就 +1
  minActiveSec: number; // active 不足 → other
  // 說話
  talkSpeechRatio: [number, number]; // 線性 0→1 的區間
  talkMod: [number, number];
  talkVoiced: [number, number];
  talkF0Iqr: [number, number]; // 半音
  talkFlatnessPenalty: [number, number]; // 平坦度越高越扣(寬頻雜訊不是說話)
  talkWeights: [number, number, number, number]; // speechRatio / mod / voiced / f0Iqr
  // 打呼
  snoreLowRatio: [number, number];
  snoreBurstSec: [number, number]; // 中位一聲長度要在此範圍內，否則低頻項為 0
  snoreInterval: [number, number]; // 中位間隔範圍
  snoreIntervalCvMax: number;
  snoreModMax: number; // 調變比高於此值，打呼分數乘 (1 − 說話調變分數)
  snoreWeights: [number, number, number]; // lowRatio / 節律 / 低調變
  // 決策
  minScore: number; // 最高分低於此 → other
  minMargin: number; // 最高分與次高分差距低於此 → other
  // 正式模式
  dropMinConfidence: number; // 正式模式下，信心 ≥ 這個值的打呼事件才刪音訊
}

/** 🎛 Starting values; T3 tunes them from user labels. */
export const DEFAULT_CLASSIFY_PARAMS: ClassifyParams = {
  version: 1,
  minActiveSec: 0.3,
  talkSpeechRatio: [0.45, 0.7],
  talkMod: [0.25, 0.45],
  talkVoiced: [0.15, 0.45],
  talkF0Iqr: [1.0, 3.0],
  talkFlatnessPenalty: [0.35, 0.6],
  talkWeights: [0.3, 0.3, 0.2, 0.2],
  snoreLowRatio: [0.45, 0.7],
  snoreBurstSec: [0.3, 3.0],
  snoreInterval: [2.0, 8.0],
  snoreIntervalCvMax: 0.4,
  snoreModMax: 0.3,
  snoreWeights: [0.45, 0.35, 0.2],
  minScore: 0.6,
  minMargin: 0.15,
  dropMinConfidence: 0.8,
};

export interface Classification {
  cls: SoundClass;
  confidence: number; // 0..1
  talkScore: number; // 0..1
  snoreScore: number; // 0..1
  reason: string; // 'low-active' | 'talk' | 'snore' | 'below-min-score' | 'ambiguous' | 'no-features'
  classifierVersion: string; // `${features.version}.${params.version}`
}

/** 線性斜坡:x ≤ a → 0,x ≥ b → 1,中間線性。null → 0。 */
export function ramp(x: number | null, a: number, b: number): number {
  if (x === null || Number.isNaN(x)) return 0;
  if (x <= a) return 0;
  if (x >= b) return 1;
  return (x - a) / (b - a);
}

function inRange(x: number | null, [a, b]: [number, number]): boolean {
  return x !== null && x >= a && x <= b;
}

/** Talk score before and after the broadband-noise penalty. */
export function talkScoreOf(f: EventFeatures, p: ClassifyParams): number {
  const [w1, w2, w3, w4] = p.talkWeights;
  const raw =
    w1 * ramp(f.speechRatio, ...p.talkSpeechRatio) +
    w2 * ramp(f.syllabicModRatio, ...p.talkMod) +
    w3 * ramp(f.voicedFraction, ...p.talkVoiced) +
    w4 * ramp(f.f0IqrSemitones, ...p.talkF0Iqr);
  return raw * (1 - ramp(f.flatnessMedian, ...p.talkFlatnessPenalty));
}

export function snoreScoreOf(f: EventFeatures, p: ClassifyParams): number {
  const [w1, w2, w3] = p.snoreWeights;
  const sLow = inRange(f.burstMedianSec, p.snoreBurstSec) ? ramp(f.lowRatio, ...p.snoreLowRatio) : 0;
  const intervalOk = inRange(f.burstIntervalMedianSec, p.snoreInterval);
  let sRhythm = 0;
  if (f.burstCount >= 3 && intervalOk && f.burstIntervalCv !== null && f.burstIntervalCv <= p.snoreIntervalCvMax) {
    sRhythm = 1;
  } else if (f.burstCount === 2 && intervalOk) {
    sRhythm = 0.5;
  }
  const modTalk = ramp(f.syllabicModRatio, ...p.talkMod);
  const sMod = f.syllabicModRatio === null ? 0.5 : 1 - modTalk;
  let s = w1 * sLow + w2 * sRhythm + w3 * sMod;
  if (f.syllabicModRatio !== null && f.syllabicModRatio > p.snoreModMax) s *= 1 - modTalk;
  return s;
}

/** 純函式：只依特徵與參數分類。features 為 null → other, reason 'no-features'。 */
export function classify(features: EventFeatures | null, p: ClassifyParams): Classification {
  const classifierVersion = `${features?.version ?? FEATURES_VERSION}.${p.version}`;
  if (features === null) {
    return { cls: 'other', confidence: 1, talkScore: 0, snoreScore: 0, reason: 'no-features', classifierVersion };
  }
  if (features.activeSec < p.minActiveSec) {
    return { cls: 'other', confidence: 1, talkScore: 0, snoreScore: 0, reason: 'low-active', classifierVersion };
  }
  const talkScore = talkScoreOf(features, p);
  const snoreScore = snoreScoreOf(features, p);
  const best = Math.max(talkScore, snoreScore);
  const base = { talkScore, snoreScore, classifierVersion };
  if (best < p.minScore) return { ...base, cls: 'other', confidence: 1 - best, reason: 'below-min-score' };
  if (Math.abs(talkScore - snoreScore) < p.minMargin) {
    return { ...base, cls: 'other', confidence: 1 - best, reason: 'ambiguous' };
  }
  return talkScore > snoreScore
    ? { ...base, cls: 'talk', confidence: talkScore, reason: 'talk' }
    : { ...base, cls: 'snore', confidence: snoreScore, reason: 'snore' };
}

/** Confidence level for the screen: ≥ 0.8 high, ≥ 0.65 mid, else low (text comes from the i18n table). */
export function confidenceLevel(c: number): 'high' | 'mid' | 'low' {
  return c >= 0.8 ? 'high' : c >= 0.65 ? 'mid' : 'low';
}
