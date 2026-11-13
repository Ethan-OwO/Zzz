import type { RunningSession } from '../monitor/session';
import type { NightRecord } from '../monitor/types';
import type { LiveStatusFull } from './app';

const OVERLAY_MS = 10_000;

/** Button that fires onHold only after being held for holdMs; a shorter press does nothing. */
export function createHoldButton(label: string, holdMs: number, onHold: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'hold-button';
  const text = document.createElement('span');
  text.className = 'hold-label';
  text.textContent = label;
  const bar = document.createElement('span');
  bar.className = 'hold-progress';
  button.append(text, bar);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    clearTimeout(timer);
    timer = undefined;
    button.classList.remove('holding');
  };
  button.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    cancel();
    button.classList.add('holding');
    timer = setTimeout(() => {
      timer = undefined;
      button.classList.remove('holding');
      onHold();
    }, holdMs);
  });
  button.addEventListener('pointerup', cancel);
  button.addEventListener('pointercancel', cancel);
  button.addEventListener('pointerleave', cancel);
  button.addEventListener('contextmenu', (e) => e.preventDefault());
  return button;
}

function hms(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(Math.floor(total / 3600))}:${p(Math.floor(total / 60) % 60)}:${p(total % 60)}`;
}

function row(list: HTMLElement, label: string, field: string): HTMLElement {
  const dt = document.createElement('dt');
  dt.textContent = label;
  const dd = document.createElement('dd');
  dd.dataset.field = field;
  dd.textContent = '–';
  list.append(dt, dd);
  return dd;
}

export function renderRecording(
  root: HTMLElement,
  session: RunningSession,
  night: NightRecord,
  onStopped: (nightId: string) => void,
): { update(s: LiveStatusFull): void } {
  document.body.classList.add('recording');

  const screen = document.createElement('div');
  screen.className = 'recording-screen';

  const overlay = document.createElement('div');
  overlay.className = 'status-overlay';
  overlay.hidden = true;
  const list = document.createElement('dl');
  const elapsed = row(list, '經過時間', 'elapsed');
  const frames = row(list, '本秒幀數', 'frames');
  const db = row(list, '最近音量', 'db');
  const ctx = row(list, 'AudioContext', 'ctx');
  const wake = row(list, 'Wake lock', 'wakelock');
  const eventsRow = row(list, '事件', 'events');
  const snoreRow = row(list, '打呼', 'snore');

  let stopping = false;
  const stopButton = createHoldButton('長按 2 秒停止', 2000, () => {
    if (stopping) return;
    stopping = true;
    session.stop(night).then(() => onStopped(night.id), (err: unknown) => {
      stopping = false;
      db.textContent = `停止失敗：${err instanceof Error ? err.message : String(err)}`;
    });
  });
  overlay.append(list, stopButton);

  const recover = document.createElement('p');
  recover.className = 'recover-prompt';
  recover.textContent = '點一下螢幕以恢復監測';
  recover.hidden = true;

  screen.append(overlay, recover);
  root.append(screen);

  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  let needsGesture = false;
  screen.addEventListener('click', () => {
    if (needsGesture) {
      session.recoverFromGesture();
      return;
    }
    overlay.hidden = false;
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      overlay.hidden = true;
    }, OVERLAY_MS);
  });

  return {
    update(s: LiveStatusFull): void {
      elapsed.textContent = hms(s.elapsedMs);
      frames.textContent = String(s.lastFrames);
      db.textContent = s.lastDb === null ? '–' : `${s.lastDb.toFixed(1)} dB`;
      ctx.textContent = s.ctxState;
      wake.textContent = s.wakeLock;
      const r = s.recorder;
      eventsRow.textContent = r ? `${r.soundEventCount} 個` : '–';
      snoreRow.textContent = r?.snapshot.inSnoreEpisode ? '打呼中' : r?.snapshot.state === 'warmup' ? '暖機中' : '—';
      if (s.needsGesture !== needsGesture) {
        needsGesture = s.needsGesture;
        recover.hidden = !needsGesture;
        if (needsGesture) {
          overlay.hidden = true;
          clearTimeout(hideTimer);
        }
      }
    },
  };
}
