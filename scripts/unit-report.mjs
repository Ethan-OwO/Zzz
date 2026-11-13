// M6 / M7 unit tests: report core, WAV layout, report.md / prompt.md (design_M6-M7 §9.1).
// Imports TypeScript sources directly via Node type stripping; no browser.
import { DEFAULT_PARAMS } from '../src/detect/params.ts';
import { buildReport } from '../src/report/build.ts';
import { unionMs } from '../src/report/classes.ts';
import { fmtClock, fmtDur } from '../src/report/format.ts';
import { summarizeMotion } from '../src/report/motion.ts';
import { audioParts, includeAudio } from '../src/export/audio-policy.ts';
import { planWav, wavHeader } from '../src/export/wav.ts';
import { renderReportMd } from '../src/export/report-md.ts';
import { renderPromptMd } from '../src/export/prompt-md.ts';
import { ZH_TW } from '../src/export/strings.ts';
import { DEFAULT_MOTION_PARAMS } from '../src/motion/params.ts';

let failed = false;
function check(name, cond, info = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${info ? ` (${info})` : ''}`);
  if (!cond) failed = true;
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------------------------------------------------------------------------
// Fixture: night 23:00–07:00 at UTC+08:00, heartbeat every 60 s.
const TZ = 480;
const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 13, 15, 0, 0); // 2026-11-13 23:00 +08:00
const STOP = T0 + 8 * 60 * MIN;              // 07:00
const CAL_AT = T0 + MIN;                     // detection starts 23:01
const at = (hh, mm, ss = 0) => {             // local clock → ms (hours < 12 are the next morning)
  const dayOff = hh < 12 ? 1 : 0;
  return Date.UTC(2026, 10, 13 + dayOff, hh - 8, mm, ss);
};
const FULL = (60 * 16000) / 512; // 1875 frames per heartbeat

function heartbeats(sessionId, from, to, over = {}) {
  const out = [];
  for (let t = from + MIN, seq = 0; t <= to; t += MIN, seq++) {
    out.push({ sessionId, seq, t, perfNow: 0, frames: FULL, zeroFrames: 0, noInputQuanta: 0,
      minDb: -70, meanDb: -60, maxDb: -50, ctxState: 'running', ctxTime: 0, wakeLock: 'held',
      visibility: 'visible', trackReadyState: 'live', trackMuted: false, audioSessionState: null,
      battery: null, floorDb: -62, soundEventCount: 0, ...(over[seq] ?? {}) });
  }
  return out;
}

function session(id, from, to, { stopped = true, hbOver = {}, events = [], hbFilter = () => true } = {}) {
  return { id, nightId: 'n1', scenario: 'night', startedAt: from, stoppedAt: stopped ? to : null,
    heartbeatIntervalSec: 60, userAgent: 'test', ctxSampleRate: 48000, ctxBaseLatency: null,
    trackSettings: null, storagePersisted: null,
    heartbeats: heartbeats(id, from, to, hbOver).filter(hbFilter), events };
}

function night(over = {}) {
  return { id: 'n1', startedAt: T0, stoppedAt: STOP, status: 'stopped',
    calibration: { floorDb: -62, quietSpreadDb: 3, speechDb: -35, triggerMarginDb: 11, releaseMarginDb: 7,
      status: 'ok', userAdjustDb: 0, at: CAL_AT },
    mode: 'formal', audioSecUsed: 0, paramsVersion: 1, params: { ...DEFAULT_PARAMS }, ...over };
}

/** A sound event whose core is [coreStart, coreStart + coreSec]; 5 s pre-roll, 3 s post-roll. */
function ev(id, coreStart, coreSec, over = {}) {
  const startAt = coreStart - 5000;
  const endAt = coreStart + coreSec * 1000 + 3000;
  return { id, nightId: 'n1', sessionId: 's1', startAt, endAt, coreStartAt: coreStart, coreEndAt: coreStart + coreSec * 1000,
    peakDb: -30, floorDbAtStart: -62, endReason: 'released', continuesFrom: null, hasAudio: true,
    audioIncomplete: false, sampleCount: ((endAt - startAt) / 1000) * 16000, snoreEpisodeId: null, snoreLike: false, ...over };
}
const cls = (c, confidence = 0.9) => ({ cls: c, confidence, talkScore: 0, snoreScore: 0, reason: c, classifierVersion: '1.1' });

function episode(id, from, to, over = {}) {
  return { id, nightId: 'n1', sessionId: 's1', startAt: from, endAt: to, burstCount: 120, medianIntervalSec: 4,
    meanPeakDb: -40, meanLowRatio: 0.7, endReason: 'quiet', ...over };
}

function input({ sessions = [session('s1', T0, STOP)], soundEvents = [], snoreEpisodes = [], motion = [], n = {} } = {}) {
  return { night: night(n), sessions, soundEvents, snoreEpisodes, motion, generatedAt: STOP + MIN, tzOffsetMin: TZ };
}

const codes = (r) => r.notes.map((x) => x.code);

// ---------------------------------------------------------------------------
console.log('— R: report core (M6 T1)');
{
  const r = buildReport(input());
  check('R1 monitoredMs = detect start .. stop', r.monitoredMs === STOP - CAL_AT, `${r.monitoredMs}`);
  check('R1 unmonitoredMs = 0, no items', r.unmonitoredMs === 0 && r.items.length === 0 && r.gaps.length === 0);
  check('R1 notes = [not-medical] (formal)', eq(codes(r), ['not-medical']), codes(r).join());
  check('R1 tz / detectStart / stoppedAt', r.tzOffsetMin === TZ && r.detectStartAt === CAL_AT && r.stoppedAt === STOP);
  check('R1 floor has one point per heartbeat', r.floor.length === 480 && r.floor[0].floorDb === -62);
  check('R1 calibration = formal trigger', r.calibration?.triggerMarginDb === 11 && r.calibration.speechDb === -35);
  const t = buildReport(input({ n: { mode: 'test' } }));
  check('R1b test mode: test-mode note first, margin lowered 3 dB', codes(t)[0] === 'test-mode' && t.calibration?.triggerMarginDb === 8);
}
{
  const mid1 = at(2, 0);
  const mid2 = at(2, 20);
  const r = buildReport(input({ sessions: [session('s1', T0, mid1, { stopped: false }), session('s2', mid2, STOP)] }));
  check('R2 one between-sessions gap of 20 min',
    r.gaps.length === 1 && r.gaps[0].reason === 'between-sessions' && r.gaps[0].endAt - r.gaps[0].startAt === 20 * MIN,
    JSON.stringify(r.gaps));
  check('R2 monitored + unmonitored = detect window', r.monitoredMs + r.unmonitoredMs === STOP - CAL_AT);
  check('R2 gaps note n=1 min=20', eq(r.notes.find((x) => x.code === 'gaps'), { code: 'gaps', n: 1, min: 20 }));
}
{
  const low = buildReport(input({ sessions: [session('s1', T0, STOP, { hbOver: { 100: { frames: 100 } } })] }));
  const g = low.gaps[0];
  check('R3 frames=100 → one 60 s low-frames gap', low.gaps.length === 1 && g.reason === 'low-frames' && g.endAt - g.startAt === MIN, JSON.stringify(low.gaps));
  const ok = buildReport(input({ sessions: [session('s1', T0, STOP, { hbOver: { 100: { frames: 1000 } } })] }));
  check('R3 frames=1000 → no gap', ok.gaps.length === 0);
  const zeros = buildReport(input({ sessions: [session('s1', T0, STOP, { hbOver: { 100: { zeroFrames: 1800 } } })] }));
  check('R3b mostly zero frames → low-frames gap', zeros.gaps.length === 1 && zeros.gaps[0].reason === 'low-frames');
}
{
  // Heartbeats seq 100..103 missing: seq 99 at T0+100 min, seq 104 at T0+105 min → 5 min apart.
  const r = buildReport(input({ sessions: [session('s1', T0, STOP, { hbFilter: (h) => h.seq < 100 || h.seq > 103 })] }));
  const g = r.gaps[0];
  check('R4 5-min heartbeat silence → no-heartbeat gap of 4 min',
    r.gaps.length === 1 && g.reason === 'no-heartbeat' && g.endAt - g.startAt === 4 * MIN && g.startAt === T0 + 101 * MIN,
    JSON.stringify(r.gaps));
}
{
  const tg = { sessionId: 's1', t: at(3, 0), type: 'timer-gap', detail: '5000' };
  const r = buildReport(input({ sessions: [session('s1', T0, STOP, { events: [tg] })] }));
  check('R5 5 s timer-gap is dropped (< 10 s)', r.gaps.length === 0);
  const tg2 = { ...tg, detail: '90000' };
  const r2 = buildReport(input({ sessions: [session('s1', T0, STOP, { events: [tg2] })] }));
  check('R5b 90 s timer-gap is kept', r2.gaps.length === 1 && r2.gaps[0].reason === 'timer-gap' && r2.gaps[0].endAt - r2.gaps[0].startAt === 90_000);
}
{
  const base = at(1, 0);
  const a = ev('a', base, 60, { endReason: 'split', classification: cls('talk') });
  const b = ev('b', base + 60_000, 60, { endReason: 'split', continuesFrom: 'a', classification: cls('snore') });
  const c = ev('c', base + 120_000, 20, { continuesFrom: 'b', classification: cls('other') });
  const r = buildReport(input({ soundEvents: [c, a, b] }));
  check('R6 three continuesFrom parts → one item', r.items.length === 1 && eq(r.items[0].partIds, ['a', 'b', 'c']));
  check('R6 class from the first part', r.items[0].cls === 'talk' && r.items[0].source === 'auto');
  check('R6 core spans the chain', r.items[0].coreStartAt === base && r.items[0].coreEndAt === base + 140_000);
}
{
  const e1 = ev('e1', at(1, 0), 5, { classification: cls('talk', 0.7), userLabel: 'other' });
  const e2 = ev('e2', at(2, 0), 5, { classification: cls('talk', 0.7), userLabel: 'unsure' });
  const r = buildReport(input({ soundEvents: [e1, e2] }));
  const [i1, i2] = r.items;
  check('R7 user other over auto talk', i1.cls === 'other' && i1.source === 'user' && i1.autoCls === 'talk' && i1.userLabel === 'other');
  check('R7 unsure → auto talk', i2.cls === 'talk' && i2.source === 'auto' && i2.confidence === 0.7 && i2.userLabel === 'unsure');
}
{
  const r = buildReport(input({ soundEvents: [ev('e1', at(1, 0), 5)] }));
  check('R8 no classification → unclassified', r.items[0].cls === 'unclassified' && r.items[0].source === 'none');
  check('R8 unclassified note', eq(r.notes.find((x) => x.code === 'unclassified'), { code: 'unclassified', n: 1 }));
  check('R8 note order', eq(codes(r), ['unclassified', 'not-medical']));
}
{
  const ep = episode('ep1', at(2, 0), at(2, 20));
  const inside = ev('in', at(2, 5), 10, { classification: cls('snore'), snoreEpisodeId: 'ep1', hasAudio: false, sampleCount: 0 });
  const outside = ev('out', at(3, 0), 30, { classification: cls('snore') });
  const r = buildReport(input({ soundEvents: [inside, outside], snoreEpisodes: [ep], n: { mode: 'test' } }));
  const s = r.totals.snore;
  check('R9 snore union = 20 min 30 s', s.unionMs === 20 * MIN + 30_000 && s.totalMs === s.unionMs, `${s.unionMs}`);
  check('R9 count = 1 episode + 1 outside event', s.count === 2 && s.episodes === 1, `count=${s.count}`);
  check('R9 unionMs helper', unionMs([[5, 10], [0, 3], [2, 6]]) === 10 && unionMs([[0, 2], [5, 6]]) === 3 && unionMs([]) === 0);
  check('R9 dropped snore sample → audio dropped-snore', r.items.find((i) => i.id === 'in').audio === 'dropped-snore');
}
{
  const evs = [ev('5s', at(1, 0), 5), ev('50a', at(1, 10), 50), ev('20s', at(1, 20), 20), ev('50b', at(1, 30), 50)];
  const r = buildReport(input({ soundEvents: evs, snoreEpisodes: [episode('ep', at(4, 0), at(5, 0))] }));
  check('R10 longestIds = [50a, 50b, 20s], no episode', eq(r.longestIds, ['50a', '50b', '20s']), r.longestIds.join());
}
{
  const ms = (idx, activeSec, samples = 1500) => ({ sessionId: 's1', idx, startAt: T0 + idx * 30_000, endAt: T0 + (idx + 1) * 30_000,
    samples, rateHz: 50, activity: activeSec * 2, peak: 1, activeSec, tiltDeg: null, hiddenMs: 0 });
  const epochs = [];
  for (let i = 0; i <= 244; i++) epochs.push(ms(i, i === 1 ? 2 : i === 3 ? 3 : i === 244 ? 2 : 0, i === 10 ? 0 : 1500));
  const msess = { sessionId: 's1', placement: 'bed', permission: 'granted', startedAt: T0, stoppedAt: STOP,
    reportedIntervalMs: 20, hasAcceleration: true, firstEventDelayMs: 100, quality: 'full', paramsVersion: 1,
    params: DEFAULT_MOTION_PARAMS, epochs };
  const r = buildReport(input({ motion: [msess] }));
  const m = r.motion;
  check('R11 one restless period from the first two active epochs',
    m.restless.length === 1 && m.restless[0].activeEpochs === 2 && m.restless[0].startAt === T0 + 30_000 && m.restless[0].endAt === T0 + 120_000,
    JSON.stringify(m.restless));
  check('R11 lone active epoch 2 h later is not a period', m.activeEpochs === 3);
  check('R11 samples=0 → sensed=false', m.epochs[10].sensed === false && m.sensedEpochs === 244);
  check('R11 placement bed', r.placement === 'bed');

  const bin = { ...msess, sessionId: 's2', quality: 'binary', epochs: [] };
  check('R12 full + binary → binary', summarizeMotion([msess, bin]).quality === 'binary');
  const nullQ = { ...msess, quality: null, epochs: epochs.map((e) => ({ ...e, samples: 0 })) };
  check('R12b quality null judged from epochs → none, no restless', (() => { const s = summarizeMotion([nullQ]); return s.quality === 'none' && s.restless.length === 0; })());
  const none = buildReport(input());
  check('R12 no motion → motion=null, nightstand', none.motion === null && none.placement === 'nightstand');
  const mixed = buildReport(input({ sessions: [session('s1', T0, at(2, 0)), session('s2', at(2, 1), STOP)], motion: [msess] }));
  check('R12c motion on one of two sessions → mixed', mixed.placement === 'mixed');
}
{
  const t = at(2, 13, 5);
  const before = [fmtClock(t, TZ), fmtClock(t, TZ, true)];
  const oldTz = process.env.TZ;
  process.env.TZ = 'America/New_York';
  const after = [fmtClock(t, TZ), fmtClock(t, TZ, true)];
  process.env.TZ = oldTz;
  check('R13 fmtClock ignores the runtime zone', eq(before, ['02:13', '02:13:05']) && eq(after, before), after.join());
  check('R13b fmtDur', fmtDur(45_000) === '45 秒' && fmtDur(12 * MIN) === '12 分' && fmtDur(65 * MIN) === '1 小時 05 分',
    [fmtDur(45_000), fmtDur(12 * MIN), fmtDur(65 * MIN)].join(' / '));
}

// ---------------------------------------------------------------------------
console.log('— W: WAV and audio policy (M7 T1)');
{
  const h = wavHeader(320000);
  const v = new DataView(h.buffer);
  const str = (o) => String.fromCharCode(...h.slice(o, o + 4));
  check('W1 header length 44', h.length === 44);
  check('W1 RIFF / WAVE / fmt / data tags', str(0) === 'RIFF' && str(8) === 'WAVE' && str(12) === 'fmt ' && str(36) === 'data');
  check('W1 RIFF size = 36 + data', v.getUint32(4, true) === 36 + 320000);
  check('W1 PCM mono 16 kHz, block align 2, 16 bit',
    v.getUint16(20, true) === 1 && v.getUint16(22, true) === 1 && v.getUint32(24, true) === 16000
    && v.getUint32(28, true) === 32000 && v.getUint16(32, true) === 2 && v.getUint16(34, true) === 16);
  check('W1 data size', v.getUint32(40, true) === 320000);
}
/** Events of W2: A (1 part × 16000), B (2 parts × 8000), C (no audio). */
function w2Input(mode = 'test') {
  const A = ev('A', at(1, 0), 0.2, { sampleCount: 16000, classification: cls('talk') });
  const B1 = ev('B1', at(2, 0), 0.1, { sampleCount: 8000, endReason: 'split', classification: cls('other') });
  const B2 = ev('B2', at(2, 0, 30), 0.1, { sampleCount: 8000, continuesFrom: 'B1' });
  const C = ev('C', at(3, 0), 1, { hasAudio: false, sampleCount: 0, classification: cls('other') });
  return input({ soundEvents: [A, B1, B2, C], snoreEpisodes: [episode('ep', at(4, 0), at(4, 10))], n: { mode } });
}
let w2;
{
  const inp = w2Input();
  const r = buildReport(inp);
  const plan = planWav(r, audioParts(inp.soundEvents, 'test', { dropMinConfidence: 0.8 }));
  w2 = { r, plan };
  const [a, b] = plan.clips;
  check('W2 two clips', plan.clips.length === 2, JSON.stringify(plan.clips));
  check('W2 A = 0–1.000 s', a.itemId === 'A' && a.startSec === 0 && a.endSec === 1);
  check('W2 B = 2.000–3.000 s, both parts', b.itemId === 'B1' && b.startSec === 2 && b.endSec === 3 && eq(b.partIds, ['B1', 'B2']));
  check('W2 totalSamples = 48000, dataBytes = 96000', plan.totalSamples === 48000 && plan.dataBytes === 96000);
  check('W2 audioSecTotal = 2 s', r.audioSecTotal === 2);
}
{
  const p = { dropMinConfidence: 0.8 };
  const snore = ev('s', at(1, 0), 5, { classification: cls('snore', 0.9) });
  check('W3 formal + confident snore → no audio', includeAudio(snore, 'formal', p) === false);
  check('W3 formal + user talk → audio', includeAudio({ ...snore, userLabel: 'talk' }, 'formal', p) === true);
  check('W3 test mode → audio', includeAudio(snore, 'test', p) === true);
  check('W3 formal + low-confidence snore → audio', includeAudio({ ...snore, classification: cls('snore', 0.5) }, 'formal', p) === true);
  check('W3 formal + episode sample → no audio', includeAudio(ev('x', at(1, 0), 5, { snoreEpisodeId: 'ep' }), 'formal', p) === false);
  const r = buildReport(input({ soundEvents: [snore] }));
  check('W3 report marks still-stored formal snore as dropped-snore', r.items[0].audio === 'dropped-snore' && r.audioSecTotal === 0
    && codes(r).includes('dropped-snore'));
}
{
  const r = buildReport(input({ soundEvents: [ev('C', at(3, 0), 1, { hasAudio: false, sampleCount: 0 })] }));
  const plan = planWav(r, new Map());
  check('W4 nothing to place → clips=[], dataBytes=0', plan.clips.length === 0 && plan.dataBytes === 0 && plan.totalSamples === 0);
  const over = buildReport(input({ soundEvents: [ev('C', at(3, 0), 1, { hasAudio: false, sampleCount: 0 })], n: { audioSecUsed: 7200 } }));
  check('W4b over budget → audio over-budget + note', over.items[0].audio === 'over-budget'
    && eq(over.notes.find((x) => x.code === 'over-budget'), { code: 'over-budget', n: 1, hours: 2 }));
}

// ---------------------------------------------------------------------------
console.log('— M: report.md / prompt.md (M7 T1)');
{
  const md = renderReportMd(w2.r, w2.plan);
  const lines = md.split('\n');
  check('M1 locale comment first', lines[0] === '<!-- locale: zh-TW -->');
  check('M1 title with night date', lines[1] === '# Zzz 睡眠聲音報告 — 2026-11-13 晚上', lines[1]);
  check('M1 header lines', md.includes('- 監測：23:01 – 07:00') && md.includes('時區 UTC+08:00') && md.includes('門檻 +8.0 dB'));
  const summaryRows = ['打呼', '說話', '其他', '未分類'].filter((c) => lines.some((l) => l.startsWith(`| ${c} | `)));
  check('M1 summary table has four rows', summaryRows.length === 4, summaryRows.join());
  const rowA = lines.find((l) => l.startsWith('| 1 | '));
  const rowB = lines.find((l) => l.startsWith('| 2 | '));
  const rowC = lines.find((l) => l.startsWith('| 3 | '));
  const rowEp = lines.find((l) => l.startsWith('| 4 | '));
  check('M1 A position 0.000–1.000 s', rowA?.endsWith('| 0.000–1.000 s |'), rowA);
  check('M1 B position 2.000–3.000 s (as W2)', rowB?.endsWith('| 2.000–3.000 s |'), rowB);
  check('M1 C and episode: 無音訊', rowC?.endsWith('| 無音訊 |') && rowEp?.endsWith('| 無音訊 |'), `${rowC} / ${rowEp}`);
  check('M1 files section mentions night.wav', md.includes('`night.wav`'));
  const placeholder = /undefined|NaN|\[object/.test(md);
  check('M1 no undefined / NaN in output', !placeholder);
}
{
  const evs = [];
  for (let i = 0; i < 301; i++) evs.push(ev(`e${i}`, at(1, 0) + i * 20_000, 2, { classification: cls('other') }));
  const inp = input({ soundEvents: evs });
  const r = buildReport(inp);
  const md = renderReportMd(r, planWav(r, audioParts(inp.soundEvents, 'formal', { dropMinConfidence: 0.8 })));
  const lines = md.split('\n');
  const rows = lines.filter((l) => /^\| \d+ \| /.test(l));
  check('M2 301 events → 300 rows', rows.length === 300, `${rows.length}`);
  check('M2 truncation line points to data.json', md.includes('其餘見 data.json'));
}
{
  const r = buildReport(input({ soundEvents: [ev('C', at(3, 0), 1, { hasAudio: false, sampleCount: 0 })] }));
  const empty = { clips: [], totalSamples: 0, dataBytes: 0 };
  const p = renderPromptMd(r, empty);
  check('M3 no clips → prompt.md never says night.wav', !p.includes('night.wav'));
  check('M3b no clips → report.md never says night.wav position file line', !renderReportMd(r, empty).includes('`night.wav`'));
  const withAudio = renderPromptMd(w2.r, w2.plan);
  check('M3c with clips → prompt mentions night.wav and the no-audio fallback',
    withAudio.includes('night.wav') && withAudio.includes('如果你無法播放或分析 night.wav'));
}
{
  const medical = '不是醫療檢查';
  const md = renderReportMd(w2.r, w2.plan);
  const p = renderPromptMd(w2.r, w2.plan);
  check('M4 report.md has the medical note', md.includes(ZH_TW.note({ code: 'not-medical' }, String)));
  check('M4 prompt.md has the medical disclaimer', p.includes(medical) && p.includes('請不要做醫療診斷'));
}

if (failed) {
  console.error('unit-report: FAILED');
  process.exit(1);
}
console.log('unit-report: all passed');
