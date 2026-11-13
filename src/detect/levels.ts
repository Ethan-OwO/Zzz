// Quantized dB and a sliding-window percentile noise floor. Import-free except
// for other src/detect files, so scripts/unit.mjs can load it directly.

export const Q_BINS = 241; // 0..240 = -120..0 dB in 0.5 dB steps

/** dB(-120..0)→ 0..240 的整數，步長 0.5 dB:round((clamp(db,-120,0)+120)*2)。 */
export function quantizeDb(db: number): number {
  const c = Number.isNaN(db) ? -120 : Math.min(0, Math.max(-120, db));
  return Math.round((c + 120) * 2);
}

/** q/2 - 120。 */
export function dequantizeDb(q: number): number {
  return q / 2 - 120;
}

/** Percentile over a histogram: the first bin whose running count reaches ceil(count × pct / 100). */
export function histogramPercentile(hist: Uint32Array, count: number, percentile: number): number | null {
  if (count === 0) return null;
  const target = Math.max(1, Math.ceil((count * percentile) / 100));
  let acc = 0;
  for (let i = 0; i < hist.length; i++) {
    acc += hist[i]!;
    if (acc >= target) return i;
  }
  return hist.length - 1;
}

/** Percentile (same definition) of a list of quantized dB values; null when empty. */
export function percentileQ(values: ArrayLike<number>, percentile: number): number | null {
  const hist = new Uint32Array(Q_BINS);
  for (let i = 0; i < values.length; i++) hist[values[i]!]!++;
  return histogramPercentile(hist, values.length, percentile);
}

/** 以 241 格直方圖維護「最近 N 幀」的百分位數。 */
export class FloorTracker {
  private readonly hist = new Uint32Array(Q_BINS);
  private readonly ring: Uint8Array;
  private readonly percentile: number;
  private head = 0;
  private n = 0;

  constructor(windowFrames: number, percentile: number) {
    this.ring = new Uint8Array(Math.max(1, windowFrames));
    this.percentile = percentile;
  }

  /** 推入一幀的量化 dB;窗口滿了就同時移除最舊的一幀。O(1)。 */
  push(q: number): void {
    if (this.n === this.ring.length) this.hist[this.ring[this.head]!]!--;
    else this.n++;
    this.ring[this.head] = q;
    this.hist[q]!++;
    this.head = (this.head + 1) % this.ring.length;
  }

  /** 目前窗口內的樣本數。 */
  get count(): number {
    return this.n;
  }

  /** 窗口內第 percentile 百分位的 dB(dequantize 後)。count 為 0 時回傳 null。O(241)。 */
  floorDb(): number | null {
    const q = histogramPercentile(this.hist, this.n, this.percentile);
    return q === null ? null : dequantizeDb(q);
  }

  /** 清空。 */
  reset(): void {
    this.hist.fill(0);
    this.head = 0;
    this.n = 0;
  }
}
