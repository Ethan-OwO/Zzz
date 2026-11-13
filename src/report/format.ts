// Text formatting shared by the report screen and report.md (design_M6-M7 §5.7). Pure.
// Times use the report's tzOffsetMin, never the runtime's time zone, so Node tests and a
// reader's computer in another zone see the same clock.
import { ZH_TW, type ExportStrings } from '../export/strings.ts';
import type { ItemClass } from './types.ts';

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Wall clock in the given offset: "02:13" / "02:13:05". */
export function fmtClock(t: number, tzOffsetMin: number, withSec = false): string {
  const d = new Date(t + tzOffsetMin * 60000);
  const hm = `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
  return withSec ? `${hm}:${pad2(d.getUTCSeconds())}` : hm;
}

/** "2026-11-13" of the night: the start time minus 6 hours, so a night begun after midnight counts as the evening before. */
export function fmtNightDate(startedAt: number, tzOffsetMin: number): string {
  const d = new Date(startedAt + tzOffsetMin * 60000 - 6 * 3600_000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** "UTC+08:00" */
export function fmtTz(tzOffsetMin: number): string {
  const a = Math.abs(tzOffsetMin);
  return `UTC${tzOffsetMin < 0 ? '-' : '+'}${pad2(Math.floor(a / 60))}:${pad2(a % 60)}`;
}

/** "45 秒" under a minute, "12 分" under an hour, else "1 小時 05 分". */
export function fmtDur(ms: number, s: ExportStrings = ZH_TW): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return s.durSec(sec);
  const min = Math.round(sec / 60);
  if (min < 60) return s.durMin(min);
  return s.durHourMin(Math.floor(min / 60), pad2(min % 60));
}

/** "-31.2 dB" / "–" */
export function fmtDb(db: number | null): string {
  return db === null || !Number.isFinite(db) ? '–' : `${db.toFixed(1)} dB`;
}

/** "+11.0 dB" (a margin or difference, always signed) */
export function fmtDbDelta(db: number): string {
  return `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`;
}

export function classLabel(c: ItemClass, s: ExportStrings = ZH_TW): string {
  return s.classLabel[c];
}
