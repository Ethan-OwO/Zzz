// M4 T2: classify one night after Stop, and the formal-mode snore audio drop (design_M4 §5.6, §5.13).
// Runs on the main thread in small steps; not imported by Node scripts (it touches IndexedDB).
import { effectiveMargins } from '../detect/calibrate';
import { DEFAULT_PARAMS, SAMPLE_RATE } from '../detect/params';
import type { NightRecord, SoundEventRecord } from '../monitor/types';
import {
  deleteEventAudio, getNight, getNightData, readEventAudio, setEventClassification,
} from '../storage/db';
import { shouldDropSnoreAudio } from './drop';
import { computeEventFeatures, FEATURES_VERSION } from './event-features';
import { FrameAnalyzer } from './frame-features';
import { classify, DEFAULT_CLASSIFY_PARAMS, type ClassifyParams } from './rules';

export interface ClassifyProgress { done: number; total: number; }

/** `?dropconf=<0..1>` overrides dropMinConfidence; used by pnpm check only, never stored. */
export function activeClassifyParams(): ClassifyParams {
  const raw = new URLSearchParams(location.search).get('dropconf');
  const v = raw === null ? NaN : Number(raw);
  if (raw !== null && raw.trim() !== '' && Number.isFinite(v) && v >= 0 && v <= 1) {
    return { ...DEFAULT_CLASSIFY_PARAMS, dropMinConfidence: v };
  }
  return DEFAULT_CLASSIFY_PARAMS;
}

/** night.mode when present; else keepSnoreAudio === true → 'test'; else 'formal'. */
export function nightMode(night: NightRecord): 'formal' | 'test' {
  if (night.mode === 'formal' || night.mode === 'test') return night.mode;
  return (night as { keepSnoreAudio?: unknown }).keepSnoreAudio === true ? 'test' : 'formal';
}

/** The release margin the detector actually used that night (test mode lowers it). */
export function releaseMarginOf(night: NightRecord): number {
  const p = night.params ?? DEFAULT_PARAMS;
  if (night.calibration) return effectiveMargins(night.calibration, nightMode(night), p).release;
  return p.triggerMarginDb - p.releaseGapDb;
}

export function classifierVersion(p: ClassifyParams = DEFAULT_CLASSIFY_PARAMS): string {
  return `${FEATURES_VERSION}.${p.version}`;
}

/** Events that need (re)classification: they have audio and no result of the current version. */
function needsWork(e: SoundEventRecord, version: string): boolean {
  return e.hasAudio && e.sampleCount > 0 && e.classification?.classifierVersion !== version;
}

/** Wall-clock ms inside an event → sample index in its audio. Wall times come from frame counts, so this is exact to the ms. */
function sampleAt(e: SoundEventRecord, t: number, length: number): number {
  return Math.min(length, Math.max(0, Math.round(((t - e.startAt) / 1000) * SAMPLE_RATE)));
}

let running: { nightId: string; promise: Promise<void>; listeners: Set<(p: ClassifyProgress) => void> } | null = null;

/**
 * Classifies every hasAudio event of the night that has no classification of the current version,
 * writing back features + classification only. One event per step, with a setTimeout(0) between
 * steps so the page stays responsive. A second call while one runs returns the same Promise.
 */
export function classifyNight(nightId: string, onProgress: (p: ClassifyProgress) => void = () => {}): Promise<void> {
  if (running && running.nightId === nightId) {
    running.listeners.add(onProgress);
    return running.promise;
  }
  const listeners = new Set([onProgress]);
  const promise = (async () => {
    const night = await getNight(nightId);
    if (!night) return;
    const p = DEFAULT_CLASSIFY_PARAMS;
    const version = classifierVersion(p);
    const { soundEvents } = await getNightData(nightId);
    const todo = soundEvents.filter((e) => needsWork(e, version));
    const releaseMarginDb = releaseMarginOf(night);
    const analyzer = new FrameAnalyzer();
    const report = (done: number) => {
      for (const l of listeners) l({ done, total: todo.length });
    };
    report(0);
    for (let i = 0; i < todo.length; i++) {
      const e = todo[i]!;
      const pcm = await readEventAudio(e.id);
      // The event may have lost its audio meanwhile (formal drop); then there is nothing to analyze.
      if (pcm.length > 0) {
        const features = computeEventFeatures({
          pcm,
          coreStartSample: sampleAt(e, e.coreStartAt, pcm.length),
          coreEndSample: e.coreEndAt === null ? pcm.length : sampleAt(e, e.coreEndAt, pcm.length),
          floorDb: e.floorDbAtStart,
          releaseMarginDb,
        }, analyzer);
        await setEventClassification(e.id, features, classify(features, p));
      }
      report(i + 1);
      await new Promise((r) => setTimeout(r, 0));
    }
  })().finally(() => {
    if (running?.promise === promise) running = null;
  });
  running = { nightId, promise, listeners };
  return promise;
}

/**
 * Formal mode only: deletes the audio of every event shouldDropSnoreAudio() picks.
 * Waits for a running classification first, so it never judges half-classified data.
 * Returns how many events lost their audio.
 */
export async function dropSnoreAudio(nightId: string, p: ClassifyParams = activeClassifyParams()): Promise<number> {
  if (running?.nightId === nightId) await running.promise.catch(() => {});
  const night = await getNight(nightId);
  if (!night || nightMode(night) !== 'formal') return 0;
  const { soundEvents } = await getNightData(nightId);
  let n = 0;
  for (const e of soundEvents) {
    if (!shouldDropSnoreAudio(e, p)) continue;
    await deleteEventAudio(e.id);
    n++;
  }
  return n;
}
