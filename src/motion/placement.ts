// Placement lives in memory only (no localStorage, user decision 2026-11-14):
// every page load starts at 'nightstand', so the iOS prompt happens in the
// 「放床上」 tap and never competes with the microphone prompt in 「開始」.
import { requestMotionPermissionInGesture } from './permission.ts';
import type { MotionPermission, Placement } from './types.ts';

let placement: Placement = 'nightstand';
let permission: MotionPermission | null = null;
let pending: Promise<MotionPermission> | null = null;

export function getPlacement(): Placement {
  return placement;
}

export function setPlacement(p: Placement): void {
  placement = p;
}

/** Permission result from this page load; null if 「放床上」 was never tapped. */
export function lastPermission(): MotionPermission | null {
  return permission;
}

/** Resolves once a permission request started in a tap has settled (or at once if none). */
export function permissionSettled(): Promise<MotionPermission | null> {
  return pending ?? Promise.resolve(permission);
}

/** Must run synchronously inside a click handler. */
export function chooseBedInGesture(): Promise<MotionPermission> {
  placement = 'bed';
  const p = requestMotionPermissionInGesture().then((r) => {
    permission = r;
    return r;
  });
  pending = p;
  return p;
}

const HINTS: Partial<Record<MotionPermission, string>> = {
  denied: '沒有取得動作權限，今晚只用聲音。可到 設定 → Safari → 動作與方向 開啟',
  unsupported: '這支手機不支援動作感測，只用聲音',
  error: '動作權限請求失敗，今晚只用聲音',
};

export function renderPlacementPicker(container: HTMLElement): void {
  const wrap = document.createElement('div');
  wrap.className = 'placement';
  wrap.setAttribute('role', 'radiogroup');
  wrap.setAttribute('aria-label', '手機放哪裡');

  const label = document.createElement('p');
  label.className = 'placement-label';
  label.textContent = '手機放哪裡';

  const options = document.createElement('div');
  options.className = 'placement-options';

  const hint = document.createElement('p');
  hint.className = 'placement-hint';
  hint.hidden = true;

  const make = (value: Placement, text: string, sub: string) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'placement-option';
    b.dataset.placement = value;
    b.setAttribute('role', 'radio');
    const t = document.createElement('span');
    t.textContent = text;
    const s = document.createElement('small');
    s.textContent = sub;
    b.append(t, s);
    return b;
  };
  const bed = make('bed', '放床上', '聲音 + 翻身');
  const stand = make('nightstand', '放床頭櫃', '只用聲音');

  const sync = () => {
    for (const b of [bed, stand]) {
      const on = b.dataset.placement === placement;
      b.setAttribute('aria-checked', String(on));
      b.classList.toggle('selected', on);
    }
  };

  bed.addEventListener('click', () => {
    // Synchronous call inside the tap (iOS user activation).
    const req = chooseBedInGesture();
    sync();
    void req.then((r) => {
      const text = HINTS[r];
      hint.hidden = !text;
      hint.textContent = text ?? '';
    });
  });
  stand.addEventListener('click', () => {
    setPlacement('nightstand');
    hint.hidden = true;
    sync();
  });

  sync();
  options.append(bed, stand);
  wrap.append(label, options, hint);
  container.append(wrap);
}
