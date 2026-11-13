// buildReport(): every number of the report, computed once (design_M6-M7 §5.4, §5.6). Pure.
// The report screen, report.md and data.json only present this result.
import { DEFAULT_CLASSIFY_PARAMS } from '../classify/rules.ts';
import { effectiveMargins } from '../detect/calibrate.ts';
import { SAMPLE_RATE } from '../detect/params.ts';
import { audioParts, includeAudio, isDroppableSnore, type AudioPolicyParams } from '../export/audio-policy.ts';
import { chainEvents, effectiveClass, unionMs } from './classes.ts';
import { findGaps } from './coverage.ts';
import { summarizeMotion } from './motion.ts';
import type { ClassTotals, FloorPoint, ItemAudio, NightReport, ReportInput, ReportItem, ReportNote, ReportSoundEvent } from './types.ts';

const MS_PER_SAMPLE = 1000 / SAMPLE_RATE;

export function buildReport(input: ReportInput, p: AudioPolicyParams = { dropMinConfidence: DEFAULT_CLASSIFY_PARAMS.dropMinConfidence }): NightReport {
  const { night } = input;
  const mode = night.mode;
  const tzOffsetMin = input.tzOffsetMin ?? -new Date(night.startedAt).getTimezoneOffset();

  // ---- time frame ----
  const sessions = [...input.sessions].sort((a, b) => a.startedAt - b.startedAt);
  const allHb = sessions.flatMap((s) => s.heartbeats).sort((a, b) => a.t - b.t);
  const startedAt = sessions[0]?.startedAt ?? night.startedAt;
  const detectStartAt = night.calibration?.at ?? startedAt;
  const lastHb = allHb[allHb.length - 1]?.t ?? null;
  const stoppedAt = Math.max(detectStartAt, night.stoppedAt ?? lastHb ?? sessions[sessions.length - 1]?.startedAt ?? startedAt);
  const gaps = findGaps(input, detectStartAt, stoppedAt);
  const unmonitoredMs = gaps.reduce((n, g) => n + g.endAt - g.startAt, 0);
  const monitoredMs = Math.max(0, stoppedAt - detectStartAt - unmonitoredMs);

  // ---- items ----
  const overBudget = night.audioSecUsed >= night.params.audioBudgetSec;
  let unfinished = 0;
  const items: ReportItem[] = [];

  for (const chain of chainEvents(input.soundEvents)) {
    const head = chain[0]!;
    const last = chain[chain.length - 1]!;
    const estEnd = last.startAt + last.sampleCount * MS_PER_SAMPLE;
    if (last.endAt === null || last.coreEndAt === null) unfinished++;
    const endAt = Math.max(head.startAt, last.endAt ?? estEnd);
    const coreEndAt = Math.max(head.coreStartAt, last.coreEndAt ?? Math.min(estEnd, endAt));
    const c = effectiveClass(chain);
    items.push({
      kind: 'event', id: head.id, partIds: chain.map((e) => e.id),
      startAt: head.startAt, endAt, coreStartAt: head.coreStartAt, coreEndAt,
      cls: c.cls, source: c.source, confidence: c.confidence, autoCls: c.autoCls, userLabel: c.userLabel,
      peakDb: Math.max(...chain.map((e) => e.peakDb)), floorDb: head.floorDbAtStart, burstCount: null,
      audio: chainAudio(chain, mode, overBudget, p),
      audioSec: chain.reduce((n, e) => n + e.sampleCount, 0) / SAMPLE_RATE,
    });
  }

  for (const ep of input.snoreEpisodes) {
    if (ep.endAt === null) unfinished++;
    const notSnore = ep.userLabel === 'not-snore';
    items.push({
      kind: 'snore-episode', id: ep.id, partIds: [],
      startAt: ep.startAt, endAt: Math.max(ep.startAt, ep.endAt ?? ep.startAt), coreStartAt: null, coreEndAt: null,
      cls: notSnore ? 'other' : 'snore', source: notSnore ? 'user' : 'snore-episode',
      confidence: null, autoCls: null, userLabel: ep.userLabel ?? null,
      peakDb: ep.meanPeakDb, floorDb: null, burstCount: ep.burstCount, audio: 'none', audioSec: 0,
    });
  }
  items.sort((a, b) => a.startAt - b.startAt || (a.kind === b.kind ? 0 : a.kind === 'snore-episode' ? -1 : 1));

  // ---- totals ----
  const coreMs = (it: ReportItem) => (it.kind === 'event' ? it.coreEndAt! - it.coreStartAt! : it.endAt - it.startAt);
  const sum = (cls: ReportItem['cls']): ClassTotals => {
    const list = items.filter((it) => it.cls === cls);
    return { count: list.length, totalMs: list.reduce((n, it) => n + coreMs(it), 0) };
  };
  const snoreEps = items.filter((it) => it.kind === 'snore-episode' && it.cls === 'snore');
  const snoreEvs = items.filter((it) => it.kind === 'event' && it.cls === 'snore');
  const inEpisode = (it: ReportItem) => snoreEps.some((ep) => it.coreStartAt! < ep.endAt && it.coreEndAt! > ep.startAt);
  const snoreUnion = unionMs([
    ...snoreEps.map((ep): [number, number] => [ep.startAt, ep.endAt]),
    ...snoreEvs.map((it): [number, number] => [it.coreStartAt!, it.coreEndAt!]),
  ]);
  const totals: NightReport['totals'] = {
    snore: {
      count: snoreEps.length + snoreEvs.filter((it) => !inEpisode(it)).length,
      totalMs: snoreUnion, episodes: snoreEps.length, unionMs: snoreUnion,
    },
    talk: sum('talk'), other: sum('other'), unclassified: sum('unclassified'),
  };

  const longestIds = items
    .filter((it) => it.kind === 'event')
    .sort((a, b) => coreMs(b) - coreMs(a) || a.startAt - b.startAt)
    .slice(0, 3)
    .map((it) => it.id);

  const floor: FloorPoint[] = allHb.map((h) => ({ t: h.t, floorDb: h.floorDb ?? null, meanDb: h.meanDb }));

  // ---- placement / motion ----
  const bedSessions = new Set(input.motion.filter((m) => m.placement === 'bed').map((m) => m.sessionId));
  const bedCount = sessions.filter((s) => bedSessions.has(s.id)).length;
  const placement: NightReport['placement'] =
    bedCount === 0 ? 'nightstand' : bedCount === sessions.length ? 'bed' : 'mixed';

  const audioSecTotal = [...audioParts(input.soundEvents, mode, p).values()].reduce((n, s) => n + s, 0) / SAMPLE_RATE;

  // ---- notes (codes only; strings.ts writes the sentences) ----
  const notes: ReportNote[] = [];
  if (mode === 'test') notes.push({ code: 'test-mode' });
  if (gaps.length > 0) notes.push({ code: 'gaps', n: gaps.length, min: Math.round(unmonitoredMs / 60000) });
  if (unfinished > 0) notes.push({ code: 'unfinished', n: unfinished });
  const nOver = items.filter((it) => it.audio === 'over-budget').length;
  if (nOver > 0) notes.push({ code: 'over-budget', n: nOver, hours: night.params.audioBudgetSec / 3600 });
  const nDropped = items.filter((it) => it.audio === 'dropped-snore').length;
  if (nDropped > 0) notes.push({ code: 'dropped-snore', n: nDropped });
  if (totals.unclassified.count > 0) notes.push({ code: 'unclassified', n: totals.unclassified.count });
  notes.push({ code: 'not-medical' });

  const cal = night.calibration;
  return {
    version: 1,
    generatedAt: input.generatedAt,
    tzOffsetMin,
    nightId: night.id,
    mode,
    startedAt, detectStartAt, stoppedAt, monitoredMs, unmonitoredMs, gaps,
    calibration: cal
      ? { floorDb: cal.floorDb, speechDb: cal.speechDb, triggerMarginDb: effectiveMargins(cal, mode, night.params).trigger }
      : null,
    placement, totals, items, longestIds, floor,
    motion: summarizeMotion(input.motion),
    audioSecTotal,
    notes,
  };
}

/**
 * Audio state of a chain. 'dropped-snore' also covers formal-mode snore audio that is still
 * stored but will not be exported (§6.1), so the report says what the zip actually contains.
 */
function chainAudio(chain: ReportSoundEvent[], mode: 'formal' | 'test', overBudget: boolean, p: AudioPolicyParams): ItemAudio {
  if (chain.some((e) => includeAudio(e, mode, p))) return 'present';
  const dropped = chain.some((e) =>
    e.audioDroppedAs === 'snore'
    || (!e.hasAudio && e.snoreEpisodeId !== null)
    || (mode === 'formal' && e.hasAudio && e.sampleCount > 0 && isDroppableSnore(e, p)));
  if (dropped) return 'dropped-snore';
  if (overBudget && chain.some((e) => !e.hasAudio)) return 'over-budget';
  return 'none';
}
