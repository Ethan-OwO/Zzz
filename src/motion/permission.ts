import type { MotionPermission } from './types.ts';

type PermissionFn = () => Promise<'granted' | 'denied' | string>;

function requestFn(): PermissionFn | null {
  if (typeof DeviceMotionEvent === 'undefined') return null;
  const fn = (DeviceMotionEvent as unknown as { requestPermission?: PermissionFn }).requestPermission;
  return typeof fn === 'function' ? fn.bind(DeviceMotionEvent) : null;
}

/** iOS: DeviceMotionEvent.requestPermission exists and must be called inside a tap. */
export function needsMotionPrompt(): boolean {
  return requestFn() !== null;
}

let granted = false;

/**
 * Call synchronously inside a click handler, before any await: iOS only shows
 * the prompt while the tap's user activation is still live.
 */
export function requestMotionPermissionInGesture(): Promise<MotionPermission> {
  if (typeof DeviceMotionEvent === 'undefined') return Promise.resolve('unsupported');
  const fn = requestFn();
  if (!fn) return Promise.resolve('not-required');
  if (granted) return Promise.resolve('granted');
  let pending: Promise<string>;
  try {
    pending = fn();
  } catch {
    return Promise.resolve('error');
  }
  return pending.then(
    (r) => {
      if (r === 'granted') {
        granted = true;
        return 'granted';
      }
      return 'denied';
    },
    () => 'error' as const,
  );
}
