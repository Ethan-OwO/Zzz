import { buildExport, downloadExport } from '../export/json-export';
import type { SessionRecord } from '../monitor/types';
import { motionSummary } from '../motion/index';
import { deleteAll, getSessionData } from '../storage/db';
import { createHoldButton } from './recording';

function fmtTime(t: number | null): string {
  if (t === null) return '–';
  return new Date(t).toLocaleString();
}

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`;
}

/** Shows one finished session. onHome is called by「回首頁」and after「刪除全部」. */
export async function renderResult(root: HTMLElement, session: SessionRecord, onHome: () => void = () => {}): Promise<void> {
  const title = document.createElement('h1');
  title.textContent = 'Zzz';
  const list = document.createElement('dl');
  list.className = 'result';
  root.append(title, list);

  const { heartbeats, events } = await getSessionData(session.id);
  const gaps = events.filter((e) => e.type === 'timer-gap');
  const gapTotal = gaps.reduce((sum, e) => sum + (Number(e.detail) || 0), 0);
  const failures = events.filter((e) => e.type === 'recovery-failed').length;

  const rows: Array<[string, string, string]> = [
    ['情境', 'scenario', session.scenario],
    ['開始', 'started', fmtTime(session.startedAt)],
    ['結束', 'stopped', fmtTime(session.stoppedAt)],
    ['時長', 'duration', fmtDuration((session.stoppedAt ?? Date.now()) - session.startedAt)],
    ['心跳筆數', 'heartbeats', String(heartbeats.length)],
    ['timer-gap', 'gaps', `${gaps.length} 次，共 ${(gapTotal / 1000).toFixed(1)} 秒`],
    ['recovery-failed', 'recovery-failed', `${failures} 次`],
    ['取樣率', 'sample-rate', session.ctxSampleRate === null ? '–' : `${session.ctxSampleRate} Hz`],
    ['動作', 'motion', await motionSummary(session.id)],
  ];
  for (const [label, field, value] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.dataset.field = field;
    dd.textContent = value;
    list.append(dt, dd);
  }

  const download = document.createElement('button');
  download.type = 'button';
  download.className = 'secondary-button';
  download.textContent = '下載全部 JSON';
  download.addEventListener('click', () => {
    void buildExport().then(downloadExport);
  });
  const del = createHoldButton('刪除全部', 2000, () => {
    void deleteAll().then(onHome);
  });
  const home = document.createElement('button');
  home.type = 'button';
  home.className = 'text-button';
  home.textContent = '回首頁';
  home.addEventListener('click', onHome);

  const actions = document.createElement('div');
  actions.className = 'actions';
  actions.append(download, del);
  root.append(actions, home);
}
