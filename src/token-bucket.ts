type Timer = ReturnType<typeof setTimeout>;

/**
 * TokenBucket enforces a maximum sustained rate with optional burst capacity.
 * Tokens refill at a fixed rate. Consumers call `take()` before performing
 * a throttled operation; if no tokens are available, `take()` waits until
 * the bucket refills.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;
  private refillTimer?: Timer;
  private waiters: Array<() => void> = [];

  constructor(
    private readonly capacity: number,
    private readonly refillRatePerSecond: number
  ) {
    if (capacity <= 0) {
      throw new Error('TokenBucket capacity must be greater than zero');
    }
    if (refillRatePerSecond <= 0) {
      throw new Error('TokenBucket refillRatePerSecond must be greater than zero');
    }

    this.tokens = capacity;
    this.lastRefillMs = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsedSeconds = (now - this.lastRefillMs) / 1000;

    if (elapsedSeconds <= 0) {
      return;
    }

    const refillAmount = elapsedSeconds * this.refillRatePerSecond;
    if (refillAmount <= 0) {
      return;
    }

    this.tokens = Math.min(this.capacity, this.tokens + refillAmount);
    this.lastRefillMs = now;

    // Wake waiting consumers while tokens are available
    while (this.tokens >= 1 && this.waiters.length > 0) {
      this.tokens -= 1;
      const resolve = this.waiters.shift();
      resolve?.();
    }

    this.scheduleRefill();
  }

  private scheduleRefill(): void {
    if (this.refillTimer) {
      return;
    }

    const intervalMs = Math.max(50, 1000 / this.refillRatePerSecond);
    this.refillTimer = setTimeout(() => {
      this.refillTimer = undefined;
      this.refill();
    }, intervalMs);
  }

  /**
   * Wait until a token is available, then consume one.
   */
  async take(): Promise<void> {
    this.refill();

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }

    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
      this.scheduleRefill();
    });
  }

  /**
   * Stop background timers and clear pending waiters. Call during shutdown.
   */
  stop(): void {
    if (this.refillTimer) {
      clearTimeout(this.refillTimer);
      this.refillTimer = undefined;
    }
    this.waiters = [];
  }
}

