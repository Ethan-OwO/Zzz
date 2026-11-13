// Pure-function unit tests, no browser. Imports the TypeScript sources directly
// via Node's type stripping (Node >= 22.18), so those files may only import each
// other with full .ts extensions.
import { DB_FLOOR, FRAME_SIZE, isZeroFrame, meanSquare, msToDb } from '../src/audio/features.ts';
import { Resampler } from '../src/audio/resampler.ts';
import { DEFAULT_PARAMS, FRAME_SEC, secToFrames } from '../src/detect/params.ts';
import { FloorTracker, dequantizeDb, quantizeDb } from '../src/detect/levels.ts';
import { LowPass } from '../src/detect/bands.ts';
import { adjustMargin, computeCalibration } from '../src/detect/calibrate.ts';
import { SnoreTracker } from '../src/detect/snore.ts';
import { Detector } from '../src/detect/detector.ts';
import { Int16Ring } from '../src/record/ring.ts';

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

// ---------- M3: levels ----------
{
  const got = [quantizeDb(-120), quantizeDb(0), quantizeDb(-41.3), quantizeDb(5)];
  const rt = dequantizeDb(quantizeDb(-41.3));
  check('U-L1 quantizeDb / dequantizeDb', JSON.stringify(got) === '[0,240,157,240]' && rt === -41.5, `${got} / ${rt}`);
}
{
  const t = new FloorTracker(100, 20);
  for (let i = 0; i < 100; i++) t.push(i);
  check('U-L2 FloorTracker(100,20) of 0..99', t.floorDb() === dequantizeDb(19), String(t.floorDb()));
  for (let i = 0; i < 100; i++) t.push(200);
  check('U-L3 old values leave the window', t.floorDb() === dequantizeDb(200), String(t.floorDb()));
}
{
  let seed = 12345;
  const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  const t = new FloorTracker(1000, 20);
  const vals = [];
  let mismatches = 0;
  for (let i = 0; i < 5000; i++) {
    const v = Math.floor(rand() * 241);
    vals.push(v);
    t.push(v);
    const win = vals.slice(-1000).sort((a, b) => a - b);
    const want = dequantizeDb(win[Math.ceil((win.length * 20) / 100) - 1]);
    if (t.floorDb() !== want) mismatches++;
  }
  check('U-L4 5000 random pushes match sort-based percentile', mismatches === 0, `${mismatches} mismatches`);
}

// ---------- M3: bands ----------
function lowRatioOf(freq) {
  const x = sine(16000, freq, 1);
  const lp = new LowPass(500, 16000);
  return lp.processMeanSquare(x) / meanSquare(x);
}
{
  const r100 = lowRatioOf(100);
  const r4k = lowRatioOf(4000);
  check('U-B1 LowPass(500): 100 Hz > 0.9, 4 kHz < 0.01', r100 > 0.9 && r4k < 0.01, `${r100.toFixed(4)} / ${r4k.toExponential(2)}`);
}
{
  // Same signal: one sample per call (continuous state) vs 512-sample frames.
  const x = new Float32Array(16384).map((_, i) => Math.sin(i * 0.05) + 0.3 * Math.sin(i * 1.3));
  const ref = new LowPass(500, 16000);
  const framed = new LowPass(500, 16000);
  let maxRel = 0;
  for (let i = 0; i < x.length; i += 512) {
    let s = 0;
    for (let j = i; j < i + 512; j++) s += ref.processMeanSquare(x.subarray(j, j + 1));
    const want = s / 512;
    const got = framed.processMeanSquare(x.subarray(i, i + 512));
    maxRel = Math.max(maxRel, Math.abs(got - want) / want);
  }
  check('U-B2 512-sample frames vs sample-by-sample lowMs relative error < 1e-9', maxRel < 1e-9, maxRel.toExponential(2));
}

