// L2 storage primitive. Invariant #1: memory is bounded — this is a fixed-size
// ring over a pre-allocated backing array, NOT an array that grows then shifts.
// Invariant #2: evictions are observable via `dropped`, which the UI renders as
// a gap marker. A silent drop makes the tool lie.
//
// Why a true ring and not `push`+`shift`: `Array.prototype.shift` is O(n) — it
// reindexes the whole backing store on every eviction. At gossip rates that is a
// per-event O(n) tax. This ring is O(1) push, O(1) evict, and the backing array
// never grows past `capacity`.

export class RingBuffer<T> {
  readonly capacity: number;
  /** Number of items evicted because the buffer was full. Observable, not silent. */
  dropped = 0;

  private readonly buf: Array<T | undefined>;
  /** Index of the oldest live item. */
  private head = 0;
  /** Number of live items currently held (0..capacity). */
  private count = 0;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError(`RingBuffer capacity must be a positive integer, got ${capacity}`);
    }
    this.capacity = capacity;
    this.buf = new Array<T | undefined>(capacity);
  }

  /** Live item count. Never exceeds `capacity`. */
  get length(): number {
    return this.count;
  }

  /**
   * Append one item. If full, the oldest item is overwritten and `dropped` is
   * incremented so the drop is countable, never silent.
   */
  push(item: T): void {
    if (this.count === this.capacity) {
      this.buf[this.head] = item;
      this.head = (this.head + 1) % this.capacity;
      this.dropped++;
    } else {
      this.buf[(this.head + this.count) % this.capacity] = item;
      this.count++;
    }
  }

  /** Oldest-to-newest iteration without materialising an array. */
  *[Symbol.iterator](): IterableIterator<T> {
    for (let i = 0; i < this.count; i++) {
      yield this.buf[(this.head + i) % this.capacity] as T;
    }
  }

  /** First item (oldest-first) matching `pred`, or undefined. */
  find(pred: (item: T, index: number) => boolean): T | undefined {
    let i = 0;
    for (const item of this) {
      if (pred(item, i)) return item;
      i++;
    }
    return undefined;
  }

  /** Snapshot copy, oldest-to-newest. Allocates; use for flush/inspection only. */
  toArray(): T[] {
    const out: T[] = new Array(this.count);
    for (let i = 0; i < this.count; i++) {
      out[i] = this.buf[(this.head + i) % this.capacity] as T;
    }
    return out;
  }

  /** Drain everything into a fresh array and reset to empty. Does not touch `dropped`. */
  drain(): T[] {
    const out = this.toArray();
    this.clear();
    return out;
  }

  /** Empty the buffer. Preserves the `dropped` counter (cumulative history). */
  clear(): void {
    for (let i = 0; i < this.count; i++) {
      this.buf[(this.head + i) % this.capacity] = undefined;
    }
    this.head = 0;
    this.count = 0;
  }
}
