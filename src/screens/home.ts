import { renderEnvCheckTable, runEnvChecks } from '../env-check';
import { buildExport, downloadExport } from '../export/json-export';
import { renderPlacementPicker } from '../motion/index';
import { deleteLegacySessions, deleteNight, listLegacySessions, listNights, putNight } from '../storage/db';
import type { Nav } from './app';
import { beginSession, button, el, errorParts, hhmm, langToggle, newNight } from './app';
import { ui } from '../i18n/index';
import { renderAbout } from './about';
import { createHoldButton } from './recording';

export function textButton(label: string, onClick: () => void): HTMLButtonElement {
  return button(label, 'text-button', onClick);
}

export function renderHome(root: HTMLElement, nav: Nav, opts: { error?: string; errorName?: string } = {}): void {
  const t = ui();
  root.append(langToggle(() => nav.home()), el('h1', undefined, 'Zzz'));
  const main = el('section', 'home-main');
  root.append(main);

  if (opts.error) {
    root.append(el('p', 'error', t.common.cannotStart(opts.error)));
    if (opts.errorName === 'NotAllowedError') root.append(el('p', 'error', t.home.micDeniedHint));
  }

  const legacy = el('section', 'stored');
  root.append(legacy);
  void renderLegacy(legacy);

  const results = el('section', 'results');
  root.append(textButton(t.home.envCheck, () => renderEnvCheckTable(runEnvChecks(), results)), results);

  root.append(renderAbout());

  void renderMain(root, main, nav);
}

async function renderMain(root: HTMLElement, main: HTMLElement, nav: Nav): Promise<void> {
  const t = ui();
  let nights;
  try {
    nights = await listNights();
  } catch (err) {
    main.append(el('p', 'error', t.home.cannotRead(errorParts(err).message)));
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
      el('p', undefined, t.home.lastNightExists),
      el('p', 'muted', t.home.startedAt(new Date(last.startedAt).toLocaleDateString(t.locale), hhmm(last.startedAt))),
    );
    const actions = el('div', 'actions');
    actions.append(
      button(t.home.view, 'secondary-button', () => nav.result(last.id)),
      createHoldButton(t.common.holdDeleteNight, 2000, () => {
        void deleteNight(last.id).then(() => {
          root.replaceChildren();
          renderHome(root, nav);
        });
      }),
    );
    main.append(actions);
    return;
  }

  const start = button(t.home.start, 'start-button', () => {
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
  const placement = el('div');
  renderPlacementPicker(placement);
  main.append(placement, start);
}

async function renderLegacy(container: HTMLElement): Promise<void> {
  const t = ui();
  let count = 0;
  try {
    count = (await listLegacySessions()).length;
  } catch {
    return;
  }
  if (count === 0) return;
  const actions = el('div', 'actions');
  actions.append(
    button(t.home.downloadJson, 'secondary-button', () => {
      void buildExport().then(downloadExport);
    }),
    createHoldButton(t.home.holdDeleteLegacy, 2000, () => {
      void deleteLegacySessions().then(() => container.replaceChildren());
    }),
  );
  container.replaceChildren(el('p', 'muted', t.home.legacyCount(count)), actions);
}