// ---------- M3: calibrate ----------
const P = DEFAULT_PARAMS;
const qArr = (dbs) => Uint8Array.from(dbs, (d) => quantizeDb(d));
const fill = (n, db) => new Array(n).fill(db);
{
  const r = computeCalibration(qArr(fill(900, -60)), qArr(fill(300, -28)), P);
  check('U-C1 quiet -60 / speech -28', r.floorDb === -60 && r.speechDb === -28 && r.triggerMarginDb === 16 &&
    r.releaseMarginDb === 12 && r.status === 'ok', JSON.stringify(r));
}
{
  const r = computeCalibration(qArr(fill(900, -60)), qArr(fill(300, -57)), P);
  check('U-C2 speech -57 -> no-speech, default margin', r.status === 'no-speech' && r.triggerMarginDb === 10, JSON.stringify(r));
}
{
  const quiet = qArr(Array.from({ length: 900 }, (_, i) => (i % 2 ? -40 : -60)));
  const r = computeCalibration(quiet, qArr(fill(300, -36)), P);
  check('U-C3 alternating -60/-40 quiet, speech -36 -> too-noisy', r.status === 'too-noisy', JSON.stringify(r));
}
{
  const r = adjustMargin(computeCalibration(qArr(fill(900, -60)), qArr(fill(300, -28)), P), 20, P);
  check('U-C4 adjustMargin +20 clamps at 20', r.triggerMarginDb === 20 && r.releaseMarginDb === 16, JSON.stringify(r));
}

// ---------- M3: snore ----------
const F = (sec) => Math.round(sec / FRAME_SEC);
const snoreBurst = (startSec, lenSec = 1, lowRatio = 0.8) =>
  ({ startFrame: F(startSec), endFrame: F(startSec) + F(lenSec), peakDb: -30, lowRatio });
{
  const t = new SnoreTracker(P);
  const outs = [];
  for (let i = 0; i < 10; i++) outs.push(t.onBurst(snoreBurst(i * 4))?.type ?? null);
  const lastEnd = snoreBurst(36).endFrame;
  const before = t.onFrame(lastEnd + F(15) - 1);
  const after = t.onFrame(lastEnd + F(15) + 1);
  const ok = outs.slice(0, 3).every((o) => o === null) && outs[3] === 'confirmed' &&
    outs.slice(4).every((o) => o === 'continued') && before === null && after?.type === 'ended';
  check('U-S1 10 bursts every 4 s: confirmed at 4th, continued, ended 15 s after', ok, JSON.stringify(outs));
}
{
  const t = new SnoreTracker(P);
  const starts = [0, 4, 8, 17, 21, 25, 29];
  const outs = starts.map((s) => t.onBurst(snoreBurst(s))?.type ?? null);
  check('U-S2 intervals 4,4,9,4,4,4: restart after 9 s, confirmed only at the 4th burst after it',
    outs.slice(0, 6).every((o) => o === null) && outs[6] === 'confirmed', JSON.stringify(outs));
}
{
  const t = new SnoreTracker(P);
  const outs = [0, 2.5, 8.5, 11].map((s) => t.onBurst(snoreBurst(s))?.type ?? null);
  check('U-S3 irregular 2.5, 6, 2.5 never confirms', outs.every((o) => o === null), JSON.stringify(outs));
}
{
  const t = new SnoreTracker(P);
  check('U-S4 lowRatio 0.3 is not snore-like', t.isSnoreLike(snoreBurst(0, 1, 0.3)) === false);
}

