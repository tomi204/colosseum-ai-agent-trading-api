import { describe, it, expect, beforeEach } from 'vitest';
import { RateLimiter } from '../src/api/rateLimiter.js';

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter({ intentsPerMinute: 60 });
  });

  it('allows requests within the limit', () => {
    const result = limiter.check('agent-1');

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(59);
    expect(result.limit).toBe(60);
    expect(result.retryAfterSeconds).toBeNull();
    expect(result.checkedAt).toBeDefined();
  });

  it('allows multiple requests up to the limit', () => {
    for (let i = 0; i < 59; i++) {
      const result = limiter.check('agent-1');
      expect(result.allowed).toBe(true);
    }

    const lastAllowed = limiter.check('agent-1');
    expect(lastAllowed.allowed).toBe(true);
    expect(lastAllowed.remaining).toBe(0);
  });

  it('denies requests after the limit is exceeded', () => {
    // Drain all tokens
    for (let i = 0; i < 60; i++) {
      limiter.check('agent-1');
    }

    const denied = limiter.check('agent-1');
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(denied.retryAfterSeconds).toBeGreaterThan(0);
    expect(denied.limit).toBe(60);
  });

  it('isolates rate limits per agent', () => {
    // Drain agent-1
    for (let i = 0; i < 60; i++) {
      limiter.check('agent-1');
    }

    // agent-2 should still be allowed
    const result = limiter.check('agent-2');
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(59);
  });

  it('tracks metrics correctly', () => {
    limiter.check('agent-1'); // allowed
    limiter.check('agent-1'); // allowed

    const metrics = limiter.getMetrics();
    expect(metrics.totalChecks).toBe(2);
    expect(metrics.totalAllowed).toBe(2);
    expect(metrics.totalDenied).toBe(0);
  });

  it('tracks denial metrics per agent', () => {
    // Drain agent-1
    for (let i = 0; i < 60; i++) {
      limiter.check('agent-1');
    }

    limiter.check('agent-1'); // denied
    limiter.check('agent-1'); // denied

    const metrics = limiter.getMetrics();
    expect(metrics.totalDenied).toBe(2);
    expect(metrics.deniedByAgent['agent-1']).toBe(2);
  });

  it('provides retry-after header value', () => {
    // Drain all tokens
    for (let i = 0; i < 60; i++) {
      limiter.check('agent-1');
    }

    const denied = limiter.check('agent-1');
    expect(denied.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(denied.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it('resets a specific agent', () => {
    // Drain agent-1
    for (let i = 0; i < 60; i++) {
      limiter.check('agent-1');
    }

    const denied = limiter.check('agent-1');
    expect(denied.allowed).toBe(false);

    limiter.reset('agent-1');
    const afterReset = limiter.check('agent-1');
    expect(afterReset.allowed).toBe(true);
    expect(afterReset.remaining).toBe(59);
  });

  it('works with low rate limits', () => {
    const strictLimiter = new RateLimiter({ intentsPerMinute: 1 });

    const first = strictLimiter.check('agent-1');
    expect(first.allowed).toBe(true);

    const second = strictLimiter.check('agent-1');
    expect(second.allowed).toBe(false);
    expect(second.retryAfterSeconds).toBeGreaterThan(0);
  });
});
