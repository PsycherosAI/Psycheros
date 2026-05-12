/**
 * Entity Loom — Rate Limiter
 *
 * Simple token bucket rate limiter for LLM API calls.
 */

export class RateLimiter {
  private minIntervalMs: number;
  private lastCallTime = 0;
  private consecutiveFailures = 0;

  constructor(minIntervalMs: number) {
    this.minIntervalMs = minIntervalMs;
  }

  /** Wait the required interval before the next call */
  async wait(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastCallTime;

    if (elapsed < this.minIntervalMs) {
      await new Promise((resolve) =>
        setTimeout(resolve, this.minIntervalMs - elapsed)
      );
    }

    this.lastCallTime = Date.now();
  }

  /** Record a failure (triggers exponential backoff) */
  recordFailure(): void {
    this.consecutiveFailures++;
  }

  /** Record a success (resets backoff) */
  recordSuccess(): void {
    this.consecutiveFailures = 0;
  }

  /** Check if we should abort due to too many consecutive failures */
  shouldAbort(maxConsecutiveFailures: number): boolean {
    return this.consecutiveFailures >= maxConsecutiveFailures;
  }

  /** Get the current backoff delay (exponential) */
  getBackoffMs(): number {
    if (this.consecutiveFailures === 0) return this.minIntervalMs;
    return Math.min(
      this.minIntervalMs * Math.pow(2, this.consecutiveFailures - 1),
      60000, // Max 60 seconds
    );
  }

  /** Wait with exponential backoff after a failure */
  async backoff(): Promise<void> {
    const delay = this.getBackoffMs();
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}
