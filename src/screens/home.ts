import { renderEnvCheckTable, runEnvChecks } from '../env-check';
import { buildExport, downloadExport } from '../export/json-export';
import { deleteLegacySessions, deleteNight, listLegacySessions, listNights, putNight } from '../storage/db';
import type { Nav } from './app';
import { beginSession, button, el, errorParts, hhmm, newNight } from './app';
import { createHoldButton } from './recording';

export function textButton(label: string, onClick: () => void): HTMLButtonElement {
  return button(label, 'text-button', onClick);
}

export function renderHome(root: HTMLElement, nav: Nav, opts: { error?: string; errorName?: string } = {}): void {
  root.append(el('h1', undefined, 'Zzz'));
  const main = el('section', 'home-main');
  root.append(main);

  if (opts.error) {
    root.append(el('p', 'error', `無法開始：${opts.error}`));
    if (opts.errorName === 'NotAllowedError') root.append(el('p', 'error', '請到 設定 → Safari → 麥克風 允許此網站'));
  }

  const legacy = el('section', 'stored');
  root.append(legacy);
  void renderLegacy(legacy);

  const results = el('section', 'results');
  root.append(textButton('環境檢查', () => renderEnvCheckTable(runEnvChecks(), results)), results);

  void renderMain(root, main, nav);
}

async function renderMain(root: HTMLElement, main: HTMLElement, nav: Nav): Promise<void> {
  let nights;
  try {
    nights = await listNights();
  } catch (err) {
    main.append(el('p', 'error', `無法讀取紀錄：${errorParts(err).message}`));
    return;
  }
  const unfinished = nights.find((n) => n.status !== 'stopped');
  if (unfinished) {
    nav.recovery(unfinished);
    return;
  }
  const last = nights[nights.length - 1];
  if (last) {
    // One night at a time: the previous night must be deleted before a new one starts.
    main.append(
      el('p', undefined, '上一晚的紀錄還在'),
      el('p', 'muted', `${new Date(last.startedAt).toLocaleDateString()} ${hhmm(last.startedAt)} 開始`),
    );
    const actions = el('div', 'actions');
    actions.append(
      button('查看', 'secondary-button', () => nav.result(last.id)),
      createHoldButton('長按 2 秒刪除這一晚', 2000, () => {
        void deleteNight(last.id).then(() => {
          root.replaceChildren();
          renderHome(root, nav);
        });
      }),
    );
    main.append(actions);
    return;
  }

  const start = button('開始', 'start-button', () => {
    if (start.disabled) return;
    start.disabled = true;
    const night = newNight();
    // Called synchronously inside the click so iOS user activation still applies.
    const sessionPromise = beginSession(night.id);
    const saved = putNight(night);
    Promise.all([sessionPromise, saved]).then(
      ([session]) => nav.calibrate(session, night),
      (err: unknown) => {
        const { name, message } = errorParts(err);
        void sessionPromise.then((s) => s.stop(), () => {});
        void saved.then(() => deleteNight(night.id), () => {}).finally(() => {
          nav.home({ error: `${name}: ${message}`, errorName: name });
        });
      },
    );
  });
  main.append(start);
}

async function renderLegacy(container: HTMLElement): Promise<void> {
  let count = 0;
  try {
    count = (await listLegacySessions()).length;
  } catch {
    return;
  }
  if (count === 0) return;
  const actions = el('div', 'actions');
  actions.append(
    button('下載 JSON', 'secondary-button', () => {
      void buildExport().then(downloadExport);
    }),
    createHoldButton('長按刪除舊紀錄', 2000, () => {
      void deleteLegacySessions().then(() => container.replaceChildren());
    }),
  );
  container.replaceChildren(el('p', 'muted', `舊的測試紀錄：${count} 筆`), actions);
}
