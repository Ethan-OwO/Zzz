// Whole-event summary features (§5.3). Only the core (trigger → post-roll start) is
// analysed: pre/post-roll is background and would dilute every ratio.
import { FRAME, SAMPLE_RATE, type FrameAnalyzer, type FrameSpec } from './frame-features.ts';

export const FEATURES_VERSION = 1;

const FRAME_SEC = FRAME / SAMPLE_RATE; // 0.032
const ENV_RATE = SAMPLE_RATE / FRAME; // 31.25 Hz envelope sample rate
/** A burst ends after this many consecutive non-active frames (0.32 s, same as M3). */
const BURST_END_FRAMES = 10;
const BURST_MIN_SEC = 0.1;
const MIN_F0_FRAMES = 5;
const MOD_WIN = 128; // 4.1 s of frames
const MOD_HOP = 64;

export interface EventFeatures {
  version: 1; // 特徵定義版本;改了任何算法就 +1
  coreSec: number; // 事件主體長度(不含 pre/post-roll)
  activeSec: number; // 主體中 db ≥ activeDb 的幀總長
  peakAboveFloorDb: number; // 主體最大 db - floorDb
  lowRatio: number; // Σ eLow / Σ eTotal(只算 active 幀)
  speechRatio: number; // Σ eSpeech / Σ eTotal
  highRatio: number; // Σ eHigh / Σ eTotal
  flatnessMedian: number; // active 幀 flatness 的中位數
  centroidMedianHz: number;
  voicedFraction: number; // voiced 的 active 幀 / active 幀
  f0MedianHz: number | null; // voiced 幀數 < 5 時為 null
  f0IqrSemitones: number | null; // 基頻四分位距(半音);voiced 幀數 < 5 時為 null
  syllabicModRatio: number | null; // 3–8 Hz 調變能量 / 0.5–15 Hz 調變能量;coreSec < 1 時為 null
  burstCount: number; // 主體內的「一聲」數
  burstMedianSec: number | null;
  burstIntervalMedianSec: number | null; // 相鄰一聲「開始到開始」的中位數;burstCount < 2 為 null
  burstIntervalCv: number | null; // 間隔的變異係數(標準差 / 平均);burstCount < 3 為 null
}

export interface EventSpan {
  pcm: Int16Array; // 整個事件的音訊(含 pre/post-roll)
  coreStartSample: number; // 主體在 pcm 中的起點
  coreEndSample: number; // 主體終點(不含)
  floorDb: number; // 事件開始時的噪音基準(SoundEventRecord.floorDbAtStart)
  releaseMarginDb: number; // 當晚校準的釋放 margin(NightRecord.calibration.releaseMarginDb)
}

/** Linear-interpolated quantile (type 7) of an ascending-sorted array. */
function quantileSorted(s: number[], q: number): number {
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return quantileSorted([...xs].sort((a, b) => a - b), 0.5);
}

/**
 * Σ P(3..8 Hz) / Σ P(0.5..15 Hz) of the speech-band level envelope (dB, 31.25 Hz).
 * Speech moves its level at the syllable rate (3–8 Hz); snores follow breathing (< 1 Hz).
 */
function syllabicModulation(env: Float64Array): number {
  const n = env.length;
  const starts: number[] = [];
  if (n <= MOD_WIN) {
    starts.push(0);
  } else {
    for (let s = 0; s + MOD_WIN <= n; s += MOD_HOP) starts.push(s);
    // Cover the tail too, so the last up-to-63 frames are not silently dropped.
    const last = starts[starts.length - 1]!;
    if (last + MOD_WIN < n) starts.push(n - MOD_WIN);
  }
  const kNum0 = Math.ceil((3 * MOD_WIN) / ENV_RATE);
  const kNum1 = Math.floor((8 * MOD_WIN) / ENV_RATE);
  const kDen0 = Math.ceil((0.5 * MOD_WIN) / ENV_RATE);
  const kDen1 = Math.floor((15 * MOD_WIN) / ENV_RATE);
  const seg = new Float64Array(MOD_WIN);
  let num = 0;
  let den = 0;
  for (const s of starts) {
    const len = Math.min(MOD_WIN, n - s);
    let mean = 0;
    for (let i = 0; i < len; i++) mean += env[s + i]!;
    mean /= len;
    seg.fill(0);
    for (let i = 0; i < len; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / len); // periodic Hann over the real data
      seg[i] = (env[s + i]! - mean) * w;
    }
    // Direct 128-point DFT, only the bins we need.
    for (let k = kDen0; k <= kDen1; k++) {
      let re = 0;
      let im = 0;
      for (let i = 0; i < len; i++) {
        const a = (2 * Math.PI * k * i) / MOD_WIN;
        re += seg[i]! * Math.cos(a);
        im -= seg[i]! * Math.sin(a);
      }
      const p = re * re + im * im;
      den += p;
      if (k >= kNum0 && k <= kNum1) num += p;
    }
  }
  return den > 0 ? num / den : 0;
}

