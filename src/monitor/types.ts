// All record shapes stored in IndexedDB and exported as JSON.
import type { CalibrationResult } from '../detect/calibrate.ts';
import type { DetectParams } from '../detect/params.ts';

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
  floorDb?: number | null;      // M3: detector noise floor at this heartbeat (absent in M2 records)
  soundEventCount?: number;     // M3: sound events recorded so far this night
}

export interface SessionRecord {
  id: string;             // crypto.randomUUID()
  nightId?: string | null; // M3; undefined/null for M2 test sessions
  scenario: string;       // M2 scenario code; always 'night' from M3 on
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
  pcm: Int16Array;  // this period's 16 kHz PCM, length = frames × 512 (transferred, not copied)
}

export interface NightRecord {
  id: string;                         // crypto.randomUUID()
  startedAt: number;
  stoppedAt: number | null;           // null = 未正常停止
  status: 'calibrating' | 'recording' | 'stopped';
  calibration: (CalibrationResult & { userAdjustDb: number; at: number }) | null;
  // 'formal': snoring is stored as time ranges only, no audio.
  // 'test': snores are recorded too and the trigger margin is lowered (params.testMarginOffsetDb).
  mode: 'formal' | 'test';
  audioSecUsed: number;
  paramsVersion: 1;
  params: DetectParams;               // 當晚使用的參數全文，方便之後調校對照
}

export interface SoundEventRecord {
  id: string;
  nightId: string; sessionId: string;
  startAt: number; endAt: number | null;     // 牆上時間 ms(含 pre-roll / post-roll);null = 進行中
  coreStartAt: number; coreEndAt: number | null; // 觸發到開始 post-roll(不含前後補錄)
  peakDb: number; floorDbAtStart: number;
  endReason: 'released' | 'split' | 'gap' | 'snore-confirmed' | 'stopped' | 'recovered' | null;
  continuesFrom: string | null;              // 長事件切段時，指向前一段
  hasAudio: boolean; audioIncomplete: boolean;
  sampleCount: number;                       // 已寫入的樣本數
  snoreEpisodeId: string | null;             // 是某段打呼的樣本
  snoreLike: boolean;                        // 只有 test 模式時可能為 true
}

export interface AudioChunkRecord {
  eventId: string; seq: number;              // 複合主鍵
  pcm: ArrayBuffer;                          // Int16 LE,16 kHz 單聲道
}

export interface SnoreEpisodeRecord {
  id: string;
  nightId: string; sessionId: string;
  startAt: number; endAt: number | null;
  burstCount: number;
  medianIntervalSec: number;
  meanPeakDb: number; meanLowRatio: number;
  endReason: 'quiet' | 'gap' | 'stopped' | 'recovered' | null;
}
