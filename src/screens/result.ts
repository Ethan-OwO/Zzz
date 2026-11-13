// M3 result: summary + time line of sound events and snore episodes with playback.
// M6 replaces this with the real report.
import { buildNightExport, downloadExport } from '../export/json-export';
import type { SnoreEpisodeRecord, SoundEventRecord } from '../monitor/types';
import { deleteNight, getNight, getNightData, getSessionData, readEventAudio } from '../storage/db';
import type { Nav } from './app';
import { button, el, fmtDb, hhmm, hhmmss } from './app';
import { createHoldButton } from './recording';

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`;
}

function fmtMB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

/** One AudioContext for the whole page, created on the first tap; one sound at a time. */
class Player {
  private ctx: AudioContext | null = null;
  private source: AudioBufferSourceNode | null = null;
  private owner: HTMLButtonElement | null = null;
  private ownerLabel = '';

  async toggle(btn: HTMLButtonElement, eventId: string): Promise<void> {
    if (this.owner === btn) {
      this.stop();
      return;
    }
    this.stop();
    // Created inside the tap so iOS allows playback.
    this.ctx ??= new AudioContext();
    void this.ctx.resume();
    this.owner = btn;
    this.ownerLabel = btn.textContent ?? '';
    btn.textContent = '停止';
    const pcm = await readEventAudio(eventId);
    if (this.owner !== btn || pcm.length === 0) {
      if (this.owner === btn) this.stop();
      return;
    }
    const buf = this.ctx.createBuffer(1, pcm.length, 16000);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i]! / 32768;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.ctx.destination);
    src.onended = () => {
      if (this.source === src) this.stop();
    };
    this.source = src;
    src.start();
  }

  stop(): void {
    if (this.source) {
      this.source.onended = null;
      try {
        this.source.stop();
      } catch {
        // already stopped
      }
      this.source.disconnect();
      this.source = null;
    }
    if (this.owner) this.owner.textContent = this.ownerLabel;
    this.owner = null;
  }
}

export async function renderResult(root: HTMLElement, nightId: string, nav: Nav): Promise<void> {
  root.append(el('h1', undefined, 'Zzz'));
  const night = await getNight(nightId);
  if (!night) {
    root.append(el('p', 'error', '找不到這一晚的紀錄'), button('回首頁', 'text-button', () => nav.home()));
    return;
  }
  const { sessions, soundEvents, snoreEpisodes } = await getNightData(nightId);
  let gaps = 0;
  for (const s of sessions) gaps += (await getSessionData(s.id)).events.filter((e) => e.type === 'timer-gap').length;
  const monitoredMs = sessions.reduce((sum, s) => sum + Math.max(0, (s.stoppedAt ?? s.startedAt) - s.startedAt), 0);
  const mainEvents = soundEvents.filter((e) => e.continuesFrom === null);
  const snoreMs = snoreEpisodes.reduce((sum, e) => sum + Math.max(0, (e.endAt ?? e.startAt) - e.startAt), 0);
  const cal = night.calibration;

  const list = el('dl', 'result');
  const rows: Array<[string, string, string]> = [
    ['開始', 'started', new Date(night.startedAt).toLocaleString()],
    ['結束', 'stopped', night.stoppedAt === null ? '–' : new Date(night.stoppedAt).toLocaleString()],
    ['監測總長', 'duration', fmtDuration(monitoredMs)],
    ['中斷次數', 'interruptions', String(Math.max(0, sessions.length - 1) + gaps)],
    ['事件', 'event-count', `${mainEvents.length} 個`],
    ['打呼', 'snore-summary', `${snoreEpisodes.length} 段，共 ${Math.round(snoreMs / 60000)} 分鐘`],
    ['校準', 'calibration', cal
      ? `背景 ${fmtDb(cal.floorDb)}、說話 ${cal.speechDb === null ? '–' : fmtDb(cal.speechDb)}、門檻 +${cal.triggerMarginDb.toFixed(1)} dB`
      : '–'],
    ['已用音訊', 'audio-sec', `${Math.round(night.audioSecUsed)} 秒`],
    ['儲存空間', 'storage', '–'],
  ];
  const cells = new Map<string, HTMLElement>();
  for (const [label, field, value] of rows) {
    const dd = el('dd', undefined, value);
    dd.dataset.field = field;
    cells.set(field, dd);
    list.append(el('dt', undefined, label), dd);
  }
  root.append(list);
  navigator.storage?.estimate?.().then((est) => {
    const cell = cells.get('storage');
    if (cell && typeof est.usage === 'number' && typeof est.quota === 'number') {
      cell.textContent = `已用 ${fmtMB(est.usage)} / 可用 ${fmtMB(est.quota)}`;
    }
  }, () => {});

  // ---------- time line ----------
  const player = new Player();
  type Item = { at: number; ev?: SoundEventRecord; ep?: SnoreEpisodeRecord };
  const items: Item[] = [
    ...soundEvents.map((ev) => ({ at: ev.startAt, ev })),
    ...snoreEpisodes.map((ep) => ({ at: ep.startAt, ep })),
  ].sort((a, b) => a.at - b.at);
  const timeline = el('ul', 'timeline');
  for (const it of items) {
    const li = el('li');
    if (it.ev) {
      const ev = it.ev;
      li.dataset.eventId = ev.id;
      if (ev.continuesFrom) li.classList.add('continued');
      const secs = Math.round(((ev.endAt ?? ev.startAt) - ev.startAt) / 1000);
      const parts = [`${hhmmss(ev.startAt)} · ${secs} 秒 · 最大 ${fmtDb(ev.peakDb)}`];
      if (ev.snoreLike) parts.push('像打呼');
      li.append(el('span', undefined, parts.join(' · ')));
      if (!ev.hasAudio) li.append(el('span', 'muted', '(超過音訊上限，未錄音)'));
      else if (ev.sampleCount > 0) {
        const play = button('播放', 'secondary-button small', () => void player.toggle(play, ev.id));
        li.append(play);
      }
    } else if (it.ep) {
      const ep = it.ep;
      li.classList.add('snore');
      const mins = Math.round(((ep.endAt ?? ep.startAt) - ep.startAt) / 60000);
      li.append(el('span', undefined,
        `${hhmm(ep.startAt)} – ${ep.endAt === null ? '?' : hhmm(ep.endAt)} · 打呼 ${mins} 分鐘 · 約 ${ep.burstCount} 聲`));
      const sample = soundEvents.find((e) => e.snoreEpisodeId === ep.id && e.hasAudio && e.sampleCount > 0);
      if (sample) {
        const play = button('聽樣本', 'secondary-button small', () => void player.toggle(play, sample.id));
        li.append(play);
      }
    }
    timeline.append(li);
  }
  if (items.length === 0) timeline.append(el('li', 'muted', '沒有記錄到任何聲音'));
  root.append(timeline);

  // ---------- actions ----------
  const actions = el('div', 'actions');
  actions.append(
    button('下載除錯 JSON', 'secondary-button', () => {
      void buildNightExport(nightId).then(downloadExport);
    }),
    createHoldButton('長按 2 秒刪除這一晚', 2000, () => {
      player.stop();
      void deleteNight(nightId).then(() => nav.home());
    }),
  );
  root.append(actions, button('回首頁', 'text-button', () => {
    player.stop();
    nav.home();
  }));
}
