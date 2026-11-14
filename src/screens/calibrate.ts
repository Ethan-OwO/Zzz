// Pre-sleep calibration: 30 s of quiet, then one sentence at normal volume.
// Durations are counted in audio frames, not timers.
import { adjustMargin, computeCalibration, effectiveMargins } from '../detect/calibrate.ts';
import type { CalibrationResult } from '../detect/calibrate.ts';
import { SAMPLE_RATE, FRAME_SIZE } from '../detect/params.ts';
import type { RunningSession } from '../monitor/session';
import type { NightRecord } from '../monitor/types';
import { deleteNight, putNight } from '../storage/db';
import type { Nav } from './app';
import { button, calibrationQuietSec, el, errorParts, fmtDb } from './app';
import { ui } from '../i18n/index';

const FRAMES_PER_SEC = SAMPLE_RATE / FRAME_SIZE;
const SPEECH_SEC = 10;
const MAX_SPEECH_TRIES = 3;

export function renderCalibrate(root: HTMLElement, session: RunningSession, night: NightRecord, nav: Nav): void {
  document.body.classList.add('calibrating');
  const t = ui().calibrate;
  const screen = el('div', 'calibrate-screen');
  const step = el('p', 'calibrate-step');
  const prompt = el('p', 'calibrate-prompt');
  const count = el('p', 'calibrate-count');
  count.dataset.field = 'countdown';
  const body = el('div', 'calibrate-body');
  let cancelled = false;
  const cancel = button(t.cancel, 'text-button', () => {
    if (cancelled) return;
    cancelled = true;
    session.setCalibrationListener(null);
    void session.stop().catch(() => {}).then(() => deleteNight(night.id)).finally(() => nav.home());
  });
  screen.append(step, prompt, count, body, cancel);
  root.append(screen);

  const quiet: number[] = [];
  let speech: number[] = [];
  let tries = 0;

  /** Collects `seconds` of frames, showing a countdown, then calls done. */
  function collect(seconds: number, into: number[], done: () => void): void {
    const target = Math.round(seconds * FRAMES_PER_SEC);
    let frames = 0;
    let shown = -1;
    const show = () => {
      const left = Math.max(0, Math.ceil((target - frames) / FRAMES_PER_SEC));
      if (left !== shown) {
        shown = left;
        count.textContent = String(left);
      }
    };
    show();
    session.setCalibrationListener((q, zero) => {
      frames++;
      if (!zero) into.push(q);
      show();
      if (frames >= target) {
        session.setCalibrationListener(null);
        done();
      }
    });
  }

  function quietStep(): void {
    step.textContent = '1 / 2';
    prompt.textContent = t.quiet(calibrationQuietSec());
    collect(calibrationQuietSec(), quiet, speechStep);
  }

  function speechStep(): void {
    tries++;
    speech = [];
    body.replaceChildren();
    step.textContent = '2 / 2';
    prompt.textContent = t.speech;
    collect(SPEECH_SEC, speech, showResult);
  }

  function showResult(): void {
    const base = computeCalibration(Uint8Array.from(quiet), Uint8Array.from(speech), night.params);
    let current: CalibrationResult = base;
    let adjust = 0;
    step.textContent = t.done;
    prompt.textContent = t.resultTitle;
    count.textContent = '';

    const list = el('dl', 'result');
    const row = (label: string, field: string, value: string) => {
      const dd = el('dd', undefined, value);
      dd.dataset.field = field;
      list.append(el('dt', undefined, label), dd);
      return dd;
    };
    row(t.floor, 'cal-floor', fmtDb(base.floorDb));
    row(t.speechLevel, 'cal-speech', base.speechDb === null ? '–' : fmtDb(base.speechDb));
    const margin = row(t.margin, 'cal-margin', '');
    const status = el('p', 'muted');
    status.dataset.field = 'cal-status';
    status.dataset.status = base.status;
    status.hidden = true;

    const notes: HTMLElement[] = [];
    if (base.status === 'no-speech') notes.push(el('p', 'warning', t.noSpeech));
    if (base.status === 'too-noisy') notes.push(el('p', 'warning', t.tooNoisy));

    const showMargin = () => {
      const eff = effectiveMargins(current, mode(), night.params).trigger;
      margin.textContent = t.marginValue(eff.toFixed(1));
    };
    const minus = button('−', 'secondary-button', () => {
      current = adjustMargin(current, -1, night.params);
      adjust = current.triggerMarginDb - base.triggerMarginDb;
      showMargin();
    });
    const plus = button('+', 'secondary-button', () => {
      current = adjustMargin(current, 1, night.params);
      adjust = current.triggerMarginDb - base.triggerMarginDb;
      showMargin();
    });
    minus.setAttribute('aria-label', t.lowerAria);
    plus.setAttribute('aria-label', t.raiseAria);
    const adjustRow = el('div', 'actions');
    adjustRow.append(minus, plus);

    // Formal: snoring is only logged as time ranges. Test: snores are recorded and the
    // trigger is lowered so more gets recorded, for tuning the detector.
    const modes = el('fieldset', 'modes');
    modes.append(el('legend', undefined, t.mode));
    const radios: Record<'formal' | 'test', HTMLInputElement> = { formal: el('input'), test: el('input') };
    for (const [value, label, note] of [
      ['formal', t.formal, t.formalNote],
      ['test', t.test, t.testNote(night.params.testMarginOffsetDb)],
    ] as const) {
      const r = radios[value];
      r.type = 'radio';
      r.name = 'mode';
      r.value = value;
      r.checked = value === 'formal';
      r.addEventListener('change', showMargin);
      const lab = el('label', 'checkbox');
      lab.append(r, el('span', undefined, label), el('span', 'muted', note));
      modes.append(lab);
    }
    const mode = (): 'formal' | 'test' => (radios.test.checked ? 'test' : 'formal');

    const actions = el('div', 'actions');
    if (base.status === 'no-speech' && tries < MAX_SPEECH_TRIES) {
      actions.append(button(t.again, 'secondary-button', speechStep));
    }
    let starting = false;
    const start = button(base.status === 'no-speech' ? t.useDefault : t.startSleep, 'start-button', () => {
      if (starting) return;
      starting = true;
      start.disabled = true;
      night.calibration = { ...current, userAdjustDb: adjust, at: Date.now() };
      night.mode = mode();
      night.status = 'recording';
      putNight({ ...night })
        .then(() => session.beginDetection(night, Uint8Array.from(quiet)))
        .then(() => {
          document.body.classList.remove('calibrating');
          nav.recording(session, night);
        }, (err: unknown) => {
          starting = false;
          start.disabled = false;
          status.hidden = false;
          status.textContent = ui().common.cannotStart(errorParts(err).message);
        });
    });
    actions.append(start);

    showMargin();
    body.replaceChildren(
      list, ...notes, adjustRow, modes,
      el('p', 'muted', t.tipTestMode),
      el('p', 'muted', t.tipLock),
      status, actions,
    );
  }

  quietStep();
}
