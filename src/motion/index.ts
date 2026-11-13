// The only module that code outside src/motion imports (hooks H1–H6, design_M5 §5.9).
import { decideQuality } from './actigraphy.ts';
import { getMotionData, type MotionSessionData } from './motion-db.ts';
import { DEFAULT_MOTION_PARAMS, type MotionParams } from './params.ts';
import { needsMotionPrompt } from './permission.ts';
import { chooseBedInGesture, getPlacement, lastPermission, setPlacement } from './placement.ts';
import { startMotionRecorder, type MotionHandle } from './recorder.ts';
import type { MotionLiveStatus, MotionPermission, Placement } from './types.ts';

export { renderPlacementPicker } from './placement.ts';
export { deleteAllMotion, deleteMotionForSessions } from './motion-db.ts';
export type { MotionHandle } from './recorder.ts';
export type { MotionSessionData } from './motion-db.ts';
export type { Placement } from './types.ts';

let current: MotionHandle | null = null;

/** `?me=<seconds>` (integer 2–30) overrides the epoch length; used by check-motion.mjs only. */
function params(): MotionParams {
  const raw = new URLSearchParams(location.search).get('me');
  if (raw !== null && /^\d+$/.test(raw)) {
    const n = Number(raw);
    if (n >= 2 && n <= 30) return { ...DEFAULT_MOTION_PARAMS, epochSec: n };
  }
  return DEFAULT_MOTION_PARAMS;
}

function permissionNow(): MotionPermission {
  const p = lastPermission();
  if (p !== null) return p;
  if (typeof DeviceMotionEvent === 'undefined') return 'unsupported';
  // iOS without a tap this page load: still listen, events arrive if iOS remembered the grant.
  return needsMotionPrompt() ? 'error' : 'not-required';
}

/** Call after the session's microphone is running. Null when the phone is on the nightstand. */
export function startMotion(sessionId: string): MotionHandle | null {
  if (current) void current.stop();
  current = startMotionRecorder(sessionId, getPlacement(), permissionNow(), params());
  const handle = current;
  if (!handle) return null;
  return {
    live: handle.live,
    stop: async () => {
      await handle.stop();
      if (current === handle) current = null;
    },
  };
}

export function motionLive(): MotionLiveStatus | null {
  return current ? current.live : null;
}

/** For M3's recovery screen: call synchronously inside the 「繼續監測」 tap. */
export function motionResumeInGesture(placement: Placement): void {
  if (placement === 'bed') void chooseBedInGesture();
  else setPlacement('nightstand');
}

/** For M3's recovery screen: 'bed' if any of these sessions recorded motion. */
export async function lastRecordedPlacement(sessionIds: string[]): Promise<Placement> {
  try {
    const all = await getMotionData(sessionIds);
    return all.length > 0 ? 'bed' : 'nightstand';
  } catch {
    return 'nightstand';
  }
}

/** One line for the result screen, over every session of the night. */
export async function motionSummary(sessionIds: string[]): Promise<string> {
  let data: MotionSessionData[];
  try {
    data = await getMotionData(sessionIds);
  } catch {
    return '讀取失敗';
  }
  if (data.length === 0) return '未啟用(床頭櫃)';
  const epochs = data.flatMap((s) => s.epochs);
  const filled = epochs.filter((e) => e.samples > 0);
  const moved = epochs.filter((e) => e.activeSec >= 1).length;
  const rate = filled.length > 0 ? filled.reduce((a, e) => a + e.rateHz, 0) / filled.length : 0;
  // A night with any binary session is binary as a whole (the weaker one decides).
  const qualities = data.map((s) => s.quality ?? decideQuality(s.epochs, s.params));
  const quality = qualities.includes('binary') ? 'binary' : qualities.includes('full') ? 'full' : 'none';
  return `${epochs.length} 個區間，有動 ${moved} 個，平均 ${rate.toFixed(0)} Hz，品質 ${quality}`;
}

/** Omitted sessionIds = every motion session. */
export function exportMotion(sessionIds?: string[]): Promise<MotionSessionData[]> {
  return getMotionData(sessionIds);
}
