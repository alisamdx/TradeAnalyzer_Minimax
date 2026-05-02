// Token-bucket rate limiter for the producer/consumer pipeline.
// Implements §4.4.2: conservative client-side rate limiting.
// Default: 100 req/min. User-configurable 10–500 req/min.
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

  private processNextInQueue(): void {
    if (this.resolveQueue.length > 0) {
      const next = this.resolveQueue.shift()!;
      // Defer to allow other microtasks to run (prevents starvation).
      setImmediate(next);
    }
  }

  /** Drain the queue (called on app shutdown). */
  drain(): void {
    this.resolveQueue.length = 0;
  }
}