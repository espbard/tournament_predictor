// A small in-memory fixed-window rate limiter.
//
// The app runs as a single process on Railway, so memory is enough: a restart forgets the
// counters, which only ever errs on the side of letting a real user back in.

interface Window {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  private windows = new Map<string, Window>();

  constructor(private readonly limit: number, private readonly windowMs: number) {}

  /** Counts one attempt for `key`. Returns false once the key is over its limit. */
  hit(key: string, now = Date.now()): boolean {
    this.sweep(now);
    const current = this.windows.get(key);
    if (!current || current.resetAt <= now) {
      this.windows.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    current.count += 1;
    return current.count <= this.limit;
  }

  private lastSweep = 0;

  // Drop expired windows now and then, so a stream of distinct keys cannot grow the map forever.
  private sweep(now: number) {
    if (now - this.lastSweep < this.windowMs) return;
    this.lastSweep = now;
    for (const [key, w] of this.windows) {
      if (w.resetAt <= now) this.windows.delete(key);
    }
  }
}
