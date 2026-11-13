import { renderEnvCheckTable, runEnvChecks } from '../env-check';
import { buildExport, downloadExport } from '../export/json-export';
import type { LiveStatus, RunningSession } from '../monitor/session';
import { startSession } from '../monitor/session';
import { deleteAll, listSessions } from '../storage/db';
import { createHoldButton } from './recording';

const SCENARIOS: ReadonlyArray<[string, string]> = [
  ['N1', '整晚'],
  ['P0', '基準 10 分鐘'],
  ['P1', '通知'],
  ['P2', '來電'],
  ['P3', '側鍵鎖屏'],
  ['P4', '切到別的 App'],
  ['P5', '拔充電線'],
  ['P6', '低耗電模式'],
  ['P7', '控制中心與通知中心'],
  ['P8', '鬧鐘響'],
  ['P9', '睡眠專注模式'],
  ['X', '其他'],
];

export interface HomeNav {
  /** Called once the session is running; the returned updater receives live status every second. */
  onStarted: (session: RunningSession) => (s: LiveStatus) => void;
}

/** `?hb=<seconds>` (integer 1–60) overrides the heartbeat interval; used by pnpm check only. */
function heartbeatIntervalSec(): number {
  const raw = new URLSearchParams(location.search).get('hb');
  if (raw === null || !/^\d+$/.test(raw)) return 60;
  const n = Number(raw);
  return n >= 1 && n <= 60 ? n : 60;
}

export function textButton(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'text-button';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

export function renderHome(root: HTMLElement, opts: { error?: string; errorName?: string } & HomeNav): void {
  const title = document.createElement('h1');
  title.textContent = 'Zzz';

  const label = document.createElement('label');
  label.className = 'scenario';
  const labelText = document.createElement('span');
  labelText.textContent = '測試情境';
  const select = document.createElement('select');
  for (const [value, text] of SCENARIOS) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = `${value} ${text}`;
    select.append(option);
  }
  select.value = 'N1';
  label.append(labelText, select);

  const startButton = document.createElement('button');
  startButton.type = 'button';
  startButton.className = 'start-button';
  startButton.textContent = '開始';

  root.append(title, label, startButton);

  if (opts.error) {
    const err = document.createElement('p');
    err.className = 'error';
    err.textContent = `無法開始：${opts.error}`;
    root.append(err);
    if (opts.errorName === 'NotAllowedError') {
      const hint = document.createElement('p');
      hint.className = 'error';
      hint.textContent = '請到 設定 → Safari → 麥克風 允許此網站';
      root.append(hint);
    }
  }

  let starting = false;
  let update: ((s: LiveStatus) => void) | null = null;
  startButton.addEventListener('click', () => {
    if (starting) return;
    starting = true;
    startButton.disabled = true;
    // Called synchronously inside the click so iOS user activation still applies.
    startSession({
      scenario: select.value,
      heartbeatIntervalSec: heartbeatIntervalSec(),
      onLiveStatus: (s) => update?.(s),
    }).then(
      (session) => {
        update = opts.onStarted(session);
      },
      (err: unknown) => {
        const name = err instanceof Error || err instanceof DOMException ? err.name : 'Error';
        const message = err instanceof Error || err instanceof DOMException ? err.message : String(err);
        root.replaceChildren();
        renderHome(root, { ...opts, error: `${name}: ${message}`, errorName: name });
      },
    );
  });

  const stored = document.createElement('section');
  stored.className = 'stored';
  root.append(stored);
  void renderStored(root, stored, opts);

  const envButton = textButton('環境檢查', () => {
    renderEnvCheckTable(runEnvChecks(), results);
  });
  const results = document.createElement('section');
  results.className = 'results';
  root.append(envButton, results);
}

async function renderStored(root: HTMLElement, container: HTMLElement, opts: HomeNav): Promise<void> {
  let count = 0;
  try {
    count = (await listSessions()).length;
  } catch {
    return;
  }
  if (count === 0) return;
  const p = document.createElement('p');
  p.textContent = `已存的測試紀錄：${count} 筆`;
  const download = document.createElement('button');
  download.type = 'button';
  download.className = 'secondary-button';
  download.textContent = '下載全部 JSON';
  download.addEventListener('click', () => {
    void buildExport().then(downloadExport);
  });
  const del = createHoldButton('刪除全部', 2000, () => {
    void deleteAll().then(() => {
      root.replaceChildren();
      renderHome(root, opts);
    });
  });
  const actions = document.createElement('div');
  actions.className = 'actions';
  actions.append(download, del);
  container.replaceChildren(p, actions);
}
