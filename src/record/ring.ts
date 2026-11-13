// Int16 ring buffer addressed by absolute sample index. Import-free.

/** 保留最近 capacity 個 Int16 樣本，以「絕對樣本索引」讀取。 */
export class Int16Ring {
  private readonly buf: Int16Array;
  private end = 0;   // absolute index of the next sample
  private start = 0; // absolute index of the oldest kept sample

  constructor(capacity: number) {
    this.buf = new Int16Array(Math.max(1, capacity));
  }

  /** 附加樣本;絕對索引從 0 開始遞增。 */
  push(samples: Int16Array): void {
    const cap = this.buf.length;
    let src = samples;
    if (src.length > cap) {
      // Only the last `cap` samples can be kept.
      this.end += src.length - cap;
      src = src.subarray(src.length - cap);
    }
    const pos = this.end % cap;
    const first = Math.min(src.length, cap - pos);
    this.buf.set(src.subarray(0, first), pos);
    if (first < src.length) this.buf.set(src.subarray(first), 0);
    this.end += src.length;
    this.start = Math.max(this.start, this.end - cap);
  }

  /** 最舊仍保留的絕對索引。 */
  get oldestIndex(): number {
    return this.start;
  }

  /** 下一個要寫入的絕對索引(= 已推入總數)。 */
  get endIndex(): number {
    return this.end;
  }

  /** 複製 [from, to) 的樣本;from 早於 oldestIndex 時從 oldestIndex 開始。 */
  read(from: number, to: number): Int16Array {
    const a = Math.max(from, this.start);
    const b = Math.min(to, this.end);
    if (b <= a) return new Int16Array(0);
    const cap = this.buf.length;
    const out = new Int16Array(b - a);
    const pos = a % cap;
    const first = Math.min(out.length, cap - pos);
    out.set(this.buf.subarray(pos, pos + first), 0);
    if (first < out.length) out.set(this.buf.subarray(0, out.length - first), first);
    return out;
  }

  /** 丟掉所有保留的樣本;絕對索引繼續遞增。 */
  clear(): void {
    this.start = this.end;
  }
}
