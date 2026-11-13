import type {
  HeartbeatRecord, MonitorEvent, NightRecord, SessionRecord, SnoreEpisodeRecord, SoundEventRecord,
} from '../monitor/types';
import { getNight, getNightData, getSessionData, listLegacySessions } from '../storage/db';
import { exportMotion, type MotionSessionData } from '../motion/index';

export interface ExportFile {
  schema: 'zzz-m2/1';
  exportedAt: number;
  sessions: Array<SessionRecord & { heartbeats: HeartbeatRecord[]; events: MonitorEvent[] }>;
}

/** 讀出 M2 的舊測試 session(nightId 為空)與其心跳、事件，組成 ExportFile。 */
export async function buildExport(): Promise<ExportFile> {
  const sessions = await listLegacySessions();
  const out: ExportFile['sessions'] = [];
  for (const s of sessions) {
    const { heartbeats, events } = await getSessionData(s.id);
    out.push({ ...s, heartbeats, events });
  }
  return { schema: 'zzz-m2/1', exportedAt: Date.now(), sessions: out };
}

export interface ExportFileM3 {
  schema: 'zzz-m3/1';
  exportedAt: number;
  nights: Array<NightRecord & {
    sessions: Array<SessionRecord & { heartbeats: HeartbeatRecord[]; events: MonitorEvent[] }>;
    soundEvents: SoundEventRecord[];
    snoreEpisodes: SnoreEpisodeRecord[];
    /** M5 motion sessions with their 30 s epochs; empty when the phone was on the nightstand. */
    motion: MotionSessionData[];
  }>;
}

/** One night with its sessions, heartbeats, state events, sound events and snore episodes. No PCM. */
export async function buildNightExport(nightId: string): Promise<ExportFileM3> {
  const night = await getNight(nightId);
  const nights: ExportFileM3['nights'] = [];
  if (night) {
    const { sessions, soundEvents, snoreEpisodes } = await getNightData(nightId);
    const withData = [];
    for (const s of sessions) withData.push({ ...s, ...(await getSessionData(s.id)) });
    const motion = await exportMotion(sessions.map((s) => s.id));
    nights.push({ ...night, sessions: withData, soundEvents, snoreEpisodes, motion });
  }
  return { schema: 'zzz-m3/1', exportedAt: Date.now(), nights };
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** zzz-<prefix>-YYYYMMDD-HHmm.json in local time at export. */
function fileName(prefix: string, d: Date): string {
  return `zzz-${prefix}-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json`;
}

/** Blob(application/json) + URL.createObjectURL + 暫時的 <a download> 點擊，之後 revokeObjectURL。 */
export function downloadExport(file: ExportFile | ExportFileM3): void {
  const blob = new Blob([JSON.stringify(file, null, 1)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName(file.schema === 'zzz-m3/1' ? 'm3' : 'm2', new Date());
  a.hidden = true;
  document.body.append(a);
  a.click();
  a.remove();
  // Revoke later: Safari can still be reading the blob right after click().
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
