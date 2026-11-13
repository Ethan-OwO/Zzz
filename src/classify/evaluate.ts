// Labels vs automatic classes (§5.5). Pure; also used by scripts/eval-labels.mjs.
import type { SoundClass } from './rules.ts';

export type UserLabel = 'snore' | 'talk' | 'other' | 'unsure';

export interface EvalRow {
  label: UserLabel;
  cls: SoundClass;
}

export interface EvalResult {
  n: number; // 排除 unsure 後的筆數
  matrix: Record<SoundClass, Record<SoundClass, number>>; // matrix[標記][自動]
  agreement: number | null; // 對角線 / n
  /** 「誤判率」= 被自動判成該類的事件中，標記不是該類的比例(= 1 − precision)。分母為 0 → null。 */
  falseRate: { snore: number | null; talk: number | null };
  /** 召回率：標記為該類的事件中，自動也判成該類的比例。 */
  recall: { snore: number | null; talk: number | null };
  counts: Record<SoundClass, number>; // 各標記類別的筆數
}

const CLASSES: SoundClass[] = ['snore', 'talk', 'other'];

export function evaluate(rows: EvalRow[]): EvalResult {
  const row = (): Record<SoundClass, number> => ({ snore: 0, talk: 0, other: 0 });
  const matrix: EvalResult['matrix'] = { snore: row(), talk: row(), other: row() };
  const counts = row();
  let n = 0;
  for (const r of rows) {
    if (r.label === 'unsure') continue;
    matrix[r.label][r.cls]++;
    counts[r.label]++;
    n++;
  }
  let diag = 0;
  for (const c of CLASSES) diag += matrix[c][c];
  const predicted = (c: SoundClass): number => CLASSES.reduce((a, l) => a + matrix[l][c], 0);
  const falseRateOf = (c: SoundClass): number | null => {
    const d = predicted(c);
    return d === 0 ? null : (d - matrix[c][c]) / d;
  };
  const recallOf = (c: SoundClass): number | null => (counts[c] === 0 ? null : matrix[c][c] / counts[c]);
  return {
    n,
    matrix,
    agreement: n === 0 ? null : diag / n,
    falseRate: { snore: falseRateOf('snore'), talk: falseRateOf('talk') },
    recall: { snore: recallOf('snore'), talk: recallOf('talk') },
    counts,
  };
}
