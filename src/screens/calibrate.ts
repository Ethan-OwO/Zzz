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

const FRAMES_PER_SEC = SAMPLE_RATE / FRAME_SIZE;
const SPEECH_SEC = 10;
const MAX_SPEECH_TRIES = 3;

export function renderCalibrate(root: HTMLElement, session: RunningSession, night: NightRecord, nav: Nav): void {
  document.body.classList.add('calibrating');
  const screen = el('div', 'calibrate-screen');
  const step = el('p', 'calibrate-step');
  const prompt = el('p', 'calibrate-prompt');
  const count = el('p', 'calibrate-count');
  count.dataset.field = 'countdown';
  const body = el('div', 'calibrate-body');
  let cancelled = false;
  const cancel = button('取消', 'text-button', () => {
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
    prompt.textContent = `請保持安靜 ${calibrationQuietSec()} 秒，讓 Zzz 學習房間的背景聲音`;
    collect(calibrationQuietSec(), quiet, speechStep);
  }

  function speechStep(): void {
    tries++;
    speech = [];
    body.replaceChildren();
    step.textContent = '2 / 2';
    prompt.textContent = '用平常講話的音量，在枕頭的位置說：「晚安 Zzz，今天也辛苦了」';
    collect(SPEECH_SEC, speech, showResult);
  }

  function showResult(): void {
    const base = computeCalibration(Uint8Array.from(quiet), Uint8Array.from(speech), night.params);
    let current: CalibrationResult = base;
    let adjust = 0;
    step.textContent = '完成';
    prompt.textContent = '校準結果';
    count.textContent = '';

    const list = el('dl', 'result');
    const row = (label: string, field: string, value: string) => {
      const dd = el('dd', undefined, value);
      dd.dataset.field = field;
      list.append(el('dt', undefined, label), dd);
      return dd;
    };
    row('背景', 'cal-floor', fmtDb(base.floorDb));
    row('說話', 'cal-speech', base.speechDb === null ? '–' : fmtDb(base.speechDb));
    const margin = row('觸發門檻', 'cal-margin', '');
    const status = el('p', 'muted');
    status.dataset.field = 'cal-status';
    status.dataset.status = base.status;
    status.hidden = true;

    const notes: HTMLElement[] = [];
    if (base.status === 'no-speech') notes.push(el('p', 'warning', '沒有聽清楚說話聲'));
    if (base.status === 'too-noisy') notes.push(el('p', 'warning', '背景聲音起伏很大，說話可能不容易分辨'));

    const showMargin = () => {
      const eff = effectiveMargins(current, mode(), night.params).trigger;
      margin.textContent = `背景 +${eff.toFixed(1)} dB`;
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
    minus.setAttribute('aria-label', '門檻降低 1 dB');
    plus.setAttribute('aria-label', '門檻提高 1 dB');
    const adjustRow = el('div', 'actions');
    adjustRow.append(minus, plus);

    // Formal: snoring is only logged as time ranges. Test: snores are recorded and the
    // trigger is lowered so more gets recorded, for tuning the detector.
    const modes = el('fieldset', 'modes');
    modes.append(el('legend', undefined, '模式'));
    const radios: Record<'formal' | 'test', HTMLInputElement> = { formal: el('input'), test: el('input') };
    for (const [value, label, note] of [
      ['formal', '正式', '打呼只記時段，不錄音'],
      ['test', '測試', `打呼也錄音、門檻再降 ${night.params.testMarginOffsetDb} dB,會多錄一些`],
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
      actions.append(button('再說一次', 'secondary-button', speechStep));
    }
    let starting = false;
    const start = button(base.status === 'no-speech' ? '用預設門檻' : '開始睡覺', 'start-button', () => {
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
          status.textContent = `無法開始：${errorParts(err).message}`;
        });
    });
    actions.append(start);

    showMargin();
    body.replaceChildren(
      list, ...notes, adjustRow, modes,
      el('p', 'muted', '前幾晚建議用測試模式，早上可以聽聽看打呼判斷得準不準'),
      el('p', 'muted', '可以鎖屏，請保持充電。這些數值之後還會依實際使用調整。'),
      status, actions,
    );
  }

  quietStep();
}
