// M3 result: summary + time line of sound events and snore episodes with playback.
// M4 adds classification after Stop, labeling buttons, filters and the formal-mode snore audio drop.
// M6 replaces this with the real report.
import { evaluate, type EvalRow, type UserLabel } from '../classify/evaluate';
import { confidenceLevel, type SoundClass } from '../classify/rules';
import { classifyNight, dropSnoreAudio, nightMode } from '../classify/run';
import { buildNightExport, downloadExport } from '../export/json-export';
import { motionSummary } from '../motion/index';
import type { EpisodeLabel, NightRecord, SnoreEpisodeRecord, SoundEventRecord } from '../monitor/types';
import {
  deleteNight, getNight, getNightData, getSessionData, markJsonDownloaded, readEventAudio, setEpisodeLabel,
  setEventLabel,
} from '../storage/db';
import type { Nav } from './app';
import { button, el, fmtDb, hhmm, hhmmss } from './app';
import { createHoldButton } from './recording';
import { ui } from '../i18n/index';

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
    btn.textContent = ui().result.stop;
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

  /** Stops playback if it belongs to this button. */
  stopIf(btn: HTMLButtonElement): void {
    if (this.owner === btn) this.stop();
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

type Filter = 'all' | SoundClass;
const EVENT_LABELS: UserLabel[] = ['snore', 'talk', 'other', 'unsure'];
const EPISODE_LABELS: EpisodeLabel[] = ['snore', 'not-snore', 'unsure'];
const FILTERS: Filter[] = ['all', 'talk', 'snore', 'other'];

/** A row of toggle buttons: tapping the selected one again clears it (null). */
function labelRow<L extends string>(options: Array<[L, string]>, current: L | null | undefined,
  onChange: (label: L | null) => void): HTMLElement {
  const row = el('span', 'labels');
  const buttons = new Map<L, HTMLButtonElement>();
  let value: L | null = current ?? null;
  const paint = () => {
    for (const [l, b] of buttons) {
      b.classList.toggle('selected', l === value);
      b.setAttribute('aria-pressed', String(l === value));
    }
  };
  for (const [l, text] of options) {
    const b = button(text, 'label-button', () => {
      value = value === l ? null : l;
      paint();
      onChange(value);
    });
    b.dataset.label = l;
    buttons.set(l, b);
    row.append(b);
  }
  paint();
  return row;
}

/** Snore sample events without audio count as snore for the filter, even before classification. */
function filterClassOf(ev: SoundEventRecord): SoundClass | null {
  if (ev.classification) return ev.classification.cls;
  return ev.snoreEpisodeId !== null ? 'snore' : null;
}

export async function renderResult(root: HTMLElement, nightId: string, nav: Nav): Promise<void> {
  const t = ui().result;
  const CLASS_TEXT = t.cls;
  root.append(el('h1', undefined, 'Zzz'));
  const loaded = await getNight(nightId);
  if (!loaded) {
    root.append(el('p', 'error', t.notFound), button(ui().common.backHome, 'text-button', () => nav.home()));
    return;
  }
  const night: NightRecord = loaded;
  const { sessions, soundEvents, snoreEpisodes } = await getNightData(nightId);
  let gaps = 0;
  for (const s of sessions) gaps += (await getSessionData(s.id)).events.filter((e) => e.type === 'timer-gap').length;
  const monitoredMs = sessions.reduce((sum, s) => sum + Math.max(0, (s.stoppedAt ?? s.startedAt) - s.startedAt), 0);
  const mainEvents = soundEvents.filter((e) => e.continuesFrom === null);
  const snoreMs = snoreEpisodes.reduce((sum, e) => sum + Math.max(0, (e.endAt ?? e.startAt) - e.startAt), 0);
  const cal = night.calibration;
  const mode = nightMode(night);

  const list = el('dl', 'result');
  const rows: Array<[string, string, string]> = [
    [t.rows.mode, 'mode', mode === 'test' ? t.modeTest : t.modeFormal],
    [t.rows.started, 'started', new Date(night.startedAt).toLocaleString(ui().locale)],
    [t.rows.stopped, 'stopped', night.stoppedAt === null ? '–' : new Date(night.stoppedAt).toLocaleString(ui().locale)],
    [t.rows.duration, 'duration', fmtDuration(monitoredMs)],
    [t.rows.interruptions, 'interruptions', String(Math.max(0, sessions.length - 1) + gaps)],
    [t.rows.events, 'event-count', ui().common.count(mainEvents.length)],
    [t.rows.snore, 'snore-summary', t.snoreSummary(snoreEpisodes.length, Math.round(snoreMs / 60000))],
    [t.rows.classes, 'class-summary', t.analyzing],
    [t.rows.labels, 'label-summary', ''],
    [t.rows.calibration, 'calibration', cal
      ? t.calibrationValue(fmtDb(cal.floorDb), cal.speechDb === null ? '–' : fmtDb(cal.speechDb), cal.triggerMarginDb.toFixed(1))
      : '–'],
    [t.rows.motion, 'motion', await motionSummary(sessions.map((s) => s.id))],
    [t.rows.audio, 'audio-sec', ui().common.seconds(Math.round(night.audioSecUsed))],
    [t.rows.storage, 'storage', '–'],
  ];
  const cells = new Map<string, HTMLElement>();
  const terms = new Map<string, HTMLElement>();
  for (const [label, field, value] of rows) {
    const dt = el('dt', undefined, label);
    const dd = el('dd', undefined, value);
    dd.dataset.field = field;
    cells.set(field, dd);
    terms.set(field, dt);
    list.append(dt, dd);
  }
  root.append(list);
  navigator.storage?.estimate?.().then((est) => {
    const cell = cells.get('storage');
    if (cell && typeof est.usage === 'number' && typeof est.quota === 'number') {
      cell.textContent = t.storageValue(fmtMB(est.usage), fmtMB(est.quota));
    }
  }, () => {});

  const progress = el('p', 'muted');
  progress.dataset.field = 'classify-progress';
  progress.hidden = true;
  const timing = el('p', 'muted small-note');
  timing.dataset.field = 'classify-timing';
  timing.hidden = true;
  root.append(progress);

  // ---------- summary lines (classification, labels, delete reminder) ----------
  const byId = new Map(soundEvents.map((e) => [e.id, e]));
  const episodesById = new Map(snoreEpisodes.map((e) => [e.id, e]));
  const reminder = el('p', 'warning');
  reminder.dataset.field = 'label-reminder';
  reminder.textContent = t.labelReminder;

  let classifyDone = false;
  const updateSummary = () => {
    const counts: Record<SoundClass, number> = { snore: 0, talk: 0, other: 0 };
    for (const e of mainEvents) {
      const c = byId.get(e.id)?.classification;
      if (c) counts[c.cls]++;
    }
    const classCell = cells.get('class-summary')!;
    if (classifyDone) {
      classCell.textContent = t.classSummary(counts.talk, counts.snore, snoreEpisodes.length, counts.other);
    }
    const evalRows: EvalRow[] = [];
    let lastLabeledAt = 0;
    let anyLabel = false;
    for (const e of byId.values()) {
      if (e.labeledAt) lastLabeledAt = Math.max(lastLabeledAt, e.labeledAt);
      if (!e.userLabel) continue;
      anyLabel = true;
      if (e.classification) evalRows.push({ label: e.userLabel, cls: e.classification.cls });
    }
    for (const ep of episodesById.values()) {
      if (ep.labeledAt) lastLabeledAt = Math.max(lastLabeledAt, ep.labeledAt);
      if (ep.userLabel) anyLabel = true;
    }
    const r = evaluate(evalRows);
    const labelCell = cells.get('label-summary')!;
    const showLabels = r.n > 0;
    labelCell.hidden = !showLabels;
    terms.get('label-summary')!.hidden = !showLabels;
    labelCell.textContent = showLabels
      ? t.labelSummary(r.n, r.agreement === null ? '–' : String(Math.round(r.agreement * 100)))
      : '';
    reminder.hidden = !(anyLabel && (night.jsonDownloadedAt ?? 0) < lastLabeledAt);
  };

  // ---------- time line ----------
  const player = new Player();
  type Item = { at: number; ev?: SoundEventRecord; ep?: SnoreEpisodeRecord };
  const items: Item[] = [
    ...soundEvents.map((ev) => ({ at: ev.startAt, ev })),
    ...snoreEpisodes.map((ep) => ({ at: ep.startAt, ep })),
  ].sort((a, b) => a.at - b.at);
  const timeline = el('ul', 'timeline');
  const eventViews: Array<{ li: HTMLElement; update: () => void; matches: (f: Filter) => boolean }> = [];
  for (const it of items) {
    const li = el('li');
    if (it.ev) {
      const id = it.ev.id;
      const ev = () => byId.get(id)!;
      li.dataset.eventId = id;
      if (ev().continuesFrom) li.classList.add('continued');
      const first = ev();
      const secs = Math.round(((first.endAt ?? first.startAt) - first.startAt) / 1000);
      const parts = [t.eventLine(hhmmss(first.startAt), secs, fmtDb(first.peakDb))];
      if (first.snoreLike) parts.push(t.snoreLike);
      li.append(el('span', undefined, parts.join(' · ')));
      const audioNote = el('span', 'muted');
      audioNote.dataset.field = 'audio-note';
      li.append(audioNote);
      let play: HTMLButtonElement | null = null;
      if (first.hasAudio && first.sampleCount > 0) {
        play = button(t.play, 'secondary-button small', () => void player.toggle(play!, id));
        li.append(play);
      }
      const cls = el('span', 'class-line');
      cls.dataset.field = 'class';
      li.append(cls);
      li.append(labelRow(EVENT_LABELS.map((l) => [l, t.eventLabels[l]]), first.userLabel, (label) => {
        const e = ev();
        e.userLabel = label;
        e.labeledAt = Date.now();
        update();
        updateSummary();
        void setEventLabel(id, label);
      }));
      const update = () => {
        const e = ev();
        const c = e.classification;
        // Drives the colour bar on the row (style.css .timeline li[data-cls]).
        li.dataset.cls = c?.cls ?? 'none';
        if (c) {
          const text = c.cls === 'other' ? CLASS_TEXT.other : `${CLASS_TEXT[c.cls]} · ${t.confidence(t.confidenceLevel[confidenceLevel(c.confidence)])}`;
          const differs = !!e.userLabel && e.userLabel !== 'unsure' && e.userLabel !== c.cls;
          cls.textContent = differs ? `${text} ≠` : text;
          cls.classList.toggle('differs', differs);
        } else {
          cls.textContent = e.hasAudio && e.sampleCount > 0 ? t.analyzing : '';
        }
        if (e.audioDroppedAs === 'snore' || (!e.hasAudio && e.snoreEpisodeId !== null)) {
          audioNote.textContent = t.snoreNoAudio;
        } else if (!e.hasAudio) {
          audioNote.textContent = t.overBudget;
        } else {
          audioNote.textContent = '';
        }
        audioNote.hidden = audioNote.textContent === '';
        if (play && !(e.hasAudio && e.sampleCount > 0)) {
          player.stopIf(play);
          play.remove();
          play = null;
        }
      };
      const matches = (f: Filter) => f === 'all' || filterClassOf(ev()) === f || ev().userLabel === f;
      update();
      eventViews.push({ li, update, matches });
    } else if (it.ep) {
      const ep = it.ep;
      li.classList.add('snore');
      li.dataset.episodeId = ep.id;
      const mins = Math.round(((ep.endAt ?? ep.startAt) - ep.startAt) / 60000);
      li.append(el('span', undefined,
        t.episodeLine(hhmm(ep.startAt), ep.endAt === null ? '?' : hhmm(ep.endAt), mins, ep.burstCount)));
      const sample = soundEvents.find((e) => e.snoreEpisodeId === ep.id && e.hasAudio && e.sampleCount > 0);
      if (sample) {
        const play = button(t.playSample, 'secondary-button small', () => void player.toggle(play, sample.id));
        li.append(play);
        li.append(labelRow(EPISODE_LABELS.map((l) => [l, t.episodeLabels[l]]), ep.userLabel, (label) => {
          const rec = episodesById.get(ep.id)!;
          rec.userLabel = label;
          rec.labeledAt = Date.now();
          updateSummary();
          void setEpisodeLabel(ep.id, label);
        }));
      }
      eventViews.push({ li, update: () => {}, matches: (f) => f === 'all' || f === 'snore' });
    }
    timeline.append(li);
  }
  if (items.length === 0) timeline.append(el('li', 'muted', t.nothing));

  // ---------- filter ----------
  const filterRow = el('div', 'filters');
  const filterButtons = new Map<Filter, HTMLButtonElement>();
  const applyFilter = (f: Filter) => {
    for (const [k, b] of filterButtons) {
      b.classList.toggle('selected', k === f);
      b.setAttribute('aria-pressed', String(k === f));
    }
    for (const v of eventViews) v.li.hidden = !v.matches(f);
  };
  let filter: Filter = 'all';
  for (const f of FILTERS) {
    const b = button(f === 'all' ? t.filterAll : CLASS_TEXT[f], 'filter-button', () => {
      filter = f;
      applyFilter(f);
    });
    b.dataset.filter = f;
    filterButtons.set(f, b);
    filterRow.append(b);
  }
  applyFilter(filter);
  root.append(filterRow, timeline, timing);

  // ---------- classification (after Stop; re-runs only when the classifier version changed) ----------
  const classified = (async () => {
    const t0 = performance.now();
    let total = 0;
    try {
      await classifyNight(nightId, (p) => {
        total = p.total;
        progress.hidden = p.total === 0 || p.done >= p.total;
        progress.textContent = t.progress(p.done, p.total);
      });
    } catch (err) {
      progress.hidden = false;
      progress.textContent = t.failed(err instanceof Error ? err.message : String(err));
      cells.get('class-summary')!.textContent = '–';
      return;
    }
    progress.hidden = true;
    classifyDone = true;
    for (const e of (await getNightData(nightId)).soundEvents) {
      const local = byId.get(e.id);
      // Keep labels made while the analysis ran; take everything else from the database.
      if (local) byId.set(e.id, { ...e, userLabel: local.userLabel, labeledAt: local.labeledAt });
    }
    for (const v of eventViews) v.update();
    applyFilter(filter);
    updateSummary();
    if (total > 0) {
      const audioMin = soundEvents.reduce((s, e) => s + e.sampleCount, 0) / 16000 / 60;
      timing.textContent = t.timing(((performance.now() - t0) / 1000).toFixed(1), audioMin.toFixed(1));
      timing.hidden = false;
    }
  })();
  updateSummary();

  // ---------- leaving: formal mode drops the snore audio (design_M4 §5.13) ----------
  let left = false;
  // The drop runs in the background so leaving never waits on it; it is idempotent and a
  // deleted night simply has nothing left to drop.
  const leave = (): void => {
    if (left) return;
    left = true;
    window.removeEventListener('pagehide', onPageHide);
    player.stop();
    void classified.then(() => dropSnoreAudio(nightId)).catch(() => {});
  };
  // Closing the tab also leaves the page; IndexedDB may or may not finish there (best effort).
  const onPageHide = () => leave();
  window.addEventListener('pagehide', onPageHide);

  // ---------- actions ----------
  const actions = el('div', 'actions');
  actions.append(
    button(t.downloadJson, 'secondary-button', () => {
      void buildNightExport(nightId)
        .then(downloadExport)
        .then(() => markJsonDownloaded(nightId))
        .then(() => {
          night.jsonDownloadedAt = Date.now();
          updateSummary();
        });
    }),
    createHoldButton(ui().common.holdDeleteNight, 2000, () => {
      left = true;
      window.removeEventListener('pagehide', onPageHide);
      player.stop();
      void deleteNight(nightId).then(() => nav.home());
    }),
  );
  root.append(reminder, actions, button(ui().common.backHome, 'text-button', () => {
    leave();
    nav.home();
  }));
}
