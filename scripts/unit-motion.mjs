// M5 unit tests: actigraphy on synthetic 50 Hz samples (design_M5 §7.1).
// Imports TypeScript sources directly via Node type stripping.
import { EpochAccumulator, decideQuality } from '../src/motion/actigraphy.ts';
import { DEFAULT_MOTION_PARAMS } from '../src/motion/params.ts';

let failed = false;
function check(name, cond, info = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${info ? ` (${info})` : ''}`);
  if (!cond) failed = true;
}

// Deterministic Gaussian noise (mulberry32 + Box–Muller).
function rng(seed) {
  let a = seed >>> 0;
  const u = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return () => Math.sqrt(-2 * Math.log(u() + 1e-12)) * Math.cos(2 * Math.PI * u());
}

const G = 9.81;
const P = DEFAULT_MOTION_PARAMS;
const DT = 20; // ms → 50 Hz

/**
 * Runs seconds [0, sec) through an accumulator. gen(tSec) returns [x,y,z] or null (no event).
 * tick() runs every second like the recorder does; finishAt closes the rest.
 */
function run(sec, gen, { finishAt = sec, seed = 1, params = P } = {}) {
  const noise = rng(seed);
  const acc = new EpochAccumulator('s', 1_000_000, 0, params);
  const out = [];
  for (let t = 0; t < sec * 1000; t += DT) {
    const v = gen(t / 1000, noise);
    if (v) out.push(...acc.addSample(v[0], v[1], v[2], t));
    if (t % 1000 === 0) out.push(...acc.tick(t));
  }
  out.push(...acc.finish(finishAt * 1000));
  return out;
}
const still = (n, sigma = 0.005) => [n() * sigma, n() * sigma, G + n() * sigma];

// A1 still
{
  const e = run(60, (_, n) => still(n));
  check('A1 two epochs', e.length === 2, `got ${e.length}`);
  check('A1 low activity', e.every((x) => x.activity < 0.05), e.map((x) => x.activity.toFixed(4)).join(','));
  check('A1 no active seconds', e.every((x) => x.activeSec === 0));
  check('A1 rate 49–51 Hz', e.every((x) => x.rateHz >= 49 && x.rateHz <= 51), e.map((x) => x.rateHz.toFixed(2)).join(','));
}

// A2 movement 35–37 s
const wiggle = (flip) => (t, n) => {
  const s = still(n);
  if (flip) s[2] = -s[2];
  if (t >= 35 && t < 37) s[2] += (flip ? -1 : 1) * Math.sin(2 * Math.PI * 2 * t);
  return s;
};
let a2activity = 0;
{
  const e = run(60, wiggle(false));
  const [e0, e1] = e;
  a2activity = e1.activity;
  check('A2 quiet epoch 0', e0.activeSec === 0);
  check('A2 epoch 1 activeSec 2–3', e1.activeSec >= 2 && e1.activeSec <= 3, `got ${e1.activeSec}`);
  check('A2 epoch 1 activity > 0.5', e1.activity > 0.5, e1.activity.toFixed(3));
  check('A2 epoch 1 peak > 0.5', e1.peak > 0.5, e1.peak.toFixed(3));
}

// A3 flip gravity from z to x at 40 s
{
  const e = run(60, (t, n) => {
    const s = still(n);
    return t < 40 ? s : [s[2], s[1], s[0]];
  });
  check('A3 tilt 80–100°', e[1].tiltDeg !== null && e[1].tiltDeg >= 20 && e[0].tiltDeg === null, `epoch1 ${e[1].tiltDeg?.toFixed(1)}`);
  // Epoch 1 mixes 10 s of z and 20 s of x, so compare against a third epoch fully on x.
  const e3 = run(90, (t, n) => {
    const s = still(n);
    return t < 30 ? s : [s[2], s[1], s[0]];
  });
  check('A3 full flip 80–100°', e3[1].tiltDeg >= 80 && e3[1].tiltDeg <= 100, `${e3[1].tiltDeg.toFixed(1)}`);
}

// A4 upside down gives the same activity
{
  const e = run(60, wiggle(true));
  const diff = Math.abs(e[1].activity - a2activity) / a2activity;
  check('A4 orientation-independent (<5%)', diff < 0.05, `${(diff * 100).toFixed(2)}%`);
}

// A5 gap 30–90 s
{
  const e = run(120, (t, n) => (t >= 30 && t < 90 ? null : still(n)));
  check('A5 four epochs', e.length === 4, `got ${e.length}`);
  check('A5 empty epochs 1,2', e[1].samples === 0 && e[2].samples === 0);
  check('A5 epoch 3 normal', e[3].samples > 1400 && e[3].activeSec === 0, `samples ${e[3].samples}, active ${e[3].activeSec}`);
  check('A5 reset sample not counted', e[3].samples === 1499, `samples ${e[3].samples}`);
  check('A6 gap → binary', decideQuality(e, P) === 'binary');
}

// A6 quality
{
  const full = run(90, (_, n) => still(n));
  check('A6 50 Hz → full', decideQuality(full, P) === 'full');
  const slow = (() => {
    const noise = rng(2);
    const acc = new EpochAccumulator('s', 0, 0, P);
    const out = [];
    for (let t = 0; t < 90_000; t += 125) out.push(...acc.addSample(...still(noise), t));
    out.push(...acc.finish(90_000));
    return out;
  })();
  check('A6 8 Hz → binary', decideQuality(slow, P) === 'binary', slow.map((x) => x.rateHz.toFixed(1)).join(','));
  const empty = run(60, () => null);
  check('A6 empty → none', decideQuality(empty, P) === 'none');
}

// A7 duplicate timestamps and nulls
{
  const acc = new EpochAccumulator('s', 0, 0, P);
  const noise = rng(3);
  acc.addSample(...still(noise), 0);
  acc.addSample(...still(noise), 0);
  acc.addSample(NaN, 0, G, 20);
  acc.addSample(null, 0, G, 40);
  for (let t = 60; t < 30_000; t += DT) acc.addSample(...still(noise), t);
  const [e] = acc.finish(30_000);
  const ok = e && Object.values(e).every((v) => v === null || typeof v === 'string' || Number.isFinite(v));
  check('A7 no NaN, bad samples dropped', ok && e.samples < 1500, e ? `samples ${e.samples}` : 'no epoch');
}

// A8 finish at 45 s
{
  const e = run(45, (_, n) => still(n), { finishAt: 45 });
  const last = e.at(-1);
  check('A8 last epoch 15 s', e.length === 2 && last.endAt - last.startAt === 15_000, `${last.endAt - last.startAt}`);
}

// Hidden time accounting
{
  const acc = new EpochAccumulator('s', 0, 0, P);
  acc.setHidden(true, 20_000);
  const a = acc.tick(30_000);
  acc.setHidden(false, 40_000);
  const b = acc.finish(60_000);
  check('hidden ms split across epochs', a[0].hiddenMs === 10_000 && b[0].hiddenMs === 10_000, `${a[0]?.hiddenMs}/${b[0]?.hiddenMs}`);
}

if (failed) {
  console.log('unit-motion: FAILED');
  process.exit(1);
}
console.log('unit-motion: all passed');
