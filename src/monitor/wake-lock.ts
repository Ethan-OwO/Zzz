import { errText } from '../audio/capture';
import type { MonitorEventType, WakeLockStatus } from './types';

export class ScreenWakeLock {
  private readonly onEvent: (type: MonitorEventType, detail: string) => void;
  private sentinel: WakeLockSentinel | null = null;
  private current: WakeLockStatus;

  constructor(onEvent: (type: MonitorEventType, detail: string) => void) {
    this.onEvent = onEvent;
    this.current = 'wakeLock' in navigator ? 'released' : 'unsupported';
  }

  get status(): WakeLockStatus {
    return this.current;
  }

  /** 不支援時 status='unsupported' 直接 return。失敗時 status='error',記 wakelock-error(err.name),不 throw。 */
  async request(): Promise<void> {
    if (!('wakeLock' in navigator)) {
      this.current = 'unsupported';
      return;
    }
    if (this.sentinel && !this.sentinel.released) {
      this.current = 'held';
      return;
    }
    try {
      const sentinel = await navigator.wakeLock.request('screen');
      this.sentinel = sentinel;
      this.current = 'held';
      sentinel.addEventListener('release', () => {
        if (this.sentinel !== sentinel) return;
        this.sentinel = null;
        this.current = 'released';
        this.onEvent('wakelock-released', '');
      });
      this.onEvent('wakelock-acquired', '');
    } catch (err) {
      this.current = 'error';
      this.onEvent('wakelock-error', err instanceof Error || err instanceof DOMException ? err.name : errText(err));
    }
  }

  /** 主動釋放(停止時用);不記 wakelock-released 以外的事件。 */
  async release(): Promise<void> {
    const sentinel = this.sentinel;
    if (!sentinel) return;
    try {
      await sentinel.release(); // the 'release' listener records wakelock-released
    } catch {
      // ignore: releasing is best-effort while stopping
    }
  }
}
