// Per-frame spectral features at 16 kHz, 512-sample frames (bin width 31.25 Hz).
// Imports only sibling classify files and src/audio/features.ts (Node type stripping).
import { meanSquare, msToDb } from '../audio/features.ts';
import { HANN_512, RealFFT512 } from './fft.ts';

export const SAMPLE_RATE = 16000;
export const FRAME = 512;
const BIN_HZ = SAMPLE_RATE / FRAME; // 31.25

// Band edges as inclusive bin ranges (§5.2; not tuned).
const TOTAL: [number, number] = [2, 256]; // 50–8000 Hz
const LOW: [number, number] = [2, 16]; // 50–500 Hz
const SPEECH: [number, number] = [10, 108]; // 300–3400 Hz
const HIGH: [number, number] = [128, 256]; // 4000–8000 Hz
const FLAT: [number, number] = [3, 128]; // 100–4000 Hz

// Autocorrelation lag range: τ 40..228 ↔ 400..70 Hz.
const TAU_MIN = 40;
const TAU_MAX = 228;
/** 🎛 Normalized autocorrelation peak needed to call a frame voiced. */
export const VOICING_R = 0.5;
/** A sub-multiple lag τ/k replaces τ when its r is at least this fraction of rMax (octave-error guard). */
const SUBHARMONIC_KEEP = 0.9;

export interface FrameSpec {
  db: number; // 全頻 dB(與 M2 features.ts 的 msToDb(meanSquare) 相同算法)
  eTotal: number; // 50–8000 Hz 功率和(bin 2..256)
  eLow: number; // 50–500 Hz(bin 2..16)
  eSpeech: number; // 300–3400 Hz(bin 10..108)
  eHigh: number; // 4000–8000 Hz(bin 128..256)
  flatness: number; // 100–4000 Hz(bin 3..128)的頻譜平坦度：幾何平均 / 算術平均,0..1
  centroidHz: number; // 50–8000 Hz 的頻譜重心
  voiced: boolean; // 有聲(週期性)
  f0Hz: number | null; // voiced 時的基頻
}

function bandSum(p: Float64Array, [a, b]: [number, number]): number {
  let s = 0;
  for (let k = a; k <= b; k++) s += p[k]!;
  return s;
}

export class FrameAnalyzer {
  private readonly fft = new RealFFT512();
  private readonly raw = new Float32Array(FRAME);
  private readonly win = new Float32Array(FRAME);
  private readonly spec = new Float64Array(FRAME / 2 + 1);
  private readonly centered = new Float64Array(FRAME);
  // Prefix sums of x² so each lag's two energy terms are O(1).
  private readonly cum = new Float64Array(FRAME + 1);
  private readonly r = new Float64Array(TAU_MAX + 1);

  constructor() {}

  /** pcm 為 Int16 16 kHz;從 offset 起取 512 個樣本分析(超出 pcm 的部分當 0)。只新建 FrameSpec,不配置陣列。 */
  analyze(pcm: Int16Array, offset: number): FrameSpec {
    const { raw, win, spec } = this;
    for (let i = 0; i < FRAME; i++) {
      const j = offset + i;
      raw[i] = j >= 0 && j < pcm.length ? pcm[j]! / 32768 : 0;
    }
    const db = msToDb(meanSquare(raw));

    for (let i = 0; i < FRAME; i++) win[i] = raw[i]! * HANN_512[i]!;
    this.fft.powerSpectrum(win, spec);

    const eTotal = bandSum(spec, TOTAL);
    const eLow = bandSum(spec, LOW);
    const eSpeech = bandSum(spec, SPEECH);
    const eHigh = bandSum(spec, HIGH);

    let logSum = 0;
    let linSum = 0;
    for (let k = FLAT[0]; k <= FLAT[1]; k++) {
      const v = spec[k]! + 1e-12;
      logSum += Math.log(v);
      linSum += v;
    }
    const nFlat = FLAT[1] - FLAT[0] + 1;
    const flatness = Math.min(1, Math.exp(logSum / nFlat) / (linSum / nFlat));

    let wSum = 0;
    for (let k = TOTAL[0]; k <= TOTAL[1]; k++) wSum += k * BIN_HZ * spec[k]!;
    const centroidHz = eTotal > 0 ? wSum / eTotal : 0;

    const f0Hz = this.pitch();
    return { db, eTotal, eLow, eSpeech, eHigh, flatness, centroidHz, voiced: f0Hz !== null, f0Hz };
  }

  /** Normalized autocorrelation on the unwindowed, mean-removed frame; returns f0 or null when unvoiced. */
  private pitch(): number | null {
    const { raw, centered: x, cum, r } = this;
    let mean = 0;
    for (let i = 0; i < FRAME; i++) mean += raw[i]!;
    mean /= FRAME;
    cum[0] = 0;
    for (let i = 0; i < FRAME; i++) {
      const v = raw[i]! - mean;
      x[i] = v;
      cum[i + 1] = cum[i]! + v * v;
    }
    if (cum[FRAME]! <= 0) return null;

    let rMax = -Infinity;
    let tauBest = 0;
    for (let tau = TAU_MIN; tau <= TAU_MAX; tau++) {
      const n = FRAME - tau;
      let s = 0;
      for (let i = 0; i < n; i++) s += x[i]! * x[i + tau]!;
      const e0 = cum[n]!; // Σ x[0..n-1]²
      const e1 = cum[FRAME]! - cum[tau]!; // Σ x[tau..N-1]²
      const d = Math.sqrt(e0 * e1);
      const v = d > 0 ? s / d : 0;
      r[tau] = v;
      if (v > rMax) {
        rMax = v;
        tauBest = tau;
      }
    }
    if (!(rMax >= VOICING_R)) return null;

    // A periodic signal correlates equally well at 2T, 3T…; prefer the shortest lag
    // that is nearly as good, otherwise f0 is reported an octave (or more) too low.
    for (let k = Math.floor(tauBest / TAU_MIN); k >= 2; k--) {
      const c = Math.round(tauBest / k);
      let bestR = -Infinity;
      let bestT = c;
      for (let t = Math.max(TAU_MIN, c - 2); t <= Math.min(TAU_MAX, c + 2); t++) {
        if (r[t]! > bestR) {
          bestR = r[t]!;
          bestT = t;
        }
      }
      if (bestR >= SUBHARMONIC_KEEP * rMax) {
        tauBest = bestT;
        break;
      }
    }
    return SAMPLE_RATE / tauBest;
  }
}
