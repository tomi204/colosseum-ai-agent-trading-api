import { isoNow } from '../utils/time.js';

// ─── Rate limiter types ─────────────────────────────────────────────────────

export interface RateLimiterConfig {
  intentsPerMinute: number;
}

interface AgentBucket {
  tokens: number;
  lastRefillAt: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  retryAfterSeconds: number | null;
  checkedAt: string;
}

export interface RateLimitMetrics {
  totalChecks: number;
  totalAllowed: number;
  totalDenied: number;
  deniedByAgent: Record<string, number>;
}

// ─── Rate limiter (token bucket per agent) ──────────────────────────────────

export class RateLimiter {
  private readonly config: RateLimiterConfig;
  private readonly buckets: Map<string, AgentBucket> = new Map();
  private readonly metrics: RateLimitMetrics = {
    totalChecks: 0,
    totalAllowed: 0,
    totalDenied: 0,
    deniedByAgent: {},
  };

  constructor(config: RateLimiterConfig) {
    this.config = config;
  }

  check(agentId: string): RateLimitResult {
    this.metrics.totalChecks += 1;

    const now = Date.now();
    let bucket = this.buckets.get(agentId);

    if (!bucket) {
      bucket = {
        tokens: this.config.intentsPerMinute,
        lastRefillAt: now,
      };
      this.buckets.set(agentId, bucket);
    }

    // Refill tokens based on elapsed time
    const elapsedMs = now - bucket.lastRefillAt;
    const tokensToAdd = (elapsedMs / 60_000) * this.config.intentsPerMinute;
    bucket.tokens = Math.min(this.config.intentsPerMinute, bucket.tokens + tokensToAdd);
    bucket.lastRefillAt = now;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      this.metrics.totalAllowed += 1;

      return {
        allowed: true,
        remaining: Math.floor(bucket.tokens),
        limit: this.config.intentsPerMinute,
        retryAfterSeconds: null,
        checkedAt: isoNow(),
      };
    }

    // Denied — compute retry-after
    const tokensNeeded = 1 - bucket.tokens;
    const secondsUntilToken = (tokensNeeded / this.config.intentsPerMinute) * 60;
    const retryAfterSeconds = Math.ceil(secondsUntilToken);

    this.metrics.totalDenied += 1;
    this.metrics.deniedByAgent[agentId] = (this.metrics.deniedByAgent[agentId] ?? 0) + 1;

    return {
      allowed: false,
      remaining: 0,
      limit: this.config.intentsPerMinute,
      retryAfterSeconds,
      checkedAt: isoNow(),
    };
  }

  getMetrics(): RateLimitMetrics {
    return structuredClone(this.metrics);
  }

  reset(agentId: string): void {
    this.buckets.delete(agentId);
  }

  resetAll(): void {
    this.buckets.clear();
  }
}
