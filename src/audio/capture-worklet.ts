// AudioWorkletProcessor 'zzz-capture': downsamples channel 0 to 16 kHz, cuts
// it into 512-sample frames and posts per-second volume statistics.
import type { WorkletStats } from '../monitor/types';
import { FRAME_SIZE, isZeroFrame, meanSquare } from './features';
import { Resampler } from './resampler';

const OUT_RATE = 16000;

class CaptureProcessor extends AudioWorkletProcessor {
  private readonly resampler = new Resampler(sampleRate, OUT_RATE);
  private readonly frame = new Float32Array(FRAME_SIZE);
  private fill = 0;
  private readonly quantaPerReport = Math.max(1, Math.round(sampleRate / 128));
  private quanta = 0;
  private frames = 0;
  private zeroFrames = 0;
  private noInputQuanta = 0;
  private minMs = Infinity;
  private maxMs = -Infinity;
  private sumMs = 0;

  process(inputs: Float32Array[][]): boolean {
    const channel = inputs[0]?.[0];
    if (!channel) {
      this.noInputQuanta++;
    } else {
      const out = this.resampler.process(channel);
      for (let i = 0; i < out.length; i++) {
        this.frame[this.fill++] = out[i]!;
        if (this.fill === FRAME_SIZE) {
          this.fill = 0;
          const ms = meanSquare(this.frame);
          this.frames++;
          if (isZeroFrame(this.frame)) this.zeroFrames++;
          if (ms < this.minMs) this.minMs = ms;
          if (ms > this.maxMs) this.maxMs = ms;
          this.sumMs += ms;
        }
      }
    }
    // Outputs are left untouched (silence).

    if (++this.quanta >= this.quantaPerReport) {
      const stats: WorkletStats = {
        frames: this.frames,
        zeroFrames: this.zeroFrames,
        noInputQuanta: this.noInputQuanta,
        minMs: this.frames > 0 ? this.minMs : null,
        maxMs: this.frames > 0 ? this.maxMs : null,
        sumMs: this.sumMs,
        ctxTime: currentTime,
      };
      this.port.postMessage(stats);
      this.quanta = 0;
      this.frames = 0;
      this.zeroFrames = 0;
      this.noInputQuanta = 0;
      this.minMs = Infinity;
      this.maxMs = -Infinity;
      this.sumMs = 0;
    }
    return true;
  }
}

registerProcessor('zzz-capture', CaptureProcessor);
