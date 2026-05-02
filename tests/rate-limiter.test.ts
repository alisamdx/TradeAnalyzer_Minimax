import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TokenBucketRateLimiter } from '../src/main/services/rate-limiter.js';

// Helper: advance fake timers until condition is met, or timeout hits.
async function flushTimersUntil(done: () => boolean, label: string, maxMs = 5000) {
  for (let elapsed = 0; elapsed < maxMs; elapsed += 200) {
    if (done()) return;
    vi.advanceTimersByTime(200);
    await Promise.resolve(); // flush microtasks
  }
}

describe('TokenBucketRateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ─── Construction ───────────────────────────────────────────────────────────

  describe('construction', () => {
    it('clamps rate to 500 max', () => {
      const rl = new TokenBucketRateLimiter({ requestsPerMinute: 1000 });
      expect(rl.getRate()).toBeLessThanOrEqual(500);
    });

    it('clamps rate to 1 min', () => {
      const rl = new TokenBucketRateLimiter({ requestsPerMinute: 0 });
      expect(rl.getRate()).toBeGreaterThanOrEqual(1);
    });

    it('starts with a full burst of tokens', async () => {
      const rl = new TokenBucketRateLimiter({ requestsPerMinute: 60 });
      let resolved = false;
      rl.acquire(1).then(() => { resolved = true; });
      // tokens = burst = 60 → immediate resolve
      await flushTimersUntil(() => resolved, 'burst resolve');
      expect(resolved).toBe(true);
    });
  });

  // ─── setRate ───────────────────────────────────────────────────────────────

  describe('setRate', () => {
    it('updates the effective rpm', () => {
      const rl = new TokenBucketRateLimiter({ requestsPerMinute: 100 });
      rl.setRate(50);
      expect(rl.getRate()).toBe(50);
    });

    it('clamps to valid range', () => {
      const rl = new TokenBucketRateLimiter({ requestsPerMinute: 100 });
      rl.setRate(1000);
      expect(rl.getRate()).toBeLessThanOrEqual(500);
    });
  });

  // ─── acquire blocks correctly ─────────────────────────────────────────────

  it('acquire resolves immediately when tokens are available', async () => {
    const rl = new TokenBucketRateLimiter({ requestsPerMinute: 120 }); // 2/s
    let done = false;
    rl.acquire(1).then(() => { done = true; });
    await flushTimersUntil(() => done, 'immediate resolve');
    expect(done).toBe(true);
  });

  it('acquire blocks until tokens are refilled', async () => {
    const rl = new TokenBucketRateLimiter({ requestsPerMinute: 60 }); // 1/s
    // Drain all tokens.
    await rl.acquire(60);

    let resolved = false;
    rl.acquire(1).then(() => { resolved = true; });
    expect(resolved).toBe(false); // no tokens yet

    // Advance 1 second (1 token refilled).
    vi.advanceTimersByTime(1000);
    await flushTimersUntil(() => resolved, 'after refill');
    expect(resolved).toBe(true);
  });

  it('acquire consumes tokens when they are available', async () => {
    const rl = new TokenBucketRateLimiter({ requestsPerMinute: 60 });
    await rl.acquire(60); // drain
    vi.advanceTimersByTime(500); // 0.5 tokens refilled

    let resolved = false;
    rl.acquire(1).then(() => { resolved = true; });
    expect(resolved).toBe(false); // not enough

    vi.advanceTimersByTime(600); // 1.1s total → 1.1 tokens
    await flushTimersUntil(() => resolved, 'partial refill');
    expect(resolved).toBe(true);
  });

  it('acquire(n) consumes n tokens', async () => {
    const rl = new TokenBucketRateLimiter({ requestsPerMinute: 600 }); // 10/s, burst=600
    await rl.acquire(100); // spend 100, 500 left

    let resolved = false;
    rl.acquire(5).then(() => { resolved = true; });
    await flushTimersUntil(() => resolved, 'partial burst');
    expect(resolved).toBe(true); // 5 < 500, immediate
  });

  // ─── drain ─────────────────────────────────────────────────────────────────

  it('drain clears the pending queue', async () => {
    const rl = new TokenBucketRateLimiter({ requestsPerMinute: 60 });
    await rl.acquire(60); // drain

    let resolved = false;
    rl.acquire(1).then(() => { resolved = true; });
    rl.drain(); // clear queue

    vi.runAllTimers();
    await Promise.resolve();
    expect(resolved).toBe(false); // never resolves
  });

  // ─── Multiple concurrent acquires ─────────────────────────────────────────

  it('handles multiple concurrent acquire calls in order', async () => {
    const rl = new TokenBucketRateLimiter({ requestsPerMinute: 60 });
    await rl.acquire(60); // drain

    const order: number[] = [];
    rl.acquire(1).then(() => order.push(1));
    rl.acquire(1).then(() => order.push(2));

    await Promise.resolve();
    expect(order).toEqual([]); // both blocked

    vi.advanceTimersByTime(1000); // 1 token
    await flushTimersUntil(() => order.length >= 1, 'first resolve');
    expect(order).toEqual([1]);

    vi.advanceTimersByTime(1000); // 2nd token
    await flushTimersUntil(() => order.length >= 2, 'second resolve');
    expect(order).toEqual([1, 2]);
  });
});