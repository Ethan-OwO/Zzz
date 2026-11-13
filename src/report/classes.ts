// Event chains, effective class, range unions (design_M6-M7 §5.3). Pure.
import type { ClassSource, ItemClass, ReportItem, ReportSoundEvent } from './types.ts';

/** Joins continuesFrom into chains, each in time order. A part whose predecessor is missing starts its own chain. */
export function chainEvents<E extends ReportSoundEvent>(events: E[]): E[][] {
  const byId = new Map(events.map((e) => [e.id, e]));
  const next = new Map<string, E>();
  const heads: E[] = [];
  for (const e of events) {
    if (e.continuesFrom !== null && byId.has(e.continuesFrom) && e.continuesFrom !== e.id) next.set(e.continuesFrom, e);
    else heads.push(e);
  }
  const chains: E[][] = [];
  const seen = new Set<string>();
  for (const h of heads) {
    const chain: E[] = [];
    for (let cur: E | undefined = h; cur && !seen.has(cur.id); cur = next.get(cur.id)) {
      seen.add(cur.id);
      chain.push(cur);
    }
    chains.push(chain);
  }
  // Parts on a cycle have no head; keep them as single chains instead of losing them.
  for (const e of events) if (!seen.has(e.id)) chains.push([e]);
  return chains.sort((a, b) => a[0]!.startAt - b[0]!.startAt);
}

const LABELS = new Set(['snore', 'talk', 'other']);

/** Effective class: the user's label first, then the auto classification, else unclassified. */
export function effectiveClass(chain: ReportSoundEvent[]): {
  cls: ItemClass; source: ClassSource; confidence: number | null; autoCls: ReportItem['autoCls']; userLabel: string | null;
} {
  const auto = chain[0]?.classification ?? null;
  const autoCls = auto ? auto.cls : null;
  // The earliest real label wins; 'unsure' (and unknown values) fall back to the auto class.
  const labeled = chain.find((e) => e.userLabel != null && LABELS.has(e.userLabel));
  const anyLabel = chain.find((e) => e.userLabel != null);
  const userLabel = (labeled ?? anyLabel)?.userLabel ?? null;
  if (labeled) return { cls: labeled.userLabel as ItemClass, source: 'user', confidence: null, autoCls, userLabel };
  if (auto) return { cls: auto.cls, source: 'auto', confidence: auto.confidence, autoCls, userLabel };
  return { cls: 'unclassified', source: 'none', confidence: null, autoCls: null, userLabel };
}

/** Total length (ms) of the union of ranges. Input need not be sorted. */
export function unionMs(ranges: Array<[number, number]>): number {
  const sorted = ranges.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  let total = 0;
  let curA = -Infinity;
  let curB = -Infinity;
  for (const [a, b] of sorted) {
    if (a > curB) {
      if (curB > curA) total += curB - curA;
      curA = a; curB = b;
    } else if (b > curB) curB = b;
  }
  if (curB > curA) total += curB - curA;
  return total;
}
