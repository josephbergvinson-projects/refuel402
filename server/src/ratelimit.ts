// Naive fixed-window rate limiter, in-memory. MVP-grade abuse damping only.
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private cfg: { windowSec: number; max: number }) {}

  allow(key: string): boolean {
    const now = Date.now();
    const cutoff = now - this.cfg.windowSec * 1000;
    const arr = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (arr.length >= this.cfg.max) {
      this.hits.set(key, arr);
      return false;
    }
    arr.push(now);
    this.hits.set(key, arr);
    return true;
  }
}
