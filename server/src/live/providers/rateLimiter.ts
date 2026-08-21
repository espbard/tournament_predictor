// ── Provider rate limiting ────────────────────────────────────────────────────
//
// football-data's free tier allows 10 requests per minute, counted across the whole
// account. Exceeding it returns 429 and, repeated, gets the key throttled — so every
// adapter call queues through one of these rather than firing concurrently.
//
// The limiter is *serialising*: one request is in flight at a time. That is deliberate.
// With a budget this small there is nothing to gain from parallelism, and a strict FIFO
// queue makes the sync tick's request budget easy to reason about.

export interface RateLimiterOptions {
  /** Requests permitted per window. */
  limit: number;
  /** Window length in milliseconds. */
  intervalMs: number;
}

export class RateLimiter {
  private readonly limit: number;
  private readonly intervalMs: number;
  /** Completion timestamps inside the current window, oldest first. */
  private recent: number[] = [];
  /** Tail of the queue — each task chains onto the previous one. */
  private tail: Promise<unknown> = Promise.resolve();
  /** Set by a 429: no request starts before this timestamp. */
  private pausedUntil = 0;

  constructor({ limit, intervalMs }: RateLimiterOptions) {
    this.limit = Math.max(1, limit);
    this.intervalMs = intervalMs;
  }

  /**
   * Queue a request. Resolves with the task's result once the limiter's budget allows it
   * to run. Rejections propagate to the caller but never break the queue for others.
   */
  schedule<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(async () => {
      await this.waitForSlot();
      try {
        return await task();
      } finally {
        this.recent.push(Date.now());
      }
    });

    // The queue must keep draining even when a task rejects, so the chain the *next*
    // task waits on is a settled-either-way version of this one.
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Back off after a 429. `Retry-After` is in seconds; the adapter passes it straight
   * through. Applies to every queued request, not just the one that was rejected.
   */
  pauseFor(ms: number): void {
    const until = Date.now() + Math.max(0, ms);
    if (until > this.pausedUntil) this.pausedUntil = until;
  }

  /** Requests still available in the current window. For the sync tick's budgeting. */
  availableNow(): number {
    this.evictExpired();
    if (Date.now() < this.pausedUntil) return 0;
    return Math.max(0, this.limit - this.recent.length);
  }

  private evictExpired(): void {
    const cutoff = Date.now() - this.intervalMs;
    while (this.recent.length && this.recent[0] <= cutoff) this.recent.shift();
  }

  private async waitForSlot(): Promise<void> {
    for (;;) {
      this.evictExpired();

      const now = Date.now();
      if (now < this.pausedUntil) {
        await sleep(this.pausedUntil - now);
        continue;
      }
      if (this.recent.length < this.limit) return;

      // Wait for the oldest request in the window to age out, plus a small margin so a
      // clock that is a millisecond off does not spin.
      await sleep(this.recent[0] + this.intervalMs - now + 10);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
