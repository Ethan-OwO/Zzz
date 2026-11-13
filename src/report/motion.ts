// Motion summary and "restless" periods (design_M6-M7 §5.5). Pure.
import { decideQuality } from '../motion/actigraphy.ts';
import type { MotionQuality } from '../motion/types.ts';
import type { MotionSummary, ReportInput } from './types.ts';

export interface MotionReportParams { activeSecMin: number; mergeGapSec: number; minActiveEpochs: number; }
export const DEFAULT_MOTION_REPORT: MotionReportParams = { activeSecMin: 1, mergeGapSec: 300, minActiveEpochs: 2 }; // 🎛

const RANK: Record<MotionQuality, number> = { none: 0, binary: 1, full: 2 };

export function summarizeMotion(motion: ReportInput['motion'], p: Partial<MotionReportParams> = {}): MotionSummary | null {
  if (motion.length === 0) return null;
  const P = { ...DEFAULT_MOTION_REPORT, ...p };

  // Worst quality over all sessions. A session that never stopped normally has quality null;
  // judge it from its epochs the same way the recorder would have at stop.
  let quality: MotionQuality = 'full';
  for (const m of motion) {
    const q = m.quality ?? decideQuality(m.epochs, m.params);
    if (RANK[q] < RANK[quality]) quality = q;
  }

  const epochs = motion
    .flatMap((m) => m.epochs)
    .sort((a, b) => a.startAt - b.startAt)
    .map((e) => ({ startAt: e.startAt, endAt: e.endAt, activity: e.activity, activeSec: e.activeSec, sensed: e.samples > 0 }));
  const active = epochs.filter((e) => e.sensed && e.activeSec >= P.activeSecMin);

  const restless: MotionSummary['restless'] = [];
  if (quality !== 'none') {
    let cur: { startAt: number; endAt: number; activeEpochs: number } | null = null;
    for (const e of active) {
      if (cur && e.startAt - cur.endAt <= P.mergeGapSec * 1000) {
        cur.endAt = Math.max(cur.endAt, e.endAt);
        cur.activeEpochs++;
      } else {
        if (cur && cur.activeEpochs >= P.minActiveEpochs) restless.push(cur);
        cur = { startAt: e.startAt, endAt: e.endAt, activeEpochs: 1 };
      }
    }
    if (cur && cur.activeEpochs >= P.minActiveEpochs) restless.push(cur);
  }

  return { quality, epochs, restless, activeEpochs: active.length, sensedEpochs: epochs.filter((e) => e.sensed).length };
}
