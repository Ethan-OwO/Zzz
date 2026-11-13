// Shared screen plumbing: navigation, live-status routing, URL test knobs and
// small DOM helpers.
import { DEFAULT_PARAMS } from '../detect/params.ts';
import type { RecorderStatus } from '../record/recorder';
import type { LiveStatus, RunningSession } from '../monitor/session';
import { startSession } from '../monitor/session';
import type { NightRecord } from '../monitor/types';

export type LiveStatusFull = LiveStatus & { recorder: RecorderStatus | null };

export interface Nav {
  home(opts?: { error?: string; errorName?: string }): void;
  calibrate(session: RunningSession, night: NightRecord): void;
  recording(session: RunningSession, night: NightRecord): void;
  recovery(night: NightRecord): void;
  result(nightId: string): void;
}

/** The recording screen installs its updater here; sessions report to it every second. */
export const live: { update: ((s: LiveStatusFull) => void) | null } = { update: null };

function intParam(name: string, min: number, max: number): number | null {
  const raw = new URLSearchParams(location.search).get(name);
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n >= min && n <= max ? n : null;
}

/** `?hb=<seconds>` (integer 1–60) overrides the heartbeat interval; used by pnpm check only. */
export function heartbeatIntervalSec(): number {
  return intParam('hb', 1, 60) ?? 60;
}

/** `?cal=<seconds>` (integer 3–30) replaces the 30 s quiet calibration step; used by pnpm check only. */
export function calibrationQuietSec(): number {
  return intParam('cal', 3, 30) ?? 30;
}

/** Must be called synchronously inside a click handler (iOS user activation). */
export function beginSession(nightId: string): Promise<RunningSession> {
  return startSession({
    nightId,
    heartbeatIntervalSec: heartbeatIntervalSec(),
    onLiveStatus: (s) => live.update?.(s),
  });
}

export function newNight(): NightRecord {
  return {
    id: crypto.randomUUID(),
    startedAt: Date.now(),
    stoppedAt: null,
    status: 'calibrating',
    calibration: null,
    mode: 'formal',
    audioSecUsed: 0,
    paramsVersion: 1,
    params: { ...DEFAULT_PARAMS },
  };
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', className, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

export function errorParts(err: unknown): { name: string; message: string } {
  if (err instanceof Error || err instanceof DOMException) return { name: err.name, message: err.message };
  return { name: 'Error', message: String(err) };
}

export function hhmm(t: number): string {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function hhmmss(t: number): string {
  const d = new Date(t);
  return `${hhmm(t)}:${String(d.getSeconds()).padStart(2, '0')}`;
}

export function fmtDb(db: number): string {
  return `${db.toFixed(1)} dB`;
}
