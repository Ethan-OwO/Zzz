// AudioWorkletProcessor 'zzz-capture': downsamples channel 0 to 16 kHz, cuts
// it into 512-sample frames and posts per-second volume statistics plus that
// second's 16 kHz PCM as Int16 (transferred, so nothing is copied).
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
  // About one second of 16 kHz audio plus headroom; grown if a period is longer.
  private pcmCap = (Math.ceil((this.quantaPerReport * 128 * OUT_RATE) / sampleRate / FRAME_SIZE) + 2) * FRAME_SIZE;
  private pcm = new Int16Array(this.pcmCap);
  private pcmLen = 0;

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
          this.appendPcm();
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
        pcm: new Int16Array(this.pcm.buffer, 0, this.pcmLen),
      };
      this.port.postMessage(stats, [this.pcm.buffer]);
      // The transferred buffer is detached; one allocation per second is fine.
      this.pcm = new Int16Array(this.pcmCap);
      this.pcmLen = 0;
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

  private appendPcm(): void {
    if (this.pcmLen + FRAME_SIZE > this.pcm.length) {
      this.pcmCap = this.pcm.length * 2;
      const grown = new Int16Array(this.pcmCap);
      grown.set(this.pcm.subarray(0, this.pcmLen));
      this.pcm = grown;
    }
    const f = this.frame;
    for (let i = 0; i < FRAME_SIZE; i++) {
      const v = Math.round(f[i]! * 32767);
      this.pcm[this.pcmLen + i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
    }
    this.pcmLen += FRAME_SIZE;
  }
}

registerProcessor('zzz-capture', CaptureProcessor);
