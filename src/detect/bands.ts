// Low-band energy (biquad low-pass) and per-frame features. Only imports
// src/detect files and the import-free src/audio/features.ts.
import { isZeroFrame, meanSquare, msToDb } from '../audio/features.ts';
import { quantizeDb } from './levels.ts';

/** 2 階 Butterworth 低通(RBJ biquad,Q = 0.7071),有狀態，可逐幀餵入。 */
export class LowPass {
  private readonly b0: number;
  private readonly b1: number;
  private readonly b2: number;
  private readonly a1: number;
  private readonly a2: number;
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;

  constructor(cutoffHz: number, sampleRate: number) {
    const w0 = (2 * Math.PI * cutoffHz) / sampleRate;
    const cos = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
    const a0 = 1 + alpha;
    this.b0 = (1 - cos) / 2 / a0;
    this.b1 = (1 - cos) / a0;
    this.b2 = (1 - cos) / 2 / a0;
    this.a1 = (-2 * cos) / a0;
    this.a2 = (1 - alpha) / a0;
  }

  /** 回傳這一段濾波後的 mean-square;不配置新陣列。 */
  processMeanSquare(frame: Float32Array): number {
    const n = frame.length;
    if (n === 0) return 0;
    let { x1, x2, y1, y2 } = this;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const x = frame[i]!;
      const y = this.b0 * x + this.b1 * x1 + this.b2 * x2 - this.a1 * y1 - this.a2 * y2;
      x2 = x1;
      x1 = x;
      y2 = y1;
      y1 = y;
      sum += y * y;
    }
    // Flush denormals so a long stretch of silence does not slow the filter down.
    if (Math.abs(y1) < 1e-30) y1 = 0;
    if (Math.abs(y2) < 1e-30) y2 = 0;
    this.x1 = x1;
    this.x2 = x2;
    this.y1 = y1;
    this.y2 = y2;
    return sum / n;
  }

  reset(): void {
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
  }
}

export interface FrameFeatures {
  frameIndex: number;
  q: number;          // quantizeDb(全頻 dB)
  ms: number;         // 全頻 mean-square
  lowMs: number;      // 低通後 mean-square
  zero: boolean;      // 全為 0 的幀(管線故障)
}

/** Int16 → Float32(/32768),算出全頻 ms、低通 ms、dB、是否全 0。scratch.length 即幀長。 */
export function computeFeatures(
  pcm: Int16Array, offset: number, frameIndex: number, lp: LowPass, scratch: Float32Array,
): FrameFeatures {
  const n = scratch.length;
  for (let i = 0; i < n; i++) scratch[i] = (pcm[offset + i] ?? 0) / 32768;
  const ms = meanSquare(scratch);
  return {
    frameIndex,
    q: quantizeDb(msToDb(ms)),
    ms,
    lowMs: lp.processMeanSquare(scratch),
    zero: isZeroFrame(scratch),
  };
}
