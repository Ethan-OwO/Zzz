export type CheckStatus = 'ok' | 'fail' | 'unknown';

export interface EnvCheckItem {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  neededFor: string;
}

interface CheckDef {
  id: string;
  label: string;
  neededFor: string;
  detect: () => { status: CheckStatus; detail: string };
}

function bool(value: boolean): { status: CheckStatus; detail: string } {
  return { status: value ? 'ok' : 'fail', detail: String(value) };
}

const CHECKS: readonly CheckDef[] = [
  {
    id: 'secure-context',
    label: '安全連線 (HTTPS)',
    neededFor: 'M2 錄音',
    detect: () => bool(window.isSecureContext),
  },
  {
    id: 'get-user-media',
    label: '麥克風 API',
    neededFor: 'M2 錄音',
    detect: () => bool(typeof navigator.mediaDevices?.getUserMedia === 'function'),
  },
  {
    id: 'audio-worklet',
    label: 'AudioWorklet',
    neededFor: 'M2 音訊處理',
    detect: () => bool(typeof AudioWorkletNode === 'function'),
  },
  {
    id: 'wake-lock',
    label: '螢幕常亮 (Wake Lock)',
    neededFor: 'M2 整夜存活',
    detect: () => bool('wakeLock' in navigator),
  },
  {
    id: 'indexed-db',
    label: 'IndexedDB',
    neededFor: 'M3 邊錄邊存',
    detect: () => bool('indexedDB' in window && window.indexedDB !== null),
  },
  {
    id: 'device-motion',
    label: '動作感測權限模型',
    neededFor: 'M5 動作感測',
    detect: () => {
      if (typeof DeviceMotionEvent === 'undefined') {
        return { status: 'fail', detail: '無 DeviceMotionEvent' };
      }
      if (typeof (DeviceMotionEvent as any).requestPermission === 'function') {
        return { status: 'ok', detail: '需手勢內請求 (iOS)' };
      }
      return { status: 'ok', detail: '免請求' };
    },
  },
  {
    id: 'file-share',
    label: '分享檔案',
    neededFor: 'M7 匯出',
    detect: () => {
      if (typeof navigator.canShare !== 'function') {
        return { status: 'unknown', detail: '無 canShare' };
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
    label: '瀏覽器 UA',
    neededFor: '回報問題對照',
    detect: () => ({ status: 'unknown', detail: navigator.userAgent }),
  },
];

/** 只做功能偵測，同步回傳。不請求任何權限。 */
export function runEnvChecks(): EnvCheckItem[] {
  return CHECKS.map(({ id, label, neededFor, detect }) => {
    try {
      const { status, detail } = detect();
      return { id, label, status, detail, neededFor };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return { id, label, status: 'unknown', detail, neededFor };
    }
  });
}

const STATUS_TEXT: Record<CheckStatus, string> = {
  ok: '通過',
  fail: '不通過',
  unknown: '無法判斷',
};

function cell(tag: 'td' | 'th', text: string, className?: string): HTMLElement {
  const el = document.createElement(tag);
  el.textContent = text;
  if (className) el.className = className;
  return el;
}

/** 在 container 內建立(或取代)一個 <table>,每個 item 一列。 */
export function renderEnvCheckTable(items: EnvCheckItem[], container: HTMLElement): void {
  const table = document.createElement('table');
  table.className = 'env-check';

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const heading of ['項目', '狀態', '偵測值', '用於']) {
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
      cell('td', STATUS_TEXT[item.status], `status ${item.status}`),
      cell('td', item.detail, 'detail'),
      cell('td', item.neededFor),
    );
    tbody.append(row);
  }

  table.append(thead, tbody);
  container.replaceChildren(table);
}
