import type { HeartbeatRecord, MonitorEvent, SessionRecord } from '../monitor/types';
import { getSessionData, listSessions } from '../storage/db';

export interface ExportFile {
  schema: 'zzz-m2/1';
  exportedAt: number;
  sessions: Array<SessionRecord & { heartbeats: HeartbeatRecord[]; events: MonitorEvent[] }>;
}

/** 讀出所有 session 與其心跳、事件，組成 ExportFile。 */
export async function buildExport(): Promise<ExportFile> {
  const sessions = await listSessions();
  const out: ExportFile['sessions'] = [];
  for (const s of sessions) {
    const { heartbeats, events } = await getSessionData(s.id);
    out.push({ ...s, heartbeats, events });
  }
  return { schema: 'zzz-m2/1', exportedAt: Date.now(), sessions: out };
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** zzz-m2-YYYYMMDD-HHmm.json in local time at export. */
function fileName(d: Date): string {
  return `zzz-m2-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json`;
}

/** Blob(application/json) + URL.createObjectURL + 暫時的 <a download> 點擊，之後 revokeObjectURL。 */
export function downloadExport(file: ExportFile): void {
  const blob = new Blob([JSON.stringify(file, null, 1)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName(new Date());
  a.hidden = true;
  document.body.append(a);
  a.click();
  a.remove();
  // Revoke later: Safari can still be reading the blob right after click().
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
