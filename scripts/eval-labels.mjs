// Re-run the M4 classifier on exported debug JSON (zzz-m4/1) and compare with the user's labels.
// No audio needed: features were computed on the phone; features → class is a pure function.
//
//   node scripts/eval-labels.mjs [--params <params.json>] <export.json> [<export.json> ...]
//
// --params is shallow-merged over DEFAULT_CLASSIFY_PARAMS (e.g. {"minMargin": 0.2}).
import { readFileSync } from 'node:fs';
import { FEATURES_VERSION } from '../src/classify/event-features.ts';
import { classify, DEFAULT_CLASSIFY_PARAMS } from '../src/classify/rules.ts';
import { evaluate } from '../src/classify/evaluate.ts';

function usage(msg) {
  if (msg) console.error(msg);
  console.error('usage: node scripts/eval-labels.mjs [--params <params.json>] <export.json> [<export.json> ...]');
  process.exit(2);
}

const args = process.argv.slice(2);
let paramsPath = null;
const files = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--params') {
    paramsPath = args[++i];
    if (!paramsPath) usage('--params needs a file');
  } else if (args[i] === '-h' || args[i] === '--help') usage();
  else files.push(args[i]);
}
if (files.length === 0) usage('no input files');

const params = { ...DEFAULT_CLASSIFY_PARAMS, ...(paramsPath ? JSON.parse(readFileSync(paramsPath, 'utf8')) : {}) };

const fmt = (x, d = 2) => (x === null || x === undefined ? '—' : Number(x).toFixed(d));
const pct = (x) => (x === null ? '—' : `${(x * 100).toFixed(1)}%`);
const pad2 = (n) => String(n).padStart(2, '0');
function clock(ms) {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
function offset(ms, start) {
  const s = Math.max(0, Math.round((ms - start) / 1000));
  return `+${Math.floor(s / 3600)}:${pad2(Math.floor((s % 3600) / 60))}:${pad2(s % 60)}`;
}

/** mode as M4's nightMode(): night.mode, else keepSnoreAudio → test, else formal. */
const modeOf = (night) => (night.mode === 'formal' || night.mode === 'test' ? night.mode : night.keepSnoreAudio === true ? 'test' : 'formal');

const rows = []; // { mode, file, event, label, c }
const episodes = []; // { mode, ep }
let skippedVersion = 0;
for (const path of files) {
  let data;
  try {
    data = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    console.error(`error: cannot read ${path}: ${e.message}`);
    process.exit(1);
  }
  if (data.schema !== 'zzz-m4/1' && data.schema !== 'zzz-export/1') { // zzz-export/1 = data.json in the M7 zip
    console.error(`warning: ${path}: schema ${JSON.stringify(data.schema)} is not zzz-m4/1 or zzz-export/1, skipped`);
    continue;
  }
  for (const night of data.nights ?? []) {
    const mode = modeOf(night);
    const nightStart = night.startedAt ?? null;
    for (const ev of night.soundEvents ?? []) {
      if (!ev.features || !ev.userLabel || ev.userLabel === 'unsure') continue;
      if (ev.features.version !== FEATURES_VERSION) {
        skippedVersion++;
        console.error(`warning: ${path}: event ${ev.id} has features version ${ev.features.version}, current is ${FEATURES_VERSION}; skipped`);
        continue;
      }
      rows.push({ mode, path, ev, nightStart, label: ev.userLabel, c: classify(ev.features, params) });
    }
    for (const ep of night.snoreEpisodes ?? []) if (ep.userLabel) episodes.push({ mode, ep });
  }
}

console.log(`classifier ${FEATURES_VERSION}.${params.version}${paramsPath ? ` (params from ${paramsPath})` : ''}`);
console.log(`files ${files.length}; skipped for features version: ${skippedVersion}`);

const CLS = ['snore', 'talk', 'other'];
function report(title, group, eps) {
  console.log(`\n===== ${title} =====`);
  const r = evaluate(group.map((g) => ({ label: g.label, cls: g.c.cls })));
  console.log(`labeled events: n = ${r.n} (snore ${r.counts.snore}, talk ${r.counts.talk}, other ${r.counts.other})`);
  console.log('confusion matrix (rows = your label, columns = auto):');
  console.log(`  ${'label\\auto'.padEnd(10)}${CLS.map((c) => c.padStart(7)).join('')}`);
  for (const l of CLS) console.log(`  ${l.padEnd(10)}${CLS.map((c) => String(r.matrix[l][c]).padStart(7)).join('')}`);
  console.log(`agreement ${pct(r.agreement)}`);
  console.log(`false rate (1 − precision): snore ${pct(r.falseRate.snore)}, talk ${pct(r.falseRate.talk)}   [target < 20% each]`);
  console.log(`recall: snore ${pct(r.recall.snore)}, talk ${pct(r.recall.talk)}`);
  const wrong = group.filter((g) => g.label !== g.c.cls);
  console.log(`misclassified: ${wrong.length}`);
  for (const g of wrong) {
    const f = g.ev.features;
    const t = g.ev.coreStartAt ?? g.ev.startAt;
    const when = typeof t === 'number' ? `${clock(t)}${g.nightStart ? ` (${offset(t, g.nightStart)})` : ''}` : '?';
    console.log(
      `  ${g.ev.id}  ${when}  label ${g.label} → auto ${g.c.cls} (${g.c.reason})  talk ${fmt(g.c.talkScore)} snore ${fmt(g.c.snoreScore)}` +
        `  | active ${fmt(f.activeSec)}s speech ${fmt(f.speechRatio)} low ${fmt(f.lowRatio)} mod ${fmt(f.syllabicModRatio)}` +
        ` voiced ${fmt(f.voicedFraction)} f0IQR ${fmt(f.f0IqrSemitones)} flat ${fmt(f.flatnessMedian)}` +
        ` bursts ${f.burstCount} burst ${fmt(f.burstMedianSec)}s interval ${fmt(f.burstIntervalMedianSec)}s cv ${fmt(f.burstIntervalCv)}` +
        `${g.ev.snoreLike ? ' snoreLike' : ''}${g.ev.snoreEpisodeId ? ' episode-sample' : ''}`,
    );
  }
  const by = { snore: 0, 'not-snore': 0, unsure: 0 };
  for (const { ep } of eps) if (ep.userLabel in by) by[ep.userLabel]++;
  console.log(`snore episodes labeled: snore ${by.snore}, not-snore ${by['not-snore']}, unsure ${by.unsure}`);
  for (const { ep } of eps.filter((e) => e.ep.userLabel === 'not-snore')) {
    console.log(`  not-snore ${ep.id}: burstCount ${ep.burstCount}, medianIntervalSec ${fmt(ep.medianIntervalSec)}, meanLowRatio ${fmt(ep.meanLowRatio)}`);
  }
}

for (const mode of ['test', 'formal']) {
  report(`mode ${mode}`, rows.filter((r) => r.mode === mode), episodes.filter((e) => e.mode === mode));
}
report('all modes', rows, episodes);
