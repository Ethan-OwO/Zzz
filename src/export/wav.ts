// WAV header and night.wav layout (design_M6-M7 §6.2). Pure.
import type { NightReport } from '../report/types.ts';

export const WAV_RATE = 16000;
export const CLIP_GAP_SEC = 1; // 🎛 silence between two events

/** 44-byte PCM WAV header: RIFF / fmt / data, mono, 16-bit, 16 kHz, little-endian. */
export function wavHeader(dataBytes: number): Uint8Array {
  const b = new Uint8Array(44);
  const v = new DataView(b.buffer);
  const tag = (o: number, s: string) => { for (let i = 0; i < 4; i++) b[o + i] = s.charCodeAt(i); };
  tag(0, 'RIFF');
  v.setUint32(4, 36 + dataBytes, true);  // RIFF chunk size = everything after this field
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  v.setUint32(16, 16, true);             // fmt chunk size (PCM)
  v.setUint16(20, 1, true);              // format 1 = PCM
  v.setUint16(22, 1, true);              // channels
  v.setUint32(24, WAV_RATE, true);       // sample rate
  v.setUint32(28, WAV_RATE * 2, true);   // byte rate = rate × block align
  v.setUint16(32, 2, true);              // block align = channels × 2 bytes
  v.setUint16(34, 16, true);             // bits per sample
  tag(36, 'data');
  v.setUint32(40, dataBytes, true);
  return b;
}

export interface WavClip { itemId: string; partIds: string[]; samples: number; startSec: number; endSec: number; }
export interface WavPlan { clips: WavClip[]; totalSamples: number; dataBytes: number; }

const ms3 = (x: number) => Math.round(x * 1000) / 1000;

/**
 * Lays the events with audio into night.wav in report.items order. partSamples = part id →
 * sampleCount of the parts that go in (audioParts() in audio-policy.ts); other parts are skipped.
 * Parts of one chain are back to back (M3 splits seamlessly); events get CLIP_GAP_SEC of zeros between them.
 */
export function planWav(report: NightReport, partSamples: Map<string, number>): WavPlan {
  const gap = CLIP_GAP_SEC * WAV_RATE;
  const clips: WavClip[] = [];
  let cursor = 0;
  for (const it of report.items) {
    if (it.kind !== 'event') continue;
    const parts = it.partIds.filter((id) => (partSamples.get(id) ?? 0) > 0);
    if (parts.length === 0) continue;
    if (clips.length > 0) cursor += gap;
    const samples = parts.reduce((n, id) => n + partSamples.get(id)!, 0);
    clips.push({ itemId: it.id, partIds: parts, samples, startSec: ms3(cursor / WAV_RATE), endSec: ms3((cursor + samples) / WAV_RATE) });
    cursor += samples;
  }
  return { clips, totalSamples: cursor, dataBytes: cursor * 2 };
}
