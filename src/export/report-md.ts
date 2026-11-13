// NightReport → report.md (design_M6-M7 §6.3). Pure; every word comes from ExportStrings.
import { classLabel, fmtClock, fmtDb, fmtDbDelta, fmtDur, fmtNightDate, fmtTz } from '../report/format.ts';
import type { NightReport, ReportItem } from '../report/types.ts';
import { ZH_TW, type ExportStrings } from './strings.ts';
import type { WavPlan } from './wav.ts';

export const MAX_MD_EVENTS = 300;
const FLOOR_BUCKET_MS = 30 * 60_000;

const row = (cells: ReadonlyArray<string | number>) => `| ${cells.join(' | ')} |`;
const table = (head: readonly string[], rows: Array<ReadonlyArray<string | number>>) =>
  [row(head), row(head.map(() => '---')), ...rows.map(row)];

export function renderReportMd(report: NightReport, plan: WavPlan, s: ExportStrings = ZH_TW): string {
  const tz = report.tzOffsetMin;
  const clock = (t: number, sec = false) => fmtClock(t, tz, sec);
  const dur = (ms: number) => fmtDur(ms, s);
  const L: string[] = [];

  L.push(`<!-- locale: ${s.locale} -->`);
  L.push(`# ${s.mdTitle(fmtNightDate(report.startedAt, tz))}`);
  L.push(s.mdMonitored(clock(report.detectStartAt), clock(report.stoppedAt), dur(report.monitoredMs),
    report.unmonitoredMs > 0 ? dur(report.unmonitoredMs) : null));
  L.push(s.mdModeLine(s.modeLabel[report.mode], s.placementLabel[report.placement], fmtTz(tz)));
  const c = report.calibration;
  L.push(c ? s.mdCalibration(fmtDb(c.floorDb), fmtDb(c.speechDb), fmtDbDelta(c.triggerMarginDb)) : s.mdNoCalibration);

  const t = report.totals;
  L.push('', `## ${s.hSummary}`, '');
  L.push(...table(s.thSummary, [
    [classLabel('snore', s), t.snore.count, dur(t.snore.totalMs)],
    [classLabel('talk', s), t.talk.count, dur(t.talk.totalMs)],
    [classLabel('other', s), t.other.count, dur(t.other.totalMs)],
    [classLabel('unclassified', s), t.unclassified.count, dur(t.unclassified.totalMs)],
  ]));

  L.push('', `## ${s.hNotes}`, '');
  const fmtMin = (min: number) => fmtDur(min * 60_000, s);
  for (const n of report.notes) L.push(`- ${s.note(n, fmtMin)}`);

  L.push('', `## ${s.hGaps}`, '');
  if (report.gaps.length === 0) L.push(s.noGaps);
  else L.push(...table(s.thGaps, report.gaps.map((g) =>
    [clock(g.startAt, true), clock(g.endAt, true), dur(g.endAt - g.startAt), s.gapReason[g.reason]])));

  if (report.motion) {
    L.push('', `## ${s.hRestless}`, '', s.restlessDisclaimer, '');
    if (report.motion.quality === 'none') L.push(s.motionInsufficient);
    else if (report.motion.restless.length === 0) L.push(s.noRestless);
    else L.push(...table(s.thRestless, report.motion.restless.map((r) =>
      [clock(r.startAt), clock(r.endAt), dur(r.endAt - r.startAt), r.activeEpochs])));
  }

  L.push('', `## ${s.hEvents}`, '');
  if (report.items.length === 0) L.push(s.noEvents);
  else {
    const pos = new Map(plan.clips.map((cl) => [cl.itemId, `${cl.startSec.toFixed(3)}–${cl.endSec.toFixed(3)} s`]));
    const shown = report.items.slice(0, MAX_MD_EVENTS);
    L.push(...table(s.thEvents, shown.map((it, i) => eventRow(it, i + 1, pos.get(it.id) ?? s.noAudio, clock, dur, s))));
    if (report.items.length > MAX_MD_EVENTS) L.push('', s.eventsTruncated(MAX_MD_EVENTS, report.items.length));
  }

  L.push('', `## ${s.hFloor}`, '');
  const buckets = floorBuckets(report);
  if (buckets.length === 0) L.push(s.noFloor);
  else L.push(...table(s.thFloor, buckets.map((b) => [clock(b.t), fmtDb(b.db)])));

  L.push('', `## ${s.hFiles}`, '');
  if (plan.clips.length > 0) L.push(s.fileWav);
  L.push(s.fileJson, s.filePrompt, '');
  return L.join('\n');
}

function eventRow(
  it: ReportItem, n: number, pos: string,
  clock: (t: number, sec?: boolean) => string, dur: (ms: number) => string, s: ExportStrings,
): Array<string | number> {
  const isEvent = it.kind === 'event';
  const start = isEvent ? it.coreStartAt! : it.startAt;
  const len = isEvent ? it.coreEndAt! - it.coreStartAt! : it.endAt - it.startAt;
  const cls = !isEvent && it.cls === 'snore' && it.burstCount !== null ? s.episodeBursts(it.burstCount) : classLabel(it.cls, s);
  const label = it.userLabel === null ? '–' : (s.userLabel[it.userLabel] ?? it.userLabel);
  return [n, clock(start, true), dur(len), cls, it.confidence === null ? '–' : it.confidence.toFixed(2), label, fmtDb(it.peakDb), pos];
}

/** Median floorDb per local half hour (aligned to :00 / :30 of the report's zone). */
export function floorBuckets(report: NightReport): Array<{ t: number; db: number }> {
  const off = report.tzOffsetMin * 60_000;
  const by = new Map<number, number[]>();
  for (const p of report.floor) {
    if (p.floorDb === null) continue;
    const k = Math.floor((p.t + off) / FLOOR_BUCKET_MS);
    const list = by.get(k);
    if (list) list.push(p.floorDb); else by.set(k, [p.floorDb]);
  }
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => {
    v.sort((a, b) => a - b);
    const m = v.length >> 1;
    const db = v.length % 2 === 1 ? v[m]! : (v[m - 1]! + v[m]!) / 2;
    return { t: k * FLOOR_BUCKET_MS - off, db };
  });
}
