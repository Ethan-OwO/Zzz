import { ui, type UiStrings } from './i18n/index';

export type CheckStatus = 'ok' | 'fail' | 'unknown';

export interface EnvCheckItem {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  neededFor: string;
}

type EnvText = UiStrings['env'];

interface CheckDef {
  id: string;
  label: (t: EnvText) => string;
  neededFor: (t: EnvText) => string;
  detect: (t: EnvText) => { status: CheckStatus; detail: string };
}

function bool(value: boolean): { status: CheckStatus; detail: string } {
  return { status: value ? 'ok' : 'fail', detail: String(value) };
}

const CHECKS: readonly CheckDef[] = [
  {
    id: 'secure-context',
    label: (t) => t.secureContext,
    neededFor: (t) => t.forRecording,
    detect: () => bool(window.isSecureContext),
  },
  {
    id: 'get-user-media',
    label: (t) => t.micApi,
    neededFor: (t) => t.forRecording,
    detect: () => bool(typeof navigator.mediaDevices?.getUserMedia === 'function'),
  },
  {
    id: 'audio-worklet',
    label: () => 'AudioWorklet',
    neededFor: (t) => t.forAudio,
    detect: () => bool(typeof AudioWorkletNode === 'function'),
  },
  {
    id: 'wake-lock',
    label: (t) => t.wakeLock,
    neededFor: (t) => t.forOvernight,
    detect: () => bool('wakeLock' in navigator),
  },
  {
    id: 'indexed-db',
    label: () => 'IndexedDB',
    neededFor: (t) => t.forStorage,
    detect: () => bool('indexedDB' in window && window.indexedDB !== null),
  },
  {
    id: 'device-motion',
    label: (t) => t.motionModel,
    neededFor: (t) => t.forMotion,
    detect: (t) => {
      if (typeof DeviceMotionEvent === 'undefined') {
        return { status: 'fail', detail: t.noMotionEvent };
      }
      if (typeof (DeviceMotionEvent as any).requestPermission === 'function') {
        return { status: 'ok', detail: t.motionInGesture };
      }
      return { status: 'ok', detail: t.motionFree };
    },
  },
  {
    id: 'file-share',
    label: (t) => t.fileShare,
    neededFor: (t) => t.forExport,
    detect: (t) => {
      if (typeof navigator.canShare !== 'function') {
        return { status: 'unknown', detail: t.noCanShare };
      }
      try {
        const file = new File([], 'x.zip', { type: 'application/zip' });
        return bool(navigator.canShare({ files: [file] }));
      } catch (err) {
        return { status: 'unknown', detail: err instanceof Error ? err.message : String(err) };
      }
    },
  },
  {
    id: 'user-agent',
    label: (t) => t.userAgent,
    neededFor: (t) => t.forReports,
    detect: () => ({ status: 'unknown', detail: navigator.userAgent }),
  },
];

/** Feature detection only, synchronous. Requests no permission. */
export function runEnvChecks(): EnvCheckItem[] {
  const t = ui().env;
  return CHECKS.map((def) => {
    const { id } = def;
    const label = def.label(t);
    const neededFor = def.neededFor(t);
    try {
      const { status, detail } = def.detect(t);
      return { id, label, status, detail, neededFor };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return { id, label, status: 'unknown', detail, neededFor };
    }
  });
}

function cell(tag: 'td' | 'th', text: string, className?: string): HTMLElement {
  const el = document.createElement(tag);
  el.textContent = text;
  if (className) el.className = className;
  return el;
}

/** Builds (or replaces) a <table> inside container, one row per item. */
export function renderEnvCheckTable(items: EnvCheckItem[], container: HTMLElement): void {
  const t = ui().env;
  const table = document.createElement('table');
  table.className = 'env-check';

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const heading of t.headings) {
    const th = cell('th', heading);
    th.setAttribute('scope', 'col');
    headRow.append(th);
  }
  thead.append(headRow);

  const tbody = document.createElement('tbody');
  for (const item of items) {
    const row = document.createElement('tr');
    row.dataset.id = item.id;
    row.append(
      cell('td', item.label),
      cell('td', t.status[item.status], `status ${item.status}`),
      cell('td', item.detail, 'detail'),
      cell('td', item.neededFor),
    );
    tbody.append(row);
  }

  table.append(thead, tbody);
  container.replaceChildren(table);
}
