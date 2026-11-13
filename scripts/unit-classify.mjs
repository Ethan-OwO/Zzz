// M4 T1 unit tests for src/classify/*. Pure Node (type stripping), no browser.
// All test signals are synthesised here with fixed seeds at 16 kHz Int16.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { meanSquare, msToDb } from '../src/audio/features.ts';
import { HANN_512, RealFFT512 } from '../src/classify/fft.ts';
import { FrameAnalyzer } from '../src/classify/frame-features.ts';
import { computeEventFeatures, FEATURES_VERSION } from '../src/classify/event-features.ts';
import { classify, DEFAULT_CLASSIFY_PARAMS, ramp } from '../src/classify/rules.ts';
import { evaluate } from '../src/classify/evaluate.ts';

const SR = 16000;
const here = dirname(fileURLToPath(import.meta.url));

let failed = false;
function check(name, cond, info = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${info ? ` (${info})` : ''}`);
  if (!cond) failed = true;
}
const fmt = (x, d = 3) => (x === null || x === undefined ? 'null' : Number(x).toFixed(d));

// ---------- signal helpers ----------
function rng(seed) {
  // mulberry32
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(r) {
  const u = Math.max(r(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}
function white(n, seed) {
  const r = rng(seed);
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = gauss(r);
  return x;
}
/** RBJ biquad, Q = 1/√2 (Butterworth). Applied twice → 4th-order Linkwitz–Riley. */
function biquad(x, type, fc) {
  const w = (2 * Math.PI * fc) / SR;
  const alpha = Math.sin(w) / (2 * Math.SQRT1_2);
  const c = Math.cos(w);
  let b0, b1, b2;
  if (type === 'lp') [b0, b1, b2] = [(1 - c) / 2, 1 - c, (1 - c) / 2];
  else [b0, b1, b2] = [(1 + c) / 2, -(1 + c), (1 + c) / 2];
  const a0 = 1 + alpha;
  const a1 = -2 * c;
  const a2 = 1 - alpha;
  const y = new Float64Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}
const lr4 = (x, type, fc) => biquad(biquad(x, type, fc), type, fc);
function scaleToDb(x, db) {
  let s = 0;
  for (const v of x) s += v * v;
  const rms = Math.sqrt(s / x.length);
  const g = rms > 0 ? 10 ** (db / 20) / rms : 0;
  return x.map((v) => v * g);
}
function add(a, b) {
  const y = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) y[i] = a[i] + (b[i] ?? 0);
  return y;
}
function toInt16(x) {
  const y = new Int16Array(x.length);
  for (let i = 0; i < x.length; i++) y[i] = Math.max(-32768, Math.min(32767, Math.round(x[i] * 32768)));
  return y;
}
function concatI16(parts) {
  const y = new Int16Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { y.set(p, o); o += p.length; }
  return y;
}
const background = (sec, seed) => scaleToDb(white(Math.round(sec * SR), seed), -60);

/** §5.12 synthetic speech: f0 slides 110↔220 Hz at 0.7 Hz, 20 harmonics (1/k), 300–3400 Hz band, 4.5 Hz syllables. */
function synthSpeech(sec, db, { lowpass500 = false } = {}) {
  const n = Math.round(sec * SR);
  const tone = new Float64Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const f0 = 165 + 55 * Math.sin(2 * Math.PI * 0.7 * t);
    phase += (2 * Math.PI * f0) / SR;
    let s = 0;
    for (let k = 1; k <= 20; k++) s += Math.sin(k * phase) / k;
    tone[i] = s;
  }
  let band = lr4(lr4(tone, 'hp', 300), 'lp', 3400);
  if (lowpass500) band = lr4(band, 'lp', 500);
  band = scaleToDb(band, db);
  for (let i = 0; i < n; i++) band[i] *= Math.max(0, Math.sin(2 * Math.PI * 4.5 * (i / SR))) ** 0.7;
  return band;
}
/** Low-passed (< 200 Hz) noise bursts with 50 ms raised-cosine edges. */
function synthSnore(totalSec, bursts, burstSec, periodSec, db, seed) {
  const n = Math.round(totalSec * SR);
  const noise = scaleToDb(lr4(white(n, seed), 'lp', 200), db);
  const env = new Float64Array(n);
  const edge = Math.round(0.05 * SR);
  for (let b = 0; b < bursts; b++) {
    const s0 = Math.round(b * periodSec * SR);
    const len = Math.round(burstSec * SR);
    for (let i = 0; i < len && s0 + i < n; i++) {
      const e = i < edge ? 0.5 - 0.5 * Math.cos((Math.PI * i) / edge) : i > len - edge ? 0.5 - 0.5 * Math.cos((Math.PI * (len - i)) / edge) : 1;
      env[s0 + i] = e;
    }
  }
  return noise.map((v, i) => v * env[i]);
}
/** Full-band noise × irregular envelope (three bumps of different lengths) — turning over. */
function synthRustle(sec, db, seed) {
  const n = Math.round(sec * SR);
  const noise = scaleToDb(white(n, seed), db);
  const bumps = [[0.0, 0.5], [0.6, 1.3], [1.45, 1.95]]; // seconds
  const env = new Float64Array(n);
  for (const [a, b] of bumps) {
    const i0 = Math.round(a * SR), i1 = Math.round(b * SR);
    for (let i = i0; i < i1 && i < n; i++) env[i] = Math.sin((Math.PI * (i - i0)) / (i1 - i0)) ** 0.5;
  }
  return noise.map((v, i) => v * env[i]);
}

const analyzer = new FrameAnalyzer();
const featuresOf = (pcm, coreStart = 0, coreEnd = pcm.length) =>
  computeEventFeatures({ pcm, coreStartSample: coreStart, coreEndSample: coreEnd, floorDb: -60, releaseMarginDb: 6 }, analyzer);

// ---------- U-F: FFT ----------
{
  const fft = new RealFFT512();
  const x = new Float32Array(512);
  for (let i = 0; i < 512; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * 1000 * i) / SR) * HANN_512[i];
  const out = new Float64Array(257);
  fft.powerSpectrum(x, out);
  let kMax = 0;
  for (let k = 1; k < 257; k++) if (out[k] > out[kMax]) kMax = k;
  let maxRel = 0;
  const peak = out[kMax];
  for (let k = 0; k < 257; k++) {
    let re = 0, im = 0;
    for (let i = 0; i < 512; i++) {
      const a = (2 * Math.PI * k * i) / 512;
      re += x[i] * Math.cos(a);
      im -= x[i] * Math.sin(a);
    }
    const ref = re * re + im * im;
    // Relative to the bin itself, with a floor at 1e-12 of the peak so float rounding in near-zero bins doesn't count.
    const rel = Math.abs(out[k] - ref) / Math.max(ref, peak * 1e-12);
    if (rel > maxRel) maxRel = rel;
  }
  check('U-F1 1 kHz sine peaks at bin 32; matches O(n²) DFT within 1e-6', kMax === 32 && maxRel < 1e-6,
    `peak bin ${kMax}, max rel err ${maxRel.toExponential(2)}`);

  const z = new Float64Array(257).fill(7);
  fft.powerSpectrum(new Float32Array(512), z);
  check('U-F2 all-zero input → all bins 0, no NaN', z.every((v) => v === 0));
}

// ---------- U-A: FrameAnalyzer ----------
{
  const saw = new Int16Array(512);
  for (let i = 0; i < 512; i++) {
    const ph = ((150 * i) / SR) % 1;
    saw[i] = Math.round((2 * ph - 1) * 0.3 * 32767);
  }
  const f = analyzer.analyze(saw, 0);
  check('U-A1 150 Hz sawtooth → voiced, f0 145..155', f.voiced && f.f0Hz >= 145 && f.f0Hz <= 155, `voiced ${f.voiced}, f0 ${fmt(f.f0Hz, 1)}`);
}
{
  const flats = [];
  let anyVoiced = false;
  for (let seed = 1; seed <= 20; seed++) {
    const wn = toInt16(scaleToDb(white(512, seed), -20));
    const f = analyzer.analyze(wn, 0);
    flats.push(f.flatness);
    if (f.voiced) anyVoiced = true;
  }
  const mean = flats.reduce((a, b) => a + b, 0) / flats.length;
  // design_M4 asks for > 0.6, but the power-spectrum flatness of white noise is e^-γ ≈ 0.561 in
  // expectation (each periodogram bin is exponential), so one frame lands anywhere in ~0.45–0.62.
  // Test the 20-frame mean instead; harmonic speech sits near 0.05, so 0.5 still separates them.
  check('U-A2 white noise → unvoiced; mean flatness of 20 frames > 0.5 (theory e^-γ ≈ 0.561)', !anyVoiced && mean > 0.5,
    `voiced in any: ${anyVoiced}, flatness min ${fmt(Math.min(...flats))} mean ${fmt(mean)} max ${fmt(Math.max(...flats))}`);
}
{
  const tone = (hz) => {
    const x = new Int16Array(512);
    for (let i = 0; i < 512; i++) x[i] = Math.round(0.3 * 32767 * Math.sin((2 * Math.PI * hz * i) / SR));
    return analyzer.analyze(x, 0);
  };
  const a = tone(200), b = tone(2000);
  check('U-A3 200 Hz: eLow/eTotal > 0.9; 2 kHz: eSpeech/eTotal > 0.9', a.eLow / a.eTotal > 0.9 && b.eSpeech / b.eTotal > 0.9,
    `${fmt(a.eLow / a.eTotal)}, ${fmt(b.eSpeech / b.eTotal)}`);
}
{
  const x = toInt16(scaleToDb(white(512, 99), -30));
  const fl = new Float32Array(512);
  for (let i = 0; i < 512; i++) fl[i] = x[i] / 32768;
  const f = analyzer.analyze(x, 0);
  check('U-A4 db equals msToDb(meanSquare(frame))', f.db === msToDb(meanSquare(fl)), `${f.db} vs ${msToDb(meanSquare(fl))}`);
}

// ---------- U-E: event features ----------
const speechPcm = toInt16(add(synthSpeech(3, -30), background(3, 11)));
const fSpeech = featuresOf(speechPcm);
check('U-E1 speech: mod > 0.45, voiced > 0.4, f0 IQR > 2 st, speechRatio > 0.7',
  fSpeech.syllabicModRatio > 0.45 && fSpeech.voicedFraction > 0.4 && fSpeech.f0IqrSemitones > 2 && fSpeech.speechRatio > 0.7,
  `mod ${fmt(fSpeech.syllabicModRatio)}, voiced ${fmt(fSpeech.voicedFraction)}, IQR ${fmt(fSpeech.f0IqrSemitones, 2)}, speech ${fmt(fSpeech.speechRatio)}, flat ${fmt(fSpeech.flatnessMedian)}`);

const snorePcm = toInt16(add(synthSnore(40, 10, 1.0, 4.0, -30, 21), background(40, 22)));
const fSnore = featuresOf(snorePcm);
check('U-E2 10 snores: bursts 10, interval 3.9..4.1, CV < 0.1, lowRatio > 0.7, mod < 0.25',
  fSnore.burstCount === 10 && fSnore.burstIntervalMedianSec >= 3.9 && fSnore.burstIntervalMedianSec <= 4.1 &&
    fSnore.burstIntervalCv < 0.1 && fSnore.lowRatio > 0.7 && fSnore.syllabicModRatio < 0.25,
  `bursts ${fSnore.burstCount}, interval ${fmt(fSnore.burstIntervalMedianSec, 2)}, CV ${fmt(fSnore.burstIntervalCv)}, low ${fmt(fSnore.lowRatio)}, mod ${fmt(fSnore.syllabicModRatio)}`);

const rustlePcm = toInt16(add(synthRustle(2, -32, 31), background(2, 32)));
const fRustle = featuresOf(rustlePcm);
check('U-E3 rustle: flatnessMedian > 0.5, voicedFraction < 0.1', fRustle.flatnessMedian > 0.5 && fRustle.voicedFraction < 0.1,
  `flat ${fmt(fRustle.flatnessMedian)}, voiced ${fmt(fRustle.voicedFraction)}`);

const shortPcm = concatI16([toInt16(background(0.5, 41)), toInt16(add(scaleToDb(white(3200, 42), -30), background(0.2, 43))), toInt16(background(0.5, 44))]);
const fShort = featuresOf(shortPcm, 8000, 8000 + 3200);
check('U-E4 0.2 s core: activeSec < 0.3, mod null', fShort.activeSec < 0.3 && fShort.syllabicModRatio === null,
  `active ${fmt(fShort.activeSec)}, mod ${fShort.syllabicModRatio}`);
{
  const pre = toInt16(background(5, 51));
  const post = toInt16(background(3, 52));
  const padded = concatI16([pre, speechPcm, post]);
  const fPad = featuresOf(padded, pre.length, pre.length + speechPcm.length);
  let worst = 0, worstKey = '';
  for (const k of Object.keys(fSpeech)) {
    if (k === 'coreSec') continue;
    const a = fSpeech[k], b = fPad[k];
    const rel = a === b ? 0 : a === null || b === null ? Infinity : Math.abs(a - b) / Math.max(Math.abs(a), 1e-300);
    if (rel > worst) { worst = rel; worstKey = k; }
  }
  check('U-E5 5 s / 3 s pre/post-roll: all features except coreSec unchanged (rel < 1e-9)', worst < 1e-9,
    worst ? `worst ${worstKey} ${worst}` : 'identical');
}

// ---------- U-R: rules ----------
const P = DEFAULT_CLASSIFY_PARAMS;
const show = (c) => `${c.cls} conf ${fmt(c.confidence, 2)} talk ${fmt(c.talkScore, 2)} snore ${fmt(c.snoreScore, 2)} ${c.reason}`;
{
  const c = classify(fSpeech, P);
  check('U-R1 speech → talk, confidence ≥ 0.8', c.cls === 'talk' && c.confidence >= 0.8, show(c));
}
{
  const c = classify(fSnore, P);
  check('U-R2 10 snores → snore, confidence ≥ 0.8', c.cls === 'snore' && c.confidence >= 0.8, show(c));
}
{
  const a = classify(fRustle, P), b = classify(fShort, P);
  check('U-R3 rustle and 0.2 s event → other', a.cls === 'other' && b.cls === 'other', `${show(a)} | ${show(b)}`);
}
{
  // One 1 s snore, core includes 0.15 s of background each side.
  const one = toInt16(add(synthSnore(1.3, 1, 1.0, 4.0, -30, 61).map((_, i, arr) => arr[i]), background(1.3, 62)));
  const shifted = concatI16([toInt16(background(0.15, 63)), one]);
  const f = featuresOf(shifted, 0, shifted.length);
  const c = classify(f, P);
  check('U-R4 single snore → not talk', c.cls !== 'talk', `${show(c)}, low ${fmt(f.lowRatio)}, mod ${fmt(f.syllabicModRatio)}, voiced ${fmt(f.voicedFraction)}`);
}
{
  const low = toInt16(add(synthSpeech(3, -30, { lowpass500: true }), background(3, 71)));
  const f = featuresOf(low);
  const c = classify(f, P);
  check('U-R5 speech low-passed at 500 Hz → not snore (safety net)', c.cls !== 'snore',
    `${show(c)}, low ${fmt(f.lowRatio)}, mod ${fmt(f.syllabicModRatio)}, bursts ${f.burstCount}`);
}
check('U-R6 ramp edges: a→0, b→1, null→0, mid linear',
  ramp(1, 1, 3) === 0 && ramp(3, 1, 3) === 1 && ramp(null, 1, 3) === 0 && ramp(2.5, 1, 3) === 0.75,
  `${ramp(1, 1, 3)}, ${ramp(3, 1, 3)}, ${ramp(null, 1, 3)}, ${ramp(2.5, 1, 3)}`);
{
  const c = classify(null, P);
  check('U-R7 classify(null) → other, no-features', c.cls === 'other' && c.reason === 'no-features' && c.confidence === 1, show(c));
}
check('U-R8 DEFAULT_CLASSIFY_PARAMS.dropMinConfidence is 0.8', P.dropMinConfidence === 0.8, String(P.dropMinConfidence));

// ---------- U-V: evaluate ----------
{
  // Hand-counted 10 rows (+1 unsure ignored):
  // label snore: snore×3, other×1        → recall 3/4
  // label talk:  talk×2, snore×1         → recall 2/3
  // label other: other×1, talk×1, snore×1
  // predicted snore = 3+1+1 = 5, wrong 2 → falseRate 0.4; predicted talk = 2+1 = 3, wrong 1 → 1/3
  const rows = [
    ...Array(3).fill({ label: 'snore', cls: 'snore' }), { label: 'snore', cls: 'other' },
    ...Array(2).fill({ label: 'talk', cls: 'talk' }), { label: 'talk', cls: 'snore' },
    { label: 'other', cls: 'other' }, { label: 'other', cls: 'talk' }, { label: 'other', cls: 'snore' },
    { label: 'unsure', cls: 'talk' },
  ];
  const r = evaluate(rows);
  const ok = r.n === 10 && r.matrix.snore.snore === 3 && r.matrix.snore.other === 1 && r.matrix.talk.snore === 1 &&
    r.matrix.other.talk === 1 && Math.abs(r.agreement - 0.6) < 1e-12 &&
    Math.abs(r.falseRate.snore - 0.4) < 1e-12 && Math.abs(r.falseRate.talk - 1 / 3) < 1e-12 &&
    Math.abs(r.recall.snore - 0.75) < 1e-12 && Math.abs(r.recall.talk - 2 / 3) < 1e-12 &&
    r.counts.snore === 4 && r.counts.talk === 3 && r.counts.other === 3;
  const u = evaluate([{ label: 'unsure', cls: 'talk' }, { label: 'unsure', cls: 'snore' }]);
  const okU = u.n === 0 && u.agreement === null && u.falseRate.talk === null && u.recall.snore === null;
  check('U-V1 evaluate matches hand count; all-unsure → n 0, agreement null', ok && okU,
    `n ${r.n}, agree ${fmt(r.agreement, 2)}, false s/t ${fmt(r.falseRate.snore, 2)}/${fmt(r.falseRate.talk, 2)}, recall s/t ${fmt(r.recall.snore, 2)}/${fmt(r.recall.talk, 2)}`);
}

// ---------- U-X: eval-labels.mjs ----------
{
  const dir = mkdtempSync(join(tmpdir(), 'zzz-eval-'));
  try {
    const ev = (id, features, userLabel, extra = {}) => ({
      id, nightId: 'n1', startAt: 1_700_000_000_000, coreStartAt: 1_700_000_000_500, hasAudio: true,
      snoreEpisodeId: null, snoreLike: false, features, classification: classify(features, P), userLabel, ...extra,
    });
    const file = {
      schema: 'zzz-m4/1', exportedAt: 0, featuresVersion: FEATURES_VERSION, classifyParams: P,
      nights: [{
        id: 'n1', mode: 'test', startedAt: 1_700_000_000_000,
        soundEvents: [
          ev('e1', fSpeech, 'talk'),
          ev('e2', fSnore, 'snore'),
          ev('e3', fRustle, 'talk'), // a deliberate mismatch → listed as an error
          ev('e4', fSpeech, 'unsure'),
          ev('e5', { ...fSpeech, version: 99 }, 'talk'),
          ev('e6', fSnore, null),
        ],
        snoreEpisodes: [
          { id: 's1', startAt: 1_700_000_100_000, burstCount: 9, medianIntervalSec: 4, meanLowRatio: 0.8, userLabel: 'snore' },
          { id: 's2', startAt: 1_700_000_200_000, burstCount: 3, medianIntervalSec: 2.5, meanLowRatio: 0.5, userLabel: 'not-snore' },
        ],
      }],
    };
    const p = join(dir, 'export.json');
    writeFileSync(p, JSON.stringify(file));
    const res = spawnSync(process.execPath, [join(here, 'eval-labels.mjs'), p], { encoding: 'utf8' });
    const out = res.stdout ?? '';
    const err = res.stderr ?? '';
    const ok = res.status === 0 && /confusion/i.test(out) && /\bn = 3\b/.test(out) && /version 99/.test(err) && /e3/.test(out);
    check('U-X1 eval-labels.mjs on a minimal zzz-m4/1 file: exit 0, confusion, n = 3, skips version 99', ok,
      `exit ${res.status}${ok ? '' : `\n--- stdout ---\n${out}\n--- stderr ---\n${err}`}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (failed) {
  console.log('unit-classify: FAILED');
  process.exit(1);
}
console.log('unit-classify: all passed');
