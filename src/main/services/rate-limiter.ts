// Token-bucket rate limiter for the producer/consumer pipeline.
// Implements §4.4.2: conservative client-side rate limiting.
// Default: 500 req/min (100 before v1.1.212). User-configurable 10–500 req/min.
// The ceiling is enforced in the constructor and in `setRate`, so a spec that
// plans a higher pace is planning something this class will silently clamp —
// NewApp 04 §3 drafted 600/min and had to be corrected to 500 for exactly that.
// see SPEC: §4.4.2

export interface RateLimiterConfig {
  /** Requests per minute. */
  requestsPerMinute: number;
  /** Burst size = refill per interval. Defaults to requestsPerMinute (full bucket). */
  burstSize?: number;
}

/**
 * Token-bucket rate limiter.
 * Tokens accumulate at a steady rate (rpm / 60 per second) up to burstSize.
 * `acquire(n)` blocks until at least n tokens are available, then consumes them.
 *
 * This is a single-instance, non-persistent limiter — state lives in memory.
 * The job queue (job-queue.ts) persists which tickers have been processed,
 * so a crash/recovery doesn't re-fetch already-fetched tickers.
 */
export class TokenBucketRateLimiter {
  private tokens: number;
  private ratePerMs: number; // tokens per millisecond
  private readonly burstSize: number;
  private lastRefillMs: number;
  private readonly resolveQueue: Array<() => void> = [];

  constructor(config: RateLimiterConfig) {
    const rpm = Math.max(1, Math.min(config.requestsPerMinute, 500));
    this.burstSize = config.burstSize ?? config.requestsPerMinute;
    this.ratePerMs = rpm / 60_000;
    this.tokens = this.burstSize;
    this.lastRefillMs = Date.now();
  }

  /** Update the rate. Used for auto-throttle after 429 responses. */
  setRate(requestsPerMinute: number): void {
    const rpm = Math.max(1, Math.min(requestsPerMinute, 500));
    this.ratePerMs = rpm / 60_000;
  }

  /** Returns the effective RPM. */
  getRate(): number {
    return Math.round(this.ratePerMs * 60_000);
  }

  /** Refill tokens based on elapsed time since last refill. */
  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefillMs;
    const newTokens = elapsed * this.ratePerMs;
    this.tokens = Math.min(this.burstSize, this.tokens + newTokens);
    this.lastRefillMs = now;
  }

  /**
   * Acquire `count` tokens. Blocks until available.
   * Multiple callers wait on the same queue; they drain in FIFO order.
   * Callers resolve after a microtask to prevent starvation.
   */
  async acquire(count = 1): Promise<void> {
    return new Promise<void>((resolve) => {
      const tryAcquire = () => {
        this.refill();
        if (this.tokens >= count) {
          this.tokens -= count;
          // **Leave the queue before waking anyone.** This callback is still at
          // the head, and `processNextInQueue` used to `shift()` — so it removed
          // *itself*, re-ran through `setImmediate`, and took a SECOND token.
          // Every acquire spent two: the effective rate was half the configured
          // one, for as long as this class has existed. Measured 2026-09-09 —
          // a burst of 10 granted exactly 5 — and invisible until then because
          // every test asked "did it resolve", never "how many tokens did that
          // cost", and the deferred re-entry does not even run under fake timers.
          const index = this.resolveQueue.indexOf(tryAcquire);
          if (index !== -1) this.resolveQueue.splice(index, 1);
          resolve();
          this.processNextInQueue();
        } else {
          // Wait until next token becomes available.
          const waitMs = Math.ceil((count - this.tokens) / this.ratePerMs);
          setTimeout(tryAcquire, Math.min(waitMs, 100)); // cap at 100ms between checks
        }
      };
      this.resolveQueue.push(tryAcquire);
      if (this.resolveQueue.length === 1) {
        tryAcquire();
      }
    });
  }

  /**
   * Wakes the next waiter, which **stays in the queue until it succeeds**.
   *
   * Peeked, not shifted. A waiter that cannot get its tokens yet re-arms itself
   * on a timer, and a shifted one would be re-armed while no longer in the
   * queue — so its position in the FIFO would be lost and `drain()` could not
   * see it. Removal is the succeeding callback's own job, in `acquire`.
   */
  private processNextInQueue(): void {
    const next = this.resolveQueue[0];
    // Defer to allow other microtasks to run (prevents starvation).
    if (next) setImmediate(next);
  }

  /** Drain the queue (called on app shutdown). */
  drain(): void {
    this.resolveQueue.length = 0;
  }
}