// Rule-based snore rhythm tracker: only burst length, low-band ratio and the
// breathing rhythm are used (M4 does the real classification).
import { FRAME_SEC } from './params.ts';
import type { DetectParams } from './params.ts';

export interface Burst {
  startFrame: number; endFrame: number;   // endFrame 不含
  peakDb: number;
  lowRatio: number;                       // Σ lowMs / Σ ms
}

export type SnoreOutput =
  | { type: 'confirmed'; episodeStartFrame: number; bursts: Burst[] }   // 剛確認進入打呼時段
  | { type: 'continued'; burst: Burst }
  | { type: 'ended'; lastBurstEndFrame: number }
  | null;

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export class SnoreTracker {
  private readonly p: DetectParams;
  private candidates: Burst[] = [];
  private episode = false;
  private last: Burst | null = null; // last burst of the episode

  constructor(p: DetectParams) {
    this.p = p;
  }

  get inEpisode(): boolean {
    return this.episode;
  }

  /** 判斷單一聲是否「像打呼」:長度 snoreMinBurstSec..snoreMaxBurstSec 且 lowRatio ≥ snoreMinLowRatio。 */
  isSnoreLike(b: Burst): boolean {
    const sec = (b.endFrame - b.startFrame) * FRAME_SEC;
    return sec >= this.p.snoreMinBurstSec && sec <= this.p.snoreMaxBurstSec && b.lowRatio >= this.p.snoreMinLowRatio;
  }

  /** 一聲結束時呼叫。回傳狀態變化。 */
  onBurst(b: Burst): SnoreOutput {
    const p = this.p;
    if (this.episode) {
      const last = this.last!;
      if (this.isSnoreLike(b) && (b.startFrame - last.startFrame) * FRAME_SEC <= p.snoreMaxIntervalSec + 2) {
        this.last = b;
        return { type: 'continued', burst: b };
      }
      // Not snore-like (or too far apart): the episode is unaffected; the detector records it.
      return null;
    }

    if (!this.isSnoreLike(b)) {
      this.candidates = [];
      return null;
    }
    const prev = this.candidates[this.candidates.length - 1];
    if (prev) {
      const iv = (b.startFrame - prev.startFrame) * FRAME_SEC;
      if (iv < p.snoreMinIntervalSec || iv > p.snoreMaxIntervalSec) this.candidates = [];
    }
    this.candidates.push(b);
    if (this.candidates.length > p.snoreConfirmBursts) this.candidates.shift();
    if (this.candidates.length < p.snoreConfirmBursts) return null;

    const ivs: number[] = [];
    for (let i = 1; i < this.candidates.length; i++) {
      ivs.push((this.candidates[i]!.startFrame - this.candidates[i - 1]!.startFrame) * FRAME_SEC);
    }
    const med = median(ivs);
    if (!ivs.every((iv) => Math.abs(iv - med) / med <= p.snoreIntervalTolerance)) return null;

    const bursts = this.candidates;
    this.candidates = [];
    this.episode = true;
    this.last = b;
    return { type: 'confirmed', episodeStartFrame: bursts[0]!.startFrame, bursts };
  }

  /** 每幀呼叫，用來判斷「太久沒有一聲」而結束時段。 */
  onFrame(frameIndex: number): SnoreOutput {
    if (!this.episode) return null;
    const last = this.last!;
    if ((frameIndex - last.endFrame) * FRAME_SEC > this.p.snoreEndSec) {
      this.episode = false;
      this.last = null;
      this.candidates = [];
      return { type: 'ended', lastBurstEndFrame: last.endFrame };
    }
    return null;
  }

  reset(): void {
    this.candidates = [];
    this.episode = false;
    this.last = null;
  }
}
