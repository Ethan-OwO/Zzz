// Monitored / unmonitored time (design_M6-M7 §5.2). Pure.
import { FRAME_SIZE, SAMPLE_RATE } from '../detect/params.ts';
import type { Gap, ReportInput } from './types.ts';

export interface CoverageParams {
  minFrameRatio: number;     // 🎛 a heartbeat with fewer valid frames than this × expected is unmonitored
  maxHeartbeatGap: number;   // 🎛 heartbeats further apart than this × interval leave a gap
  minGapSec: number;         // 🎛 shorter gaps are dropped
}
export const DEFAULT_COVERAGE: CoverageParams = { minFrameRatio: 0.5, maxHeartbeatGap: 2.5, minGapSec: 10 };

/** Unmonitored ranges inside [detectStartAt, stoppedAt], sorted, overlapping ones merged. */
export function findGaps(input: ReportInput, detectStartAt: number, stoppedAt: number, p: CoverageParams = DEFAULT_COVERAGE): Gap[] {
  const raw: Gap[] = [];
  const sessions = [...input.sessions].sort((a, b) => a.startedAt - b.startedAt);

  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i]!;
    const hbs = [...s.heartbeats].sort((a, b) => a.t - b.t);
    const intervalMs = s.heartbeatIntervalSec * 1000;

    // 1. between-sessions: previous session's end -> this session's start.
    if (i > 0) {
      const prev = sessions[i - 1]!;
      const prevHb = prev.heartbeats.reduce<number | null>((m, h) => (m === null || h.t > m ? h.t : m), null);
      const prevEnd = prev.stoppedAt ?? prevHb ?? prev.startedAt;
      if (s.startedAt > prevEnd) raw.push({ startAt: prevEnd, endAt: s.startedAt, reason: 'between-sessions' });
    }

    // 2. timer-gap: detail is the actual tick interval in ms (src/monitor/session.ts).
    for (const e of s.events) {
      if (e.type !== 'timer-gap') continue;
      const ms = Number(e.detail);
      if (Number.isFinite(ms) && ms > 0) raw.push({ startAt: e.t - ms, endAt: e.t, reason: 'timer-gap' });
    }

    // 3. low-frames: a heartbeat covers [t − interval, t].
    const expected = (s.heartbeatIntervalSec * SAMPLE_RATE) / FRAME_SIZE;
    for (const h of hbs) {
      if (h.frames - h.zeroFrames < p.minFrameRatio * expected) {
        raw.push({ startAt: h.t - intervalMs, endAt: h.t, reason: 'low-frames' });
      }
    }

    // 4. no-heartbeat: beyond one interval, the silence between heartbeats is unmonitored.
    let last = s.startedAt;
    for (const h of hbs) {
      if (h.t - last > p.maxHeartbeatGap * intervalMs) {
        raw.push({ startAt: last + intervalMs, endAt: h.t, reason: 'no-heartbeat' });
      }
      last = h.t;
    }
  }

  // Clip to the detection window, then merge. A merged gap keeps the reason of its earliest part.
  const clipped = raw
    .map((g) => ({ ...g, startAt: Math.max(g.startAt, detectStartAt), endAt: Math.min(g.endAt, stoppedAt) }))
    .filter((g) => g.endAt > g.startAt)
    .sort((a, b) => a.startAt - b.startAt || b.endAt - a.endAt);
  const merged: Gap[] = [];
  for (const g of clipped) {
    const top = merged[merged.length - 1];
    if (top && g.startAt <= top.endAt) top.endAt = Math.max(top.endAt, g.endAt);
    else merged.push({ ...g });
  }
  return merged.filter((g) => g.endAt - g.startAt >= p.minGapSec * 1000);
}
