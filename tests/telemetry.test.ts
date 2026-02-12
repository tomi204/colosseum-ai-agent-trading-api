import { describe, expect, it, vi, beforeEach } from 'vitest';
import { TelemetryService } from '../src/services/telemetryService.js';
import { AppState } from '../src/types.js';
import { createDefaultState } from '../src/infra/storage/defaultState.js';

function createMockStore(state?: AppState) {
  const s = state ?? createDefaultState();
  return {
    snapshot: () => structuredClone(s),
    transaction: vi.fn(),
    init: vi.fn(),
    flush: vi.fn(),
  } as any;
}

function recordMany(
  service: TelemetryService,
  count: number,
  overrides: Partial<{
    endpoint: string;
    method: string;
    latencyMs: number;
    statusCode: number;
    agentId: string;
  }> = {},
) {
  for (let i = 0; i < count; i++) {
    service.recordMetric({
      endpoint: overrides.endpoint ?? '/test',
      method: overrides.method ?? 'GET',
      latencyMs: overrides.latencyMs ?? 50 + Math.random() * 50,
      statusCode: overrides.statusCode ?? 200,
      agentId: overrides.agentId,
    });
  }
}

describe('TelemetryService', () => {
  let store: ReturnType<typeof createMockStore>;
  let service: TelemetryService;

  beforeEach(() => {
    store = createMockStore();
    service = new TelemetryService(store);
  });

  // ─── 1. Record a metric ──────────────────────────────────────────────

  it('records a metric and returns the record with all fields', () => {
    const record = service.recordMetric({
      endpoint: '/trade-intents',
      method: 'POST',
      latencyMs: 42,
      statusCode: 202,
      agentId: 'agent-1',
    });

    expect(record).toMatchObject({
      endpoint: '/trade-intents',
      method: 'POST',
      latencyMs: 42,
      statusCode: 202,
      agentId: 'agent-1',
    });
    expect(record.id).toBeDefined();
    expect(record.timestamp).toBeDefined();
  });

  // ─── 2. System-wide metrics ──────────────────────────────────────────

  it('returns correct system-wide metrics after multiple recordings', () => {
    service.recordMetric({ endpoint: '/a', method: 'GET', latencyMs: 100, statusCode: 200 });
    service.recordMetric({ endpoint: '/b', method: 'POST', latencyMs: 200, statusCode: 200 });
    service.recordMetric({ endpoint: '/a', method: 'GET', latencyMs: 300, statusCode: 500 });

    const metrics = service.getSystemMetrics();

    expect(metrics.totalRequests).toBe(3);
    expect(metrics.totalErrors).toBe(1);
    expect(metrics.overallErrorRate).toBeCloseTo(1 / 3, 3);
    expect(metrics.avgLatencyMs).toBe(200);
    expect(metrics.endpointBreakdown.length).toBe(2);
    expect(metrics.collectedSince).toBeDefined();
    expect(metrics.collectedAt).toBeDefined();
  });

  // ─── 3. Empty system returns zeros ────────────────────────────────────

  it('returns zero-value system metrics when no data has been recorded', () => {
    const metrics = service.getSystemMetrics();

    expect(metrics.totalRequests).toBe(0);
    expect(metrics.totalErrors).toBe(0);
    expect(metrics.overallErrorRate).toBe(0);
    expect(metrics.avgLatencyMs).toBe(0);
    expect(metrics.activeAgents).toBe(0);
    expect(metrics.endpointBreakdown).toEqual([]);
  });

  // ─── 4. Endpoint breakdown detail ────────────────────────────────────

  it('computes per-endpoint p50/p95/p99 and throughput correctly', () => {
    // Insert 10 metrics with known latencies
    for (let i = 1; i <= 10; i++) {
      service.recordMetric({
        endpoint: '/deterministic',
        method: 'GET',
        latencyMs: i * 10, // 10, 20, 30, ..., 100
        statusCode: i <= 8 ? 200 : 400,
      });
    }

    const metrics = service.getSystemMetrics();
    const ep = metrics.endpointBreakdown.find((e) => e.endpoint === '/deterministic');

    expect(ep).toBeDefined();
    expect(ep!.totalRequests).toBe(10);
    expect(ep!.errorCount).toBe(2);
    expect(ep!.errorRate).toBeCloseTo(0.2, 3);
    expect(ep!.avgLatencyMs).toBe(55);
    expect(ep!.minLatencyMs).toBe(10);
    expect(ep!.maxLatencyMs).toBe(100);
    expect(ep!.p50LatencyMs).toBe(50);
    expect(ep!.p95LatencyMs).toBe(100);
    expect(ep!.throughputPerMinute).toBeGreaterThan(0);
  });

  // ─── 5. Agent heartbeat: alive ───────────────────────────────────────

  it('reports agent as alive when recent metrics exist', () => {
    service.recordMetric({
      endpoint: '/test',
      method: 'GET',
      latencyMs: 50,
      statusCode: 200,
      agentId: 'agent-alive',
    });

    const heartbeat = service.getAgentHeartbeat('agent-alive');

    expect(heartbeat.agentId).toBe('agent-alive');
    expect(heartbeat.status).toBe('alive');
    expect(heartbeat.totalRequests).toBe(1);
    expect(heartbeat.avgLatencyMs).toBe(50);
    expect(heartbeat.errorRate).toBe(0);
    expect(heartbeat.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(heartbeat.registeredAt).toBeDefined();
  });

  // ─── 6. Agent heartbeat: dead (no metrics) ──────────────────────────

  it('reports agent as dead when no metrics exist', () => {
    const heartbeat = service.getAgentHeartbeat('agent-ghost');

    expect(heartbeat.agentId).toBe('agent-ghost');
    expect(heartbeat.status).toBe('dead');
    expect(heartbeat.totalRequests).toBe(0);
  });

  // ─── 7. Agent heartbeat: error rate calculation ──────────────────────

  it('correctly calculates agent error rate in heartbeat', () => {
    for (let i = 0; i < 10; i++) {
      service.recordMetric({
        endpoint: '/test',
        method: 'GET',
        latencyMs: 30,
        statusCode: i < 3 ? 500 : 200,
        agentId: 'agent-err',
      });
    }

    const heartbeat = service.getAgentHeartbeat('agent-err');
    expect(heartbeat.errorRate).toBeCloseTo(0.3, 3);
  });

  // ─── 8. Anomaly detection: latency spike ─────────────────────────────

  it('detects latency spike anomaly', () => {
    // Build baseline
    recordMany(service, 10, { endpoint: '/api', latencyMs: 50 });

    // Record a spike
    service.recordMetric({
      endpoint: '/api',
      method: 'GET',
      latencyMs: 5000, // 100x baseline
      statusCode: 200,
    });

    const anomalies = service.getAnomalies();
    const latencyAnomaly = anomalies.find((a) => a.type === 'latency_spike');

    expect(latencyAnomaly).toBeDefined();
    expect(latencyAnomaly!.endpoint).toBe('/api');
    expect(latencyAnomaly!.currentValue).toBe(5000);
    expect(latencyAnomaly!.baselineValue).toBeCloseTo(50, 0);
    expect(latencyAnomaly!.severity).toBe('critical'); // 5000 > 50*5
  });

  // ─── 9. Anomaly detection: error rate surge ─────────────────────────

  it('detects error rate surge anomaly', () => {
    // Build a large baseline with zero errors so overall error rate is very low
    recordMany(service, 100, { endpoint: '/safe', statusCode: 200 });

    // Now inject a burst of errors — the last 50 window will have high error rate
    // relative to overall, crossing the 15% threshold and being >2x overall
    recordMany(service, 40, { endpoint: '/safe', statusCode: 500 });

    const anomalies = service.getAnomalies();
    const errorAnomaly = anomalies.find((a) => a.type === 'error_rate_surge');

    expect(errorAnomaly).toBeDefined();
    expect(errorAnomaly!.message).toContain('Error rate surge');
  });

  // ─── 10. SLA monitoring ──────────────────────────────────────────────

  it('reports SLA as passing when metrics are within targets', () => {
    recordMany(service, 20, { latencyMs: 50, statusCode: 200 });

    const sla = service.getSlaReport();

    expect(sla.uptimePct).toBe(100);
    expect(sla.avgResponseTimeMs).toBe(50);
    expect(sla.slaStatus.uptimeMet).toBe(true);
    expect(sla.slaStatus.avgResponseTimeMet).toBe(true);
    expect(sla.slaStatus.p95ResponseTimeMet).toBe(true);
    expect(sla.slaStatus.overall).toBe('passing');
    expect(sla.slaTargets.uptimePct).toBe(99.9);
    expect(sla.periodStart).toBeDefined();
    expect(sla.periodEnd).toBeDefined();
  });

  // ─── 11. SLA monitoring: breached ────────────────────────────────────

  it('reports SLA as breached when error rate is high', () => {
    // Record 50% 500-errors
    recordMany(service, 10, { latencyMs: 50, statusCode: 200 });
    recordMany(service, 10, { latencyMs: 50, statusCode: 500 });

    const sla = service.getSlaReport();

    expect(sla.uptimePct).toBe(50);
    expect(sla.slaStatus.uptimeMet).toBe(false);
    expect(sla.slaStatus.overall).toBe('breached');
  });

  // ─── 12. Incident timeline auto-creation ─────────────────────────────

  it('creates an incident for critical latency spikes', () => {
    // Build baseline
    recordMany(service, 10, { endpoint: '/critical', latencyMs: 20 });

    // Trigger a critical spike (>5x average)
    service.recordMetric({
      endpoint: '/critical',
      method: 'GET',
      latencyMs: 10_000,
      statusCode: 200,
    });

    const incidents = service.getIncidents();
    expect(incidents.length).toBeGreaterThanOrEqual(1);

    const incident = incidents[0];
    expect(incident.status).toBe('open');
    expect(incident.severity).toBe('critical');
    expect(incident.affectedEndpoints).toContain('/critical');
    expect(incident.timeline.length).toBeGreaterThanOrEqual(1);
    expect(incident.timeline[0].event).toBe('incident_created');
  });

  // ─── 13. Incident appends to existing open incident ──────────────────

  it('appends anomalies to existing open incident for same endpoint', () => {
    // Build baseline
    recordMany(service, 10, { endpoint: '/flaky', latencyMs: 30 });

    // Trigger first critical spike -> creates incident
    service.recordMetric({
      endpoint: '/flaky',
      method: 'GET',
      latencyMs: 8000,
      statusCode: 200,
    });

    const before = service.getIncidents();
    expect(before.length).toBe(1);

    // Trigger second spike -> should append, not create new
    service.recordMetric({
      endpoint: '/flaky',
      method: 'GET',
      latencyMs: 9000,
      statusCode: 200,
    });

    const after = service.getIncidents();
    expect(after.length).toBe(1); // Still one incident
    expect(after[0].anomalyIds.length).toBeGreaterThanOrEqual(2);
    expect(after[0].timeline.some((t) => t.event === 'anomaly_added')).toBe(true);
  });

  // ─── 14. Agent resource usage tracking ───────────────────────────────

  it('tracks agent resource usage per endpoint', () => {
    service.recordMetric({ endpoint: '/a', method: 'GET', latencyMs: 10, statusCode: 200, agentId: 'bot-1' });
    service.recordMetric({ endpoint: '/a', method: 'GET', latencyMs: 10, statusCode: 200, agentId: 'bot-1' });
    service.recordMetric({ endpoint: '/b', method: 'POST', latencyMs: 10, statusCode: 200, agentId: 'bot-1' });

    const usage = service.getAgentResourceUsage('bot-1');

    expect(usage.agentId).toBe('bot-1');
    expect(usage.totalApiCalls).toBe(3);
    expect(usage.endpointUsage['/a']).toBe(2);
    expect(usage.endpointUsage['/b']).toBe(1);
    expect(usage.rateLimitUtilizationPct).toBeGreaterThanOrEqual(0);
    expect(usage.lastActivityAt).toBeDefined();
  });

  // ─── 15. Multiple agents tracked independently ───────────────────────

  it('tracks multiple agents independently in heartbeats', () => {
    service.recordMetric({ endpoint: '/x', method: 'GET', latencyMs: 100, statusCode: 200, agentId: 'alpha' });
    service.recordMetric({ endpoint: '/x', method: 'GET', latencyMs: 200, statusCode: 500, agentId: 'beta' });

    const alpha = service.getAgentHeartbeat('alpha');
    const beta = service.getAgentHeartbeat('beta');

    expect(alpha.totalRequests).toBe(1);
    expect(alpha.avgLatencyMs).toBe(100);
    expect(alpha.errorRate).toBe(0);

    expect(beta.totalRequests).toBe(1);
    expect(beta.avgLatencyMs).toBe(200);
    expect(beta.errorRate).toBe(1);
  });

  // ─── 16. SLA empty state returns default passing ─────────────────────

  it('returns 100% uptime SLA when no metrics recorded', () => {
    const sla = service.getSlaReport();

    expect(sla.uptimePct).toBe(100);
    expect(sla.totalRequests).toBe(0);
    expect(sla.slaStatus.overall).toBe('passing');
  });
});
