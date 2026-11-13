// Writes the synthetic microphone fixture used by scripts/check.mjs
// (design_M3 §5): 48 kHz, 16-bit, mono WAV, fixed random seed.
//   0–110 s  background: white noise through a 1-pole 2 kHz low-pass, RMS -60 dBFS
//   6–10 s   calibration speech: 300–3000 Hz band noise × 4 Hz envelope, -28 dBFS
//   30–32 s  event A (speech), -30 dBFS
//   45–84 s  snoring: 1.0 s bursts every 4 s (45, 49, …, 81), < 200 Hz noise, 0.1 s fades, -30 dBFS
//   67–68.5 s event B (speech inside the snore episode), -30 dBFS
// Usage: node scripts/make-fixture.mjs <out.wav>
import { writeFileSync } from 'node:fs';

const RATE = 48000;
const TOTAL_SEC = 110;
const N = RATE * TOTAL_SEC;

let seed = 0x2545f491;
function rand() {
  // xorshift32
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return (seed >>> 0) / 4294967296;
}
function noise(n) {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = rand() + rand() + rand() - 1.5;
  return out;
}
function onePoleLowPass(x, cutoff) {
  const a = Math.exp((-2 * Math.PI * cutoff) / RATE);
  let y = 0;
  for (let i = 0; i < x.length; i++) {
    y = (1 - a) * x[i] + a * y;
    x[i] = y;
  }
  return x;
}
function biquadLowPass(x, cutoff) {
  const w0 = (2 * Math.PI * cutoff) / RATE;
  const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
  const cos = Math.cos(w0);
  const a0 = 1 + alpha;
  const b0 = (1 - cos) / 2 / a0, b1 = (1 - cos) / a0, b2 = b0, a1 = (-2 * cos) / a0, a2 = (1 - alpha) / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    const y = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = v; y2 = y1; y1 = y;
    x[i] = y;
  }
  return x;
}
function scaleTo(x, db) {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  const k = 10 ** (db / 20) / Math.sqrt(s / x.length);
  for (let i = 0; i < x.length; i++) x[i] *= k;
  return x;
}
function addAt(dst, src, startSec) {
  const o = Math.round(startSec * RATE);
  for (let i = 0; i < src.length && o + i < dst.length; i++) dst[o + i] += src[i];
}
function speech(sec, db) {
  const n = Math.round(sec * RATE);
  const x = noise(n);
  // Band-pass: (x minus its 300 Hz low-pass) then a 3 kHz low-pass.
  const hp = new Float64Array(n);
  const lp300 = onePoleLowPass(Float64Array.from(x), 300);
  for (let i = 0; i < n; i++) hp[i] = x[i] - lp300[i];
  const band = biquadLowPass(biquadLowPass(hp, 3000), 3000);
  for (let i = 0; i < n; i++) band[i] *= 0.6 + 0.4 * Math.sin((2 * Math.PI * 4 * i) / RATE); // syllables
  return scaleTo(band, db);
}
function snore(sec, db) {
  const n = Math.round(sec * RATE);
  const x = biquadLowPass(biquadLowPass(noise(n), 200), 200);
  scaleTo(x, db);
  const fade = Math.round(0.1 * RATE);
  for (let i = 0; i < fade; i++) {
    x[i] *= i / fade;
    x[n - 1 - i] *= i / fade;
  }
  return x;
}

const out = scaleTo(onePoleLowPass(noise(N), 2000), -60);
addAt(out, speech(4, -28), 6);
addAt(out, speech(2, -30), 30);
for (let t = 45; t <= 81; t += 4) addAt(out, snore(1, -30), t);
addAt(out, speech(1.5, -30), 67);

const pcm = Buffer.alloc(N * 2);
for (let i = 0; i < N; i++) {
  const v = Math.max(-32768, Math.min(32767, Math.round(out[i] * 32767)));
  pcm.writeInt16LE(v, i * 2);
}
const header = Buffer.alloc(44);
header.write('RIFF', 0);
header.writeUInt32LE(36 + pcm.length, 4);
header.write('WAVE', 8);
header.write('fmt ', 12);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20);       // PCM
header.writeUInt16LE(1, 22);       // mono
header.writeUInt32LE(RATE, 24);
header.writeUInt32LE(RATE * 2, 28);
header.writeUInt16LE(2, 32);
header.writeUInt16LE(16, 34);
header.write('data', 36);
header.writeUInt32LE(pcm.length, 40);

const path = process.argv[2];
if (!path) {
  console.error('usage: node scripts/make-fixture.mjs <out.wav>');
  process.exit(2);
}
writeFileSync(path, Buffer.concat([header, pcm]));