// ---------- M3: detector ----------
const QUIET = -60;
const msOf = (db) => 10 ** (db / 10);
class Sim {
  constructor(keepSnore = false) {
    this.d = new Detector(P, 10, 6, keepSnore);
    this.fi = 0;
    this.actions = [];
    this.add(30, QUIET); // warm-up
  }
  frame(db, lowRatio = 0.3, zero = false) {
    const ms = zero ? 0 : msOf(db);
    const f = { frameIndex: this.fi++, q: zero ? 0 : quantizeDb(db), ms, lowMs: ms * lowRatio, zero };
    for (const a of this.d.push(f)) this.actions.push({ ...a, at: f.frameIndex });
  }
  /** seconds of a constant level */
  add(sec, db, lowRatio = 0.3, zero = false) {
    const n = F(sec);
    for (let i = 0; i < n; i++) this.frame(db, lowRatio, zero);
  }
  gap() {
    for (const a of this.d.handleGap(this.fi)) this.actions.push({ ...a, at: this.fi });
  }
  types() {
    return this.actions.map((a) => a.type + (a.reason ? `:${a.reason}` : '') + (a.tentative ? ':t' : ''));
  }
  of(type) {
    return this.actions.filter((a) => a.type === type);
  }
}
{
  const s = new Sim();
  s.add(600, QUIET);
  check('U-D1 10 min of background: no actions', s.actions.length === 0, JSON.stringify(s.types()));
}
{
  const s = new Sim();
  s.add(10, QUIET);
  for (let i = 0; i < 7; i++) s.frame(-45);
  s.add(20, QUIET);
  check('U-D2 -45 dB for 7 frames (< 8/10): nothing', s.actions.length === 0, JSON.stringify(s.types()));
}
{
  const s = new Sim();
  s.add(10, QUIET);
  const soundStart = s.fi;
  s.add(1, -45);
  const soundEnd = s.fi;
  s.add(10, QUIET);
  const [st] = s.of('event-start');
  const [en] = s.of('event-end');
  const wsExpected = st ? st.at - P.triggerWindowFrames + 1 : NaN;
  const ok = s.actions.length === 2 && st.fromFrame === wsExpected - secToFrames(5) &&
    st.coreFromFrame === soundStart && en.reason === 'released' &&
    en.toFrame === soundEnd + secToFrames(2) + secToFrames(3) && en.coreToFrame === soundEnd;
  check('U-D3 1 s sound: start with 5 s pre-roll, released after 2 s + 3 s', ok, JSON.stringify(s.actions));
}
{
  const s = new Sim();
  s.add(10, QUIET); s.add(1, -45); s.add(3, QUIET); s.add(1, -45); s.add(10, QUIET);
  check('U-D4 two sounds 3 s apart merge into one event', JSON.stringify(s.types()) === '["event-start","event-end:released"]',
    JSON.stringify(s.types()));
}
{
  const s = new Sim();
  s.add(10, QUIET); s.add(1, -45); s.add(8, QUIET); s.add(1, -45); s.add(10, QUIET);
  const st = s.of('event-start');
  const en = s.of('event-end');
  check('U-D5 8 s apart: two events, second starts at or after the first ends',
    st.length === 2 && en.length === 2 && st[1].fromFrame >= en[0].toFrame, JSON.stringify(s.actions));
}
{
  const s = new Sim();
  s.add(10, QUIET); s.add(130, -45); s.add(10, QUIET);
  const st = s.of('event-start');
  const en = s.of('event-end');
  const ok = st.length === 3 && en.length === 3 && en[0].reason === 'split' && en[1].reason === 'split' &&
    st[1].fromFrame === en[0].toFrame && st[2].fromFrame === en[1].toFrame &&
    st[1].continuesKey === st[0].eventKey && st[2].continuesKey === st[1].eventKey;
  check('U-D6 130 s sound: 3 segments joined by split', ok, JSON.stringify(s.types()));
}
function snoreSim(insertAfter = -1, keep = false) {
  const s = new Sim(keep);
  s.add(10, QUIET);
  for (let i = 0; i < 10; i++) {
    s.add(1, -40, 0.8);
    if (i === insertAfter) {
      s.add(0.5, QUIET); s.add(1.5, -40, 0.2); s.add(1, QUIET);
    } else {
      s.add(3, QUIET);
    }
  }
  s.add(30, QUIET);
  return s;
}
{
  const s = snoreSim();
  const t = s.types();
  const confirmedAt = t.indexOf('event-end:snore-confirmed');
  const ss = s.of('snore-start')[0];
  const afterStart = t.slice(t.indexOf('snore-start') + 1);
  const expectTail = [];
  for (let i = 0; i < 6; i++) expectTail.push('event-start:t', 'event-discard', 'snore-burst');
  expectTail.push('snore-end:quiet');
  const ok = t[0] === 'event-start' && confirmedAt === 1 && t[2] === 'snore-start' && ss.sampleEventKeys.length > 0 &&
    ss.sampleEventKeys.includes(s.of('event-start')[0].eventKey) &&
    JSON.stringify(afterStart) === JSON.stringify(expectTail);
  check('U-D7 10 snores: event, snore-confirmed, then tentative+discard per snore, snore-end', ok, JSON.stringify(t));
}
{
  const s = snoreSim(5);
  const t = s.types();
  const commits = s.of('event-commit');
  const committedKey = commits[0]?.eventKey;
  const endOfCommitted = s.actions.find((a) => a.type === 'event-end' && a.eventKey === committedKey);
  const ok = commits.length === 1 && endOfCommitted?.reason === 'released' &&
    s.of('snore-start').length === 1 && s.of('snore-end').length === 1 && s.of('snore-burst').length === 6;
  check('U-D8 non-snore sound inside an episode is committed and ends normally; episode continues', ok, JSON.stringify(t));
}
{
  const s = snoreSim(-1, true);
  const commits = s.of('event-commit');
  check('keepSnoreAudio: snores in the episode are committed as snoreLike, none discarded',
    s.of('event-discard').length === 0 && commits.length === 6 && commits.every((c) => c.snoreLike), JSON.stringify(s.types()));
}
{
  const s = new Sim();
  s.add(10, QUIET); s.add(0.5, -45);
  const gapAt = s.fi;
  s.gap();
  s.add(1, -45); s.add(10, QUIET);
  const en = s.of('event-end');
  const st = s.of('event-start');
  check('U-D9 handleGap ends the event (gap); the next event does not reach back before the gap',
    en[0]?.reason === 'gap' && en[0].toFrame === gapAt && st.length === 2 && st[1].fromFrame >= gapAt, JSON.stringify(s.actions));
}
{
  const s = new Sim();
  s.add(10, QUIET);
  const before = s.d.snapshot().floorDb;
  s.add(100 * FRAME_SEC, QUIET, 0.3, true);
  const after = s.d.snapshot().floorDb;
  check('U-D10 100 zero frames: floor unchanged, no trigger', before === after && s.actions.length === 0, `${before} / ${after}`);
}
{
  const d = new Detector(P, 10, 6);
  d.seedFloor(Uint8Array.from(fill(156, quantizeDb(-60))));
  const snap = d.snapshot();
  check('seedFloor: calibration counts as warm-up', snap.state === 'idle' && snap.floorDb === -60, JSON.stringify(snap));
}

// ---------- M3: ring ----------
{
  const r = new Int16Ring(10);
  r.push(Int16Array.from({ length: 25 }, (_, i) => i));
  const got = Array.from(r.read(0, 25));
  check('U-R1 Int16Ring(10) after 25 samples reads 15..24', JSON.stringify(got) === JSON.stringify([15, 16, 17, 18, 19, 20, 21, 22, 23, 24]) &&
    r.oldestIndex === 15 && r.endIndex === 25, JSON.stringify(got));
  r.push(Int16Array.from([100, 101, 102]));
  const wrap = Array.from(r.read(24, 28));
  r.clear();
  check('Int16Ring wraps and clear() keeps the absolute index', JSON.stringify(wrap) === '[24,100,101,102]' &&
    r.read(0, 28).length === 0 && r.endIndex === 28 && r.oldestIndex === 28, JSON.stringify(wrap));
}

process.exit(failed ? 1 : 0);
