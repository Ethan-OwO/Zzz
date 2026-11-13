// Pure-function unit tests, no browser. Imports the TypeScript sources directly
// via Node's type stripping (Node >= 22.18), so those files must stay import-free.
import { DB_FLOOR, FRAME_SIZE, isZeroFrame, meanSquare, msToDb } from '../src/audio/features.ts';
import { Resampler } from '../src/audio/resampler.ts';

let failed = false;
function check(name, cond, info = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${info ? ` (${info})` : ''}`);
  if (!cond) failed = true;
}

function sine(rate, freq, seconds, amp = 1) {
  const n = Math.round(rate * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
}
function rmsDb(x, trim = 0) {
  const s = x.subarray(trim, x.length - trim);
  return msToDb(meanSquare(s));
}
function concat(parts) {
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Float32Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// T1
check('T1 msToDb(0) and msToDb(1e-20) are -120', msToDb(0) === -120 && msToDb(1e-20) === -120 && DB_FLOOR === -120,
  `${msToDb(0)}, ${msToDb(1e-20)}`);
// T2
check('T2 msToDb(1) is 0', msToDb(1) === 0, String(msToDb(1)));
// T3
{
  const f = sine(16000, 1000, FRAME_SIZE / 16000);
  const db = msToDb(meanSquare(f));
  check('T3 unit sine 512 samples is -3.01 ± 0.05 dB', f.length === 512 && Math.abs(db + 3.01) <= 0.05, db.toFixed(3));
}
// T4
{
  const zeros = new Float32Array(512);
  const one = new Float32Array(512);
  one[100] = 1e-30;
  check('T4 isZeroFrame all-zero / one 1e-30', isZeroFrame(zeros) === true && isZeroFrame(one) === false,
    `${isZeroFrame(zeros)} / ${isZeroFrame(one)}`);
}
// T5
const t5in = sine(48000, 1000, 1);
const t5out = new Resampler(48000, 16000).process(t5in);
{
  const diff = Math.abs(rmsDb(t5out, 64) - rmsDb(t5in));
  check('T5 48k 1 kHz: length 16000 ± 1, RMS within 0.5 dB',
    Math.abs(t5out.length - 16000) <= 1 && diff < 0.5, `len ${t5out.length}, Δ ${diff.toFixed(3)} dB`);
}
// T6
{
  const input = sine(48000, 10000, 1);
  const out = new Resampler(48000, 16000).process(input);
  const drop = rmsDb(input) - rmsDb(out, 64);
  check('T6 48k 10 kHz attenuated >= 20 dB', drop >= 20, `${drop.toFixed(1)} dB`);
}
// T7
{
  const out = new Resampler(44100, 16000).process(sine(44100, 1000, 1));
  check('T7 44.1k 1 kHz: length 16000 ± 1', Math.abs(out.length - 16000) <= 1, `len ${out.length}`);
}
// T8
{
  const r = new Resampler(48000, 16000);
  const parts = [];
  for (let i = 0; i < t5in.length; i += 128) parts.push(r.process(t5in.subarray(i, i + 128)));
  const chunked = concat(parts);
  let maxDiff = 0;
  for (let i = 0; i < Math.min(chunked.length, t5out.length); i++) {
    maxDiff = Math.max(maxDiff, Math.abs(chunked[i] - t5out[i]));
  }
  check('T8 128-sample chunks equal one-shot (< 1e-6)', chunked.length === t5out.length && maxDiff < 1e-6,
    `len ${chunked.length}/${t5out.length}, max Δ ${maxDiff.toExponential(2)}`);
}
// T9
{
  const input = new Float32Array(100).map((_, i) => Math.sin(i));
  const out = new Resampler(16000, 16000).process(input);
  check('T9 16k -> 16k passthrough', out.length === 100 && out.every((v, i) => v === input[i]) && out !== input);
}
// T10
{
  let threw = false;
  try {
    new Resampler(8000, 16000);
  } catch {
    threw = true;
  }
  check('T10 Resampler(8000, 16000) throws', threw);
}

process.exit(failed ? 1 : 0);
