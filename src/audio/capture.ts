import type { CtxState, MonitorEventType, WorkletStats } from '../monitor/types';
import workletUrl from './capture-worklet.ts?worker&url';

const CTX_STATES: readonly CtxState[] = ['suspended', 'running', 'closed', 'interrupted'];

const CONSTRAINTS: MediaStreamConstraints = {
  audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
};

type OnEvent = (type: MonitorEventType, detail: string) => void;

/** 在點擊 handler 內「同步」呼叫。constructor 立刻 new AudioContext({ latencyHint: 'playback' }) 並呼叫 ctx.resume()(不 await)。 */
export class AudioCapture {
  private readonly ctx: AudioContext;
  private readonly onStats: (s: WorkletStats) => void;
  private readonly onEvent: OnEvent;
  private node: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private stream: MediaStream | null = null;
  private currentTrack: MediaStreamTrack | null = null;
  private stopped = false;

  constructor(onStats: (s: WorkletStats) => void, onEvent: OnEvent) {
    this.onStats = onStats;
    this.onEvent = onEvent;
    this.ctx = new AudioContext({ latencyHint: 'playback' });
    this.ctx.onstatechange = () => this.onEvent('ctx-state', String(this.ctx.state));
    // Must happen inside the user gesture (iOS); the promise result is not needed.
    this.ctx.resume().catch(() => {});
  }

  /** await getUserMedia、audioWorklet.addModule、建立節點並連線。失敗時 throw 原始錯誤。 */
  async start(): Promise<void> {
    const [stream] = await Promise.all([
      navigator.mediaDevices.getUserMedia(CONSTRAINTS),
      this.ctx.audioWorklet.addModule(workletUrl),
    ]);
    if (this.stopped) {
      for (const t of stream.getTracks()) t.stop();
      throw new DOMException('capture stopped during start', 'AbortError');
    }
    this.node = new AudioWorkletNode(this.ctx, 'zzz-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    this.node.port.onmessage = (e: MessageEvent<WorkletStats>) => this.onStats(e.data);
    // Connected to destination so every browser keeps calling process(); output is silent.
    this.node.connect(this.ctx.destination);
    this.attachStream(stream);
  }

  get ctxState(): CtxState {
    const s = this.ctx.state as string;
    return (CTX_STATES as readonly string[]).includes(s) ? (s as CtxState) : 'unknown';
  }

  get ctxTime(): number {
    return this.ctx.currentTime;
  }

  get sampleRate(): number {
    return this.ctx.sampleRate;
  }

  get baseLatency(): number | null {
    return typeof this.ctx.baseLatency === 'number' ? this.ctx.baseLatency : null;
  }

  get track(): MediaStreamTrack | null {
    return this.currentTrack;
  }

  /** 嘗試 ctx.resume();2 秒內狀態變成 running 回傳 true。 */
  async resumeContext(): Promise<boolean> {
    if (this.ctx.state === 'running') return true;
    if (this.ctx.state === 'closed') return false;
    const resumed = this.ctx.resume().then(() => true, () => false);
    const timeout = new Promise<boolean>((r) => setTimeout(() => r(false), 2000));
    await Promise.race([resumed, timeout]);
    return (this.ctx.state as string) === 'running';
  }

  /** 停掉舊 track,重新 getUserMedia 並把新的 source 接到同一個 worklet 節點。 */
  async restartTrack(): Promise<boolean> {
    if (!this.node || this.stopped) return false;
    this.detachStream();
    try {
      const stream = await navigator.mediaDevices.getUserMedia(CONSTRAINTS);
      if (this.stopped) {
        for (const t of stream.getTracks()) t.stop();
        return false;
      }
      this.attachStream(stream);
      return true;
    } catch (err) {
      this.onEvent('error', `restartTrack ${errText(err)}`);
      return false;
    }
  }

  /** 停掉 track、斷開節點、close ctx。 */
  async stop(): Promise<void> {
    this.stopped = true;
    this.detachStream();
    if (this.node) {
      this.node.port.onmessage = null;
      this.node.disconnect();
      this.node = null;
    }
    this.ctx.onstatechange = null;
    if (this.ctx.state !== 'closed') await this.ctx.close().catch(() => {});
  }

  private attachStream(stream: MediaStream): void {
    const track = stream.getAudioTracks()[0] ?? null;
    this.stream = stream;
    this.currentTrack = track;
    if (track) {
      track.onmute = () => this.onEvent('track-mute', '');
      track.onunmute = () => this.onEvent('track-unmute', '');
      track.onended = () => this.onEvent('track-ended', '');
    }
    this.source = this.ctx.createMediaStreamSource(stream);
    if (this.node) this.source.connect(this.node);
  }

  private detachStream(): void {
    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }
    if (this.currentTrack) {
      this.currentTrack.onmute = null;
      this.currentTrack.onunmute = null;
      this.currentTrack.onended = null;
    }
    if (this.stream) for (const t of this.stream.getTracks()) t.stop();
    this.stream = null;
    this.currentTrack = null;
  }
}

export function errText(err: unknown): string {
  if (err instanceof Error || err instanceof DOMException) return `${err.name}: ${err.message}`;
  return String(err);
}
