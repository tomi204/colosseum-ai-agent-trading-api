import { describe, expect, it } from 'vitest';
import { ErrorCode } from '../src/errors/taxonomy.js';
import {
  ClawpumpConfigError,
  ClawpumpHttpError,
  ClawpumpNetworkError,
  mapClawpumpError,
} from '../src/integrations/clawpump/errorMapping.js';

describe('mapClawpumpError', () => {
  it('maps rate limits to upstream_rate_limited with retry action', () => {
    const mapped = mapClawpumpError(
      new ClawpumpHttpError('launch', 429, '{"error":"too many requests"}', 12),
      'launch',
    );

    expect(mapped.code).toBe(ErrorCode.UpstreamRateLimited);
    expect(mapped.statusCode).toBe(429);
    expect(mapped.details?.retryAfterSeconds).toBe(12);
  });

  it('maps 400 payload rejections to invalid_payload', () => {
    const mapped = mapClawpumpError(
      new ClawpumpHttpError('launch', 400, '{"message":"symbol already exists"}'),
      'launch',
    );

    expect(mapped.code).toBe(ErrorCode.InvalidPayload);
    expect(mapped.statusCode).toBe(400);
  });

  it('maps upstream 5xx to integration_unavailable', () => {
    const mapped = mapClawpumpError(
      new ClawpumpHttpError('health', 503, 'maintenance'),
      'health',
    );

    expect(mapped.code).toBe(ErrorCode.IntegrationUnavailable);
    expect(mapped.statusCode).toBe(503);
  });

  it('maps configuration errors to integration_misconfigured', () => {
    const mapped = mapClawpumpError(
      new ClawpumpConfigError('missing env'),
      'launch',
    );

    expect(mapped.code).toBe(ErrorCode.IntegrationMisconfigured);
    expect(mapped.statusCode).toBe(503);
  });

  it('maps network errors to integration_unavailable', () => {
    const mapped = mapClawpumpError(
      new ClawpumpNetworkError('earnings', 'network down'),
      'earnings',
    );

    expect(mapped.code).toBe(ErrorCode.IntegrationUnavailable);
    expect(mapped.statusCode).toBe(503);
  });
});
