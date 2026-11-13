// Pure per-frame feature helpers. No imports: scripts/unit.mjs loads this file
// directly through Node's TypeScript type stripping.

export const DB_FLOOR = -120;
export const FRAME_SIZE = 512; // 32 ms at 16 kHz; M4's FFT reuses a power-of-two length

/** 回傳 frame 的 mean-square(Σx²/N)。 */
export function meanSquare(frame: Float32Array): number {
  const n = frame.length;
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const x = frame[i]!;
    sum += x * x;
  }
  return sum / n;
}

/** 10·log10(ms),ms 為 0 或結果低於 DB_FLOOR 時回傳 DB_FLOOR。永遠不回傳 -Infinity 或 NaN。 */
export function msToDb(ms: number): number {
  if (!(ms > 0)) return DB_FLOOR; // also catches NaN
  const db = 10 * Math.log10(ms);
  if (!Number.isFinite(db) || db < DB_FLOOR) return DB_FLOOR;
  return db;
}

/** frame 內所有樣本都是 0 時回傳 true。 */
export function isZeroFrame(frame: Float32Array): boolean {
  for (let i = 0; i < frame.length; i++) {
    if (frame[i] !== 0) return false;
  }
  return true;
}
