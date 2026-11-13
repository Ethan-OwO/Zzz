// Which parts' audio goes into night.wav (design_M6-M7 §6.1). Pure.
// The report may be exported before M4's dropSnoreAudio has run, so the formal-mode rule
// "snoring keeps no audio" is enforced here too, independent of when deletion happens.
import type { ReportSoundEvent } from '../report/types.ts';

export interface AudioPolicyParams { dropMinConfidence: number; }

/**
 * True when this part's audio goes into the zip. Same condition as M4 dropSnoreAudio
 * (🔗M4: replace with M4 T2's shared predicate once it exists, do not keep two copies).
 * Judged per part, exactly like dropSnoreAudio judges each stored event.
 */
export function includeAudio(ev: ReportSoundEvent, mode: 'formal' | 'test', p: AudioPolicyParams): boolean {
  if (!ev.hasAudio || ev.sampleCount <= 0) return false;
  if (mode === 'formal' && isDroppableSnore(ev, p)) return false;
  return true;
}

/** Formal-mode snore audio: auto snore with enough confidence, or a snore-episode sample; unless the user said talk / other. */
export function isDroppableSnore(ev: ReportSoundEvent, p: AudioPolicyParams): boolean {
  if (ev.userLabel === 'talk' || ev.userLabel === 'other') return false;
  const c = ev.classification;
  return (c != null && c.cls === 'snore' && c.confidence >= p.dropMinConfidence) || ev.snoreEpisodeId !== null;
}

/** Part id → sampleCount for every part whose audio goes into night.wav (the input of planWav). */
export function audioParts(events: ReportSoundEvent[], mode: 'formal' | 'test', p: AudioPolicyParams): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of events) if (includeAudio(e, mode, p)) out.set(e.id, e.sampleCount);
  return out;
}
