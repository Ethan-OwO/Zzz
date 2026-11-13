// Stateful anti-aliased downsampler. No imports: scripts/unit.mjs loads this
// file directly through Node's TypeScript type stripping.

const TAPS = 63;
const RING = 64; // power of two >= TAPS, so ring indexing is a bit mask
const MASK = RING - 1;

/** 有狀態的降採樣器：先做抗混疊低通，再以分數步長線性內插到 outRate。可分段餵入，分段結果必須等於一次餵入。 */
export class Resampler {
  private readonly inRate: number;
  private readonly outRate: number;
  private readonly passthrough: boolean;
  private readonly coeffs: Float64Array;
  private readonly ring = new Float64Array(RING); // last TAPS raw input samples
  private writePos = 0;
  // Filtered samples of the current call; index 0 holds the last filtered
  // sample carried over from the previous call.
  private scratch = new Float64Array(1);
  private hasPrev = false;
  /** Absolute index (relative to `base`) of scratch[0]. */
  private scratchStart = 0;
  /** Filtered samples produced since `base`. */
  private produced = 0;
  /** Next output index since `base`. */
  private k = 0;

  constructor(inRate: number, outRate: number) {
    if (!(inRate > 0) || !(outRate > 0)) throw new RangeError('sample rates must be positive');
    if (inRate < outRate) throw new RangeError(`cannot upsample ${inRate} -> ${outRate}`);
    this.inRate = inRate;
    this.outRate = outRate;
    this.passthrough = inRate === outRate;
    this.coeffs = new Float64Array(TAPS);
    if (!this.passthrough) {
      // Hamming-windowed sinc low-pass, cutoff 0.45 * outRate, normalised to
      // cycles per input sample, then scaled to unity DC gain.
      const fc = (0.45 * outRate) / inRate;
      const mid = (TAPS - 1) / 2;
      let sum = 0;
      for (let n = 0; n < TAPS; n++) {
        const x = n - mid;
        const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
        const w = 0.54 - 0.46 * Math.cos((2 * Math.PI * n) / (TAPS - 1));
        this.coeffs[n] = sinc * w;
        sum += sinc * w;
      }
      for (let n = 0; n < TAPS; n++) this.coeffs[n] = this.coeffs[n]! / sum;
    }
  }

  /** 餵入任意長度的輸入，回傳這次產生的輸出樣本(長度可能為 0)。 */
  process(input: Float32Array): Float32Array {
    if (this.passthrough) return input.slice();

    // 1. Low-pass every input sample into scratch[offset..].
    const offset = this.hasPrev ? 1 : 0;
    const needed = input.length + offset;
    if (this.scratch.length < needed) this.scratch = new Float64Array(needed);
    const h = this.coeffs;
    const ring = this.ring;
    for (let i = 0; i < input.length; i++) {
      this.writePos = (this.writePos + 1) & MASK;
      ring[this.writePos] = input[i]!;
      let acc = 0;
      for (let j = 0; j < TAPS; j++) acc += h[j]! * ring[(this.writePos - j) & MASK]!;
      this.scratch[offset + i] = acc;
    }
    this.produced += input.length;

    // 2. Linear interpolation at output positions k * inRate / outRate.
    //    Positions are computed from k (not accumulated), so chunking cannot
    //    change them. Output k needs filtered samples idx and idx + 1.
    const count = this.countReady();
    const out = new Float32Array(count);
    for (let o = 0; o < count; o++) {
      const pos = (this.k * this.inRate) / this.outRate;
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const a = this.scratch[idx - this.scratchStart]!;
      const b = this.scratch[idx + 1 - this.scratchStart]!;
      out[o] = a + (b - a) * frac;
      this.k++;
    }

    // 3. Carry the last filtered sample: the next output's idx is >= produced - 1.
    if (needed > 0) {
      this.scratch[0] = this.scratch[needed - 1]!;
      this.hasPrev = true;
      this.scratchStart = this.produced - 1;
    }

    // 4. Rebase once per second of output so k and positions stay small and
    //    exact over a whole night. Only valid when inRate is an integer.
    if (Number.isInteger(this.inRate) && Number.isInteger(this.outRate)) {
      while (this.k >= this.outRate) {
        this.k -= this.outRate;
        this.produced -= this.inRate;
        this.scratchStart -= this.inRate;
      }
    }
    return out;
  }

  private countReady(): number {
    // Number of outputs k' >= k with floor(k' * inRate / outRate) + 1 < produced.
    let n = 0;
    let k = this.k;
    while (Math.floor((k * this.inRate) / this.outRate) + 1 < this.produced) {
      n++;
      k++;
    }
    return n;
  }
}
