// All record shapes stored in IndexedDB and exported as JSON.

export type CtxState = 'suspended' | 'running' | 'closed' | 'interrupted' | 'unknown';
export type WakeLockStatus = 'unsupported' | 'held' | 'released' | 'error';

export type MonitorEventType =
  | 'start' | 'stop'
  | 'visibility' | 'pagehide' | 'pageshow' | 'freeze' | 'resume'
  | 'wakelock-acquired' | 'wakelock-released' | 'wakelock-error'
  | 'ctx-state'
  | 'track-mute' | 'track-unmute' | 'track-ended'
  | 'audiosession-state'
  | 'timer-gap'
  | 'recovery-attempt' | 'recovery-success' | 'recovery-failed' | 'needs-gesture'
  | 'error';

export interface MonitorEvent {
  sessionId: string;
  t: number;              // Date.now()
  type: MonitorEventType;
  detail: string;         // e.g. the new state value, an error's "name: message", a gap in ms
}

export interface HeartbeatRecord {
  sessionId: string;
  seq: number;            // starts at 0
  t: number;              // Date.now()
  perfNow: number;        // performance.now()
  frames: number;         // 16 kHz frames (512 samples each) processed this period
  zeroFrames: number;     // of which every sample was 0
  noInputQuanta: number;  // process() calls where inputs[0] had no channels
  minDb: number | null;   // min frame dBFS this period; null when frames is 0
  meanDb: number | null;  // energy mean: 10·log10(mean of mean-squares), floor -120
  maxDb: number | null;
  ctxState: CtxState;
  ctxTime: number;        // AudioContext.currentTime
  wakeLock: WakeLockStatus;
  visibility: DocumentVisibilityState;
  trackReadyState: 'live' | 'ended' | 'none';
  trackMuted: boolean | null;
  audioSessionState: string | null;   // navigator.audioSession?.state, null when unsupported
  battery: { level: number; charging: boolean } | null;  // only when navigator.getBattery exists (not on iOS)
}

export interface SessionRecord {
  id: string;             // crypto.randomUUID()
  scenario: string;       // scenario code from the home screen
  startedAt: number;
  stoppedAt: number | null;   // null = never stopped normally (page closed or reloaded)
  heartbeatIntervalSec: number;
  userAgent: string;
  ctxSampleRate: number | null;
  ctxBaseLatency: number | null;
  trackSettings: Record<string, string | number | boolean> | null; // getSettings() minus deviceId, groupId
  storagePersisted: boolean | null;
}

/** Posted by the capture worklet about once per second. */
export interface WorkletStats {
  frames: number; zeroFrames: number; noInputQuanta: number;
  minMs: number | null; maxMs: number | null; sumMs: number; // min/max are null when frames is 0
  ctxTime: number;
}
