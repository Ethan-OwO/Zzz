// Shown when a night was not stopped normally (page closed, reloaded or crashed).
import type { NightRecord } from '../monitor/types';
import { deleteNight, getNightData, lastHeartbeatAt, putNight, putSession, putSnoreEpisode, putSoundEvents } from '../storage/db';
import type { Nav } from './app';
import { beginSession, button, el, errorParts, hhmm } from './app';

const RESUME_LIMIT_MS = 12 * 3600 * 1000;

/** Closes everything the crashed session left open. Returns the last heartbeat time of the night. */
async function finalizeNight(night: NightRecord): Promise<number> {
  const { sessions, soundEvents, snoreEpisodes } = await getNightData(night.id);
  let last = night.startedAt;
  for (const s of sessions) {
    const hb = await lastHeartbeatAt(s.id);
    const end = s.stoppedAt ?? hb ?? s.startedAt;
    last = Math.max(last, hb ?? s.startedAt, s.stoppedAt ?? 0);
    if (s.stoppedAt === null) await putSession({ ...s, stoppedAt: end });
  }
  const openEvents = soundEvents.filter((e) => e.endAt === null).map((e) => {
    const endAt = e.startAt + Math.round((e.sampleCount / 16000) * 1000);
    return { ...e, endAt, coreEndAt: e.coreEndAt ?? endAt, endReason: 'recovered' as const };
  });
  if (openEvents.length > 0) await putSoundEvents(openEvents);
  for (const ep of snoreEpisodes) {
    if (ep.endAt === null) await putSnoreEpisode({ ...ep, endAt: Math.max(ep.startAt, last), endReason: 'recovered' });
  }
  return last;
}

export async function renderRecovery(root: HTMLElement, night: NightRecord, nav: Nav): Promise<void> {
  root.append(el('h1', undefined, 'Zzz'));
  const main = el('section', 'home-main');
  root.append(main);

  if (night.status === 'calibrating') {
    main.append(
      el('p', undefined, '上次校準沒有完成'),
      button('重新開始', 'start-button', () => {
        void deleteNight(night.id).then(() => nav.home());
      }),
    );
    return;
  }

  const last = await finalizeNight(night);
  main.append(
    el('p', undefined, '上次監測沒有正常結束'),
    el('p', 'muted', `最後一筆紀錄：${hhmm(last)}`),
  );
  const error = el('p', 'error');
  error.hidden = true;
  const actions = el('div', 'actions');

  if (Date.now() - last < RESUME_LIMIT_MS && night.calibration) {
    let starting = false;
    const resume = button('繼續監測', 'start-button', () => {
      if (starting) return;
      starting = true;
      resume.disabled = true;
      // Synchronously inside the click (iOS user activation). Calibration is reused;
      // the detector warms up again for floorMinSec before anything triggers.
      beginSession(night.id).then(async (session) => {
        await session.beginDetection(night, null);
        nav.recording(session, night);
      }, (err: unknown) => {
        starting = false;
        resume.disabled = false;
        error.hidden = false;
        error.textContent = `無法開始：${errorParts(err).name}: ${errorParts(err).message}`;
      });
    });
    actions.append(resume);
  }
  actions.append(button('結束並查看', 'secondary-button', () => {
    night.status = 'stopped';
    night.stoppedAt = last;
    void putNight({ ...night }).then(() => nav.result(night.id));
  }));
  main.append(actions, error);
}