/** 逐幀分析主體，彙總成 EventFeatures。主體不足一幀時回傳 null。 */
export function computeEventFeatures(span: EventSpan, analyzer: FrameAnalyzer): EventFeatures | null {
  const start = Math.max(0, Math.round(span.coreStartSample));
  const end = Math.min(span.pcm.length, Math.round(span.coreEndSample));
  // Full frames only: a partial last frame would read post-roll (or zeros), so the
  // result would depend on what surrounds the core.
  const nFrames = Math.floor((end - start) / FRAME);
  if (nFrames < 1) return null;

  const activeDb = span.floorDb + span.releaseMarginDb;
  const frames: FrameSpec[] = [];
  for (let i = 0; i < nFrames; i++) frames.push(analyzer.analyze(span.pcm, start + i * FRAME));

  let peak = -Infinity;
  let sTotal = 0;
  let sLow = 0;
  let sSpeech = 0;
  let sHigh = 0;
  const flat: number[] = [];
  const cent: number[] = [];
  const f0Semis: number[] = [];
  const f0s: number[] = [];
  let active = 0;
  let voiced = 0;
  const isActive: boolean[] = [];
  for (const f of frames) {
    if (f.db > peak) peak = f.db;
    const a = f.db >= activeDb;
    isActive.push(a);
    if (!a) continue;
    active++;
    sTotal += f.eTotal;
    sLow += f.eLow;
    sSpeech += f.eSpeech;
    sHigh += f.eHigh;
    flat.push(f.flatness);
    cent.push(f.centroidHz);
    if (f.voiced && f.f0Hz !== null) {
      voiced++;
      f0s.push(f.f0Hz);
      f0Semis.push(12 * Math.log2(f.f0Hz));
    }
  }

  let f0MedianHz: number | null = null;
  let f0IqrSemitones: number | null = null;
  if (f0s.length >= MIN_F0_FRAMES) {
    f0MedianHz = median(f0s);
    const s = f0Semis.sort((a, b) => a - b);
    f0IqrSemitones = quantileSorted(s, 0.75) - quantileSorted(s, 0.25);
  }

  const coreSec = (end - start) / SAMPLE_RATE;
  let syllabicModRatio: number | null = null;
  if (coreSec >= 1) {
    const env = new Float64Array(nFrames);
    for (let i = 0; i < nFrames; i++) env[i] = 10 * Math.log10(frames[i]!.eSpeech + 1e-12);
    syllabicModRatio = syllabicModulation(env);
  }

  // Bursts: a run of active frames that tolerates gaps shorter than BURST_END_FRAMES.
  const bursts: Array<{ first: number; last: number }> = [];
  let cur: { first: number; last: number } | null = null;
  for (let i = 0; i < nFrames; i++) {
    if (isActive[i]) {
      if (cur && i - cur.last - 1 < BURST_END_FRAMES) cur.last = i;
      else {
        if (cur) bursts.push(cur);
        cur = { first: i, last: i };
      }
    }
  }
  if (cur) bursts.push(cur);
  const kept = bursts.filter((b) => (b.last - b.first + 1) * FRAME_SEC >= BURST_MIN_SEC);
  const lens = kept.map((b) => (b.last - b.first + 1) * FRAME_SEC);
  const intervals: number[] = [];
  for (let i = 1; i < kept.length; i++) intervals.push((kept[i]!.first - kept[i - 1]!.first) * FRAME_SEC);
  let burstIntervalCv: number | null = null;
  if (kept.length >= 3) {
    const m = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    const v = intervals.reduce((a, b) => a + (b - m) ** 2, 0) / intervals.length;
    burstIntervalCv = m > 0 ? Math.sqrt(v) / m : null;
  }

  const ratio = (x: number): number => (sTotal > 0 ? x / sTotal : 0);
  return {
    version: FEATURES_VERSION,
    coreSec,
    activeSec: active * FRAME_SEC,
    peakAboveFloorDb: peak - span.floorDb,
    lowRatio: ratio(sLow),
    speechRatio: ratio(sSpeech),
    highRatio: ratio(sHigh),
    flatnessMedian: median(flat) ?? 0,
    centroidMedianHz: median(cent) ?? 0,
    voicedFraction: active > 0 ? voiced / active : 0,
    f0MedianHz,
    f0IqrSemitones,
    syllabicModRatio,
    burstCount: kept.length,
    burstMedianSec: median(lens),
    burstIntervalMedianSec: kept.length >= 2 ? median(intervals) : null,
    burstIntervalCv,
  };
}
