// M6 report types (design_M6-M7 §5.1). Pure: types only.
import type { Classification } from '../classify/rules.ts';
import type { HeartbeatRecord, MonitorEvent, NightRecord, SessionRecord, SnoreEpisodeRecord, SoundEventRecord } from '../monitor/types.ts';
import type { MotionEpoch, MotionSessionRecord } from '../motion/types.ts';

// ---- Stand-ins for the fields M4 T2 adds (design_M6-M7 §8). ----
// M6 T2 replaces these with imports of the real M4 types and deletes them here.
/** M4 labeling buttons on a sound event. 'unsure' is the "?" button and does not count as a label. */
export type UserLabel = 'snore' | 'talk' | 'other' | 'unsure';
/** M4 labeling buttons on a snore episode (after listening to its sample). */
export type EpisodeLabel = 'snore' | 'not-snore' | 'unsure';
export type ReportSoundEvent = SoundEventRecord & {
  classification?: Classification | null;
  userLabel?: UserLabel | null;
  audioDroppedAs?: 'snore' | null;
};
export type ReportSnoreEpisode = SnoreEpisodeRecord & { userLabel?: EpisodeLabel | null };

export interface ReportInput {
  night: NightRecord;
  sessions: Array<SessionRecord & { heartbeats: HeartbeatRecord[]; events: MonitorEvent[] }>;
  soundEvents: ReportSoundEvent[];
  snoreEpisodes: ReportSnoreEpisode[];
  motion: Array<MotionSessionRecord & { epochs: MotionEpoch[] }>; // only this night's sessions; [] if none
  generatedAt: number;
  /** Minutes east of UTC. Omitted = the runtime's zone at night.startedAt; tests pass it to stay fixed. */
  tzOffsetMin?: number;
}

export type ItemClass = 'snore' | 'talk' | 'other' | 'unclassified';
export type ClassSource = 'user' | 'auto' | 'snore-episode' | 'none';
export type ItemAudio = 'present' | 'over-budget' | 'dropped-snore' | 'none';

/** One item on the time line: an event (continuesFrom chain merged into one) or a snore episode. */
export interface ReportItem {
  kind: 'event' | 'snore-episode';
  id: string;                     // event: id of the first part; episode: episode id
  partIds: string[];              // event: every part id in order (incl. the first); episode: []
  startAt: number; endAt: number; // event: incl. pre/post-roll; null ends are filled in (§5.4)
  coreStartAt: number | null; coreEndAt: number | null; // events only
  cls: ItemClass; source: ClassSource;
  confidence: number | null;      // auto only
  autoCls: 'snore' | 'talk' | 'other' | null; // kept even when the user relabeled it
  userLabel: string | null;       // raw SoundEventRecord.userLabel / SnoreEpisodeRecord.userLabel
  peakDb: number | null; floorDb: number | null;
  burstCount: number | null;      // episodes only
  audio: ItemAudio;
  audioSec: number;               // Σ sampleCount of all parts / 16000
}

export interface Gap { startAt: number; endAt: number; reason: 'between-sessions' | 'timer-gap' | 'low-frames' | 'no-heartbeat'; }

export interface FloorPoint { t: number; floorDb: number | null; meanDb: number | null; }

export interface MotionSummary {
  quality: 'full' | 'binary' | 'none';
  epochs: Array<{ startAt: number; endAt: number; activity: number; activeSec: number; sensed: boolean }>;
  restless: Array<{ startAt: number; endAt: number; activeEpochs: number }>;
  activeEpochs: number; sensedEpochs: number;
}

export interface ClassTotals { count: number; totalMs: number; }

/** A note is a code + parameters; src/export/strings.ts turns it into a sentence (§6.3.1). */
export type ReportNote = { code: string; [k: string]: string | number };

export interface NightReport {
  version: 1;
  generatedAt: number;
  tzOffsetMin: number;
  nightId: string;
  mode: 'formal' | 'test';
  startedAt: number;               // first session start (incl. calibration)
  detectStartAt: number;           // calibration end = detection start (night.calibration.at, else startedAt)
  stoppedAt: number;               // night.stoppedAt ?? last heartbeat ?? last session.startedAt
  monitoredMs: number;             // detectStartAt..stoppedAt minus gaps
  unmonitoredMs: number;
  gaps: Gap[];
  calibration: { floorDb: number; speechDb: number | null; triggerMarginDb: number } | null;
  placement: 'bed' | 'nightstand' | 'mixed';
  totals: {
    snore: ClassTotals & { episodes: number; unionMs: number };
    talk: ClassTotals; other: ClassTotals; unclassified: ClassTotals;
  };
  items: ReportItem[];             // sorted by startAt
  longestIds: string[];            // top 3 events by core length (snore episodes excluded)
  floor: FloorPoint[];             // one point per heartbeat
  motion: MotionSummary | null;    // null = no motion data
  audioSecTotal: number;           // seconds that go into night.wav (§6.1)
  notes: ReportNote[];
}
