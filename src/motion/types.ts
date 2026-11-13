import type { MotionParams } from './params.ts';

export type Placement = 'bed' | 'nightstand';
export type MotionPermission = 'granted' | 'denied' | 'not-required' | 'unsupported' | 'error';
export type MotionQuality = 'full' | 'binary' | 'none';

export interface MotionEpoch {
  sessionId: string;
  idx: number;              // 0-based epoch index within the session
  startAt: number;          // wall clock ms = motion start + idx × epochSec
  endAt: number;            // the last epoch may be shorter (closed at stop)
  samples: number;          // valid samples; 0 = no events at all (interruption)
  rateHz: number;           // samples / covered seconds
  activity: number;         // Σ max(0, d − deadband)·dt, m/s²·s (actigraphy count)
  peak: number;             // max d in the epoch
  activeSec: number;        // seconds whose max d exceeded moveThreshold
  tiltDeg: number | null;   // angle between this and the previous non-empty epoch's mean gravity
  hiddenMs: number;         // time the document was hidden during the epoch
}

export interface MotionSessionRecord {
  sessionId: string;        // = SessionRecord.id
  placement: Placement;
  permission: MotionPermission;
  startedAt: number;
  stoppedAt: number | null;
  reportedIntervalMs: number | null;  // event.interval of the first event
  hasAcceleration: boolean | null;    // whether event.acceleration was non-null (recorded only)
  firstEventDelayMs: number | null;   // start → first valid event
  quality: MotionQuality | null;      // set at stop; null = not stopped normally
  paramsVersion: 1;
  params: MotionParams;
}

export interface MotionLiveStatus {
  rateHz: number | null;          // of the last closed epoch
  lastActiveSec: number | null;
  epochs: number;
}
