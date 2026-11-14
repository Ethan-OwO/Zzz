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

/**
 * 4 階 Butterworth 高通(兩個 RBJ biquad 串接,Q = 0.5412 與 1.3066)。只用在「拿來比門檻的音量」:
 * 人耳對 150 Hz 以下很不敏感，手機喇叭也放不出來,N1 那種 ~90 Hz 的冷氣 / 風扇嗡聲不該觸發事件。
 * cutoffHz <= 0 時不濾波(processMeanSquare 回傳原始 mean-square)。
 */
export class HighPass {
  private readonly c: Float64Array; // per stage: b0 b1 b2 a1 a2
  private readonly z = new Float64Array(8); // per stage: x1 x2 y1 y2
  private readonly enabled: boolean;

  constructor(cutoffHz: number, sampleRate: number) {
    this.enabled = cutoffHz > 0;
    this.c = new Float64Array(10);
    if (!this.enabled) return;
    const w0 = (2 * Math.PI * cutoffHz) / sampleRate;
    const cos = Math.cos(w0);
    [0.5411961, 1.3065630].forEach((q, k) => {
      const alpha = Math.sin(w0) / (2 * q);
      const a0 = 1 + alpha;
      const o = k * 5;
      this.c[o] = (1 + cos) / 2 / a0;
      this.c[o + 1] = -(1 + cos) / a0;
      this.c[o + 2] = (1 + cos) / 2 / a0;
      this.c[o + 3] = (-2 * cos) / a0;
      this.c[o + 4] = (1 - alpha) / a0;
    });
  }

  /** 回傳這一段高通後的 mean-square;不改動 frame、不配置新陣列。 */
  processMeanSquare(frame: Float32Array): number {
    const n = frame.length;
    if (n === 0) return 0;
    if (!this.enabled) return meanSquare(frame);
    const c = this.c;
    const z = this.z;
    let ax1 = z[0]!, ax2 = z[1]!, ay1 = z[2]!, ay2 = z[3]!;
    let bx1 = z[4]!, bx2 = z[5]!, by1 = z[6]!, by2 = z[7]!;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const x = frame[i]!;
      const y = c[0]! * x + c[1]! * ax1 + c[2]! * ax2 - c[3]! * ay1 - c[4]! * ay2;
      ax2 = ax1; ax1 = x; ay2 = ay1; ay1 = y;
      const v = c[5]! * y + c[6]! * bx1 + c[7]! * bx2 - c[8]! * by1 - c[9]! * by2;
      bx2 = bx1; bx1 = y; by2 = by1; by1 = v;
      sum += v * v;
    }
    const flush = (v: number) => (Math.abs(v) < 1e-30 ? 0 : v);
    z[0] = ax1; z[1] = ax2; z[2] = flush(ay1); z[3] = flush(ay2);
    z[4] = bx1; z[5] = bx2; z[6] = flush(by1); z[7] = flush(by2);
    return sum / n;
  }

  reset(): void {
    this.z.fill(0);
  }
}

export interface FrameFeatures {
  frameIndex: number;
  q: number;          // quantizeDb(高通後的 dB):門檻、噪音基準、校準都用這個
  ms: number;         // 全頻 mean-square
  lowMs: number;      // 低通後 mean-square
  zero: boolean;      // 全為 0 的幀(管線故障)
}

/**
 * Int16 → Float32(/32768),算出全頻 ms、低通 ms、高通後的 dB、是否全 0。scratch.length 即幀長。
 * ms / lowMs 維持全頻(打呼的低頻比例要看到 150 Hz 以下),只有 q 用高通。
 */
export function computeFeatures(
  pcm: Int16Array, offset: number, frameIndex: number, lp: LowPass, hp: HighPass, scratch: Float32Array,
): FrameFeatures {
  const n = scratch.length;
  for (let i = 0; i < n; i++) scratch[i] = (pcm[offset + i] ?? 0) / 32768;
  const ms = meanSquare(scratch);
  return {
    frameIndex,
    q: quantizeDb(msToDb(hp.processMeanSquare(scratch))),
    ms,
    lowMs: lp.processMeanSquare(scratch),
    zero: isZeroFrame(scratch),
  };
}
