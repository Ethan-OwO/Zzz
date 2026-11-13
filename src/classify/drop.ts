// Formal mode: which events lose their audio when the user leaves the result page
// (design_M4 §5.13). Pure, so M7's audio policy and the unit tests can share it.
import type { UserLabel } from './evaluate.ts';
import type { Classification, ClassifyParams } from './rules.ts';

/** The fields of SoundEventRecord this rule reads (kept structural so Node can import this file). */
export interface DropCandidate {
  hasAudio: boolean;
  snoreEpisodeId: string | null;
  classification?: Classification | null;
  userLabel?: UserLabel | null;
}

/**
 * true → delete this event's audio in formal mode:
 * (a) classified snore with confidence ≥ dropMinConfidence, or (b) an M3 snore sample event;
 * never when the user labeled it talk or other (they heard it and disagreed).
 */
export function shouldDropSnoreAudio(e: DropCandidate, p: Pick<ClassifyParams, 'dropMinConfidence'>): boolean {
  if (!e.hasAudio) return false;
  if (e.userLabel === 'talk' || e.userLabel === 'other') return false;
  const c = e.classification;
  const snore = !!c && c.cls === 'snore' && c.confidence >= p.dropMinConfidence;
  return snore || e.snoreEpisodeId !== null;
}
