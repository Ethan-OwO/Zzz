// 512-point radix-2 FFT (iterative Cooley–Tukey). Pure, no DOM, no deps:
// scripts/unit-classify.mjs imports this file through Node's type stripping.

const N = 512;
const LOG2N = 9;

/** 512 點 Hann 窗(periodic),共用一份。 */
export const HANN_512: Float32Array = (() => {
  const w = new Float32Array(N);
  for (let n = 0; n < N; n++) w[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / N);
  return w;
})();

/** 預先算好的 512 點 radix-2 FFT;只配置一次，之後重用。 */
export class RealFFT512 {
  private readonly re = new Float64Array(N);
  private readonly im = new Float64Array(N);
  private readonly rev = new Uint16Array(N);
  // Twiddles e^{-2πik/N} for k = 0..N/2-1; stage with span m uses stride N/m.
  private readonly cosT = new Float64Array(N / 2);
  private readonly sinT = new Float64Array(N / 2);

  constructor() {
    for (let i = 0; i < N; i++) {
      let r = 0;
      for (let b = 0; b < LOG2N; b++) if (i & (1 << b)) r |= 1 << (LOG2N - 1 - b);
      this.rev[i] = r;
    }
    for (let k = 0; k < N / 2; k++) {
      this.cosT[k] = Math.cos((2 * Math.PI * k) / N);
      this.sinT[k] = -Math.sin((2 * Math.PI * k) / N);
    }
  }

  /** input: 512 個 Float32 樣本(已加窗)。out: 長度 257 的功率譜 |X[k]|²(k = 0..256)。不配置新陣列。 */
  powerSpectrum(input: Float32Array, out: Float64Array): void {
    const { re, im, rev, cosT, sinT } = this;
    // Bit-reversal permutation while loading; imaginary part is 0 (real input).
    for (let i = 0; i < N; i++) {
      re[rev[i]!] = input[i]!;
      im[i] = 0;
    }
    for (let size = 2; size <= N; size <<= 1) {
      const half = size >> 1;
      const stride = N / size;
      for (let start = 0; start < N; start += size) {
        for (let j = 0; j < half; j++) {
          const wr = cosT[j * stride]!;
          const wi = sinT[j * stride]!;
          const a = start + j;
          const b = a + half;
          const br = re[b]!;
          const bi = im[b]!;
          const tr = br * wr - bi * wi;
          const ti = br * wi + bi * wr;
          const ar = re[a]!;
          const ai = im[a]!;
          re[a] = ar + tr;
          im[a] = ai + ti;
          re[b] = ar - tr;
          im[b] = ai - ti;
        }
      }
    }
    for (let k = 0; k <= N / 2; k++) {
      const r = re[k]!;
      const m = im[k]!;
      out[k] = r * r + m * m;
    }
  }
}
