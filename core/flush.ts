// L2 batched flush. The Rozenite bridge does NO batching of its own — `send`/
// `onMessage`/`request`/`close` only (proven in verification/correlator.test.mjs).
// A per-event `send` therefore saturates the bridge at gossip rates. This flusher
// coalesces rows and ships one batch per interval (100-250ms). `add` NEVER sends;
// only the timer (or an explicit manual tick in tests) does.

export type FlushHandler<T> = (batch: T[]) => void;

/** Injected clock so tests can drive time deterministically. */
export interface TimerLike {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const DEFAULT_TIMER: TimerLike = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

export interface BatchFlusherOptions<T> {
  /** Flush cadence. Must be within the verified 100-250ms window. */
  intervalMs: number;
  onFlush: FlushHandler<T>;
  /**
   * Optional hard cap on buffered rows between flushes. If exceeded, an early
   * flush fires. This is a memory safety valve, NOT the normal path — it bounds
   * the staging buffer so a stall in the timer can't grow it without limit.
   */
  maxBatch?: number;
  timer?: TimerLike;
}

export class BatchFlusher<T> {
  readonly intervalMs: number;
  readonly maxBatch: number;

  /** Number of times a batch was actually shipped. Should track intervals, not events. */
  flushCount = 0;

  /** Batches lost because onFlush threw — non-zero means the timeline has holes. */
  droppedBatches = 0;
  droppedRows = 0;
  lastError: string | null = null;
  private batch: T[] = [];
  private readonly onFlush: FlushHandler<T>;
  private readonly timer: TimerLike;
  private handle: unknown = null;

  constructor({ intervalMs, onFlush, maxBatch = Infinity, timer = DEFAULT_TIMER }: BatchFlusherOptions<T>) {
    if (!(intervalMs >= 100 && intervalMs <= 250)) {
      throw new RangeError(`flush interval must be within the verified 100-250ms window, got ${intervalMs}`);
    }
    this.intervalMs = intervalMs;
    this.onFlush = onFlush;
    this.maxBatch = maxBatch;
    this.timer = timer;
  }

  /** Stage one row. Does NOT send — that is the whole point (invariant: batched flush). */
  add(item: T): void {
    this.batch.push(item);
    if (this.batch.length >= this.maxBatch) this.flushNow();
  }

  /** Stage many rows at once. */
  addAll(items: Iterable<T>): void {
    for (const item of items) this.add(item);
  }

  /**
   * Ship the staged batch now (called by the timer, or manually in tests).
   *
   * NEVER-THROW: runs from setInterval, so an exception here is uncatchable by the host app.
   * On failure the batch is DROPPED, never passed on — onFlush is where redaction happens, so
   * continuing past a failure would export an unredacted batch.
   */
  flushNow(): number {
    if (this.batch.length === 0) return 0;
    const out = this.batch;
    this.batch = [];
    this.flushCount++;
    try {
      this.onFlush(out);
    } catch (err) {
      this.droppedBatches++;
      this.droppedRows += out.length;
      this.lastError = err instanceof Error ? err.message : String(err);
      return 0;
    }
    return out.length;
  }

  /** Number of rows currently staged and unsent. */
  get pending(): number {
    return this.batch.length;
  }

  start(): void {
    if (this.handle !== null) return;
    this.handle = this.timer.setInterval(() => this.flushNow(), this.intervalMs);
    // Do not keep the event loop alive just for flushing, if the runtime supports it.
    const h = this.handle as { unref?: () => void };
    if (h && typeof h.unref === 'function') h.unref();
  }

  stop(): void {
    if (this.handle === null) return;
    this.timer.clearInterval(this.handle);
    this.handle = null;
    this.flushNow();
  }
}
