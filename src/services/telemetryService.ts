/**
 * Agent Telemetry & Observability Service.
 *
 * Provides real-time metrics collection, agent heartbeat monitoring,
 * performance anomaly detection, resource usage tracking, SLA monitoring,
 * and incident timeline management.
 */

import { v4 as uuid } from 'uuid';
import { StateStore } from '../infra/storage/stateStore.js';
import { isoNow } from '../utils/time.js';

// ─── Types ─────────────────────────────────────────────────────────────

export interface MetricRecord {
  id: string;
  endpoint: string;
  method: string;
  latencyMs: number;
  statusCode: number;
  agentId?: string;
  timestamp: string;
}

export interface EndpointMetrics {
  endpoint: string;
  totalRequests: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  maxLatencyMs: number;
  minLatencyMs: number;
  errorCount: number;
  errorRate: number;
  throughputPerMinute: number;
}

export interface SystemMetrics {
  totalRequests: number;
  totalErrors: number;
  overallErrorRate: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  activeAgents: number;
  endpointBreakdown: EndpointMetrics[];
  collectedSince: string;
  collectedAt: string;
}

export type AgentHeartbeatStatus = 'alive' | 'degraded' | 'dead';

export interface AgentHeartbeat {
  agentId: string;
  status: AgentHeartbeatStatus;
  lastSeenAt: string;
  totalRequests: number;
  avgLatencyMs: number;
  errorRate: number;
  rateLimitUtilizationPct: number;
  uptimeSeconds: number;
  registeredAt: string;
}

export type AnomalyType = 'latency_spike' | 'error_rate_surge' | 'throughput_drop' | 'rate_limit_breach';
export type AnomalySeverity = 'warning' | 'critical';

export interface Anomaly {
  id: string;
  type: AnomalyType;
  severity: AnomalySeverity;
  endpoint?: string;
  agentId?: string;
  message: string;
  currentValue: number;
  baselineValue: number;
  detectedAt: string;
}

export interface SlaReport {
  uptimePct: number;
  avgResponseTimeMs: number;
  p95ResponseTimeMs: number;
  totalRequests: number;
  totalErrors: number;
  slaTargets: {
    uptimePct: number;
    maxAvgResponseTimeMs: number;
    maxP95ResponseTimeMs: number;
  };
  slaStatus: {
    uptimeMet: boolean;
    avgResponseTimeMet: boolean;
    p95ResponseTimeMet: boolean;
    overall: 'passing' | 'at_risk' | 'breached';
  };
  periodStart: string;
  periodEnd: string;
}

export type IncidentStatus = 'open' | 'investigating' | 'resolved';
export type IncidentSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface Incident {
  id: string;
  title: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  detectedAt: string;
  acknowledgedAt?: string;
  resolvedAt?: string;
  durationMs?: number;
  affectedEndpoints: string[];
  affectedAgents: string[];
  anomalyIds: string[];
  timeline: IncidentEvent[];
}

export interface IncidentEvent {
  timestamp: string;
  event: string;
  details?: string;
}

export interface AgentResourceUsage {
  agentId: string;
  totalApiCalls: number;
  callsPerMinute: number;
  rateLimitUtilizationPct: number;
  endpointUsage: Record<string, number>;
  lastActivityAt: string;
}

// ─── Constants ─────────────────────────────────────────────────────────

const MAX_METRICS = 10_000;
const MAX_ANOMALIES = 500;
const MAX_INCIDENTS = 200;
const HEARTBEAT_ALIVE_THRESHOLD_MS = 5 * 60 * 1000;     // 5 minutes
const HEARTBEAT_DEGRADED_THRESHOLD_MS = 15 * 60 * 1000;  // 15 minutes
const LATENCY_SPIKE_MULTIPLIER = 3;
const ERROR_RATE_SPIKE_THRESHOLD = 0.15;
const RATE_LIMIT_PER_MINUTE = 60;

const DEFAULT_SLA_TARGETS = {
  uptimePct: 99.9,
  maxAvgResponseTimeMs: 500,
  maxP95ResponseTimeMs: 2000,
};

// ─── Service ───────────────────────────────────────────────────────────

export class TelemetryService {
  private metrics: MetricRecord[] = [];
  private anomalies: Anomaly[] = [];
  private incidents: Incident[] = [];
  private agentFirstSeen: Map<string, string> = new Map();
  private startedAt: string;
  private errorWindowStart: number = Date.now();
  private requestWindowStart: number = Date.now();

  constructor(private readonly store: StateStore) {
    this.startedAt = isoNow();
  }

  // ─── Record a metric ───────────────────────────────────────────────

  recordMetric(data: {
    endpoint: string;
    method: string;
    latencyMs: number;
    statusCode: number;
    agentId?: string;
  }): MetricRecord {
    const record: MetricRecord = {
      id: uuid(),
      endpoint: data.endpoint,
      method: data.method,
      latencyMs: data.latencyMs,
      statusCode: data.statusCode,
      agentId: data.agentId,
      timestamp: isoNow(),
    };

    this.metrics.push(record);

    // Track agent first-seen
    if (data.agentId && !this.agentFirstSeen.has(data.agentId)) {
      this.agentFirstSeen.set(data.agentId, record.timestamp);
    }

    // Trim old metrics to prevent unbounded growth
    if (this.metrics.length > MAX_METRICS) {
      this.metrics.splice(0, this.metrics.length - MAX_METRICS);
    }

    // Check for anomalies on this new data point
    this._detectAnomalies(record);

    return record;
  }

  // ─── System-wide metrics ───────────────────────────────────────────

  getSystemMetrics(): SystemMetrics {
    const now = isoNow();
    const latencies = this.metrics.map((m) => m.latencyMs);
    const errors = this.metrics.filter((m) => m.statusCode >= 400);
    const uniqueAgents = new Set(this.metrics.filter((m) => m.agentId).map((m) => m.agentId));

    const sorted = [...latencies].sort((a, b) => a - b);

    // Build per-endpoint breakdown
    const endpointMap = new Map<string, MetricRecord[]>();
    for (const m of this.metrics) {
      const key = m.endpoint;
      if (!endpointMap.has(key)) endpointMap.set(key, []);
      endpointMap.get(key)!.push(m);
    }

    const endpointBreakdown: EndpointMetrics[] = [];
    for (const [endpoint, records] of endpointMap) {
      endpointBreakdown.push(this._computeEndpointMetrics(endpoint, records));
    }

    endpointBreakdown.sort((a, b) => b.totalRequests - a.totalRequests);

    return {
      totalRequests: this.metrics.length,
      totalErrors: errors.length,
      overallErrorRate: this.metrics.length > 0
        ? Number((errors.length / this.metrics.length).toFixed(4))
        : 0,
      avgLatencyMs: this._avg(latencies),
      p95LatencyMs: this._percentile(sorted, 0.95),
      p99LatencyMs: this._percentile(sorted, 0.99),
      activeAgents: uniqueAgents.size,
      endpointBreakdown,
      collectedSince: this.startedAt,
      collectedAt: now,
    };
  }

  // ─── Agent heartbeat ───────────────────────────────────────────────

  getAgentHeartbeat(agentId: string): AgentHeartbeat {
    const agentMetrics = this.metrics.filter((m) => m.agentId === agentId);
    const now = Date.now();

    let lastSeenAt = this.agentFirstSeen.get(agentId) ?? isoNow();
    let status: AgentHeartbeatStatus = 'dead';

    if (agentMetrics.length > 0) {
      lastSeenAt = agentMetrics[agentMetrics.length - 1].timestamp;
      const lastSeenMs = new Date(lastSeenAt).getTime();
      const elapsed = now - lastSeenMs;

      if (elapsed <= HEARTBEAT_ALIVE_THRESHOLD_MS) {
        status = 'alive';
      } else if (elapsed <= HEARTBEAT_DEGRADED_THRESHOLD_MS) {
        status = 'degraded';
      } else {
        status = 'dead';
      }
    }

    const latencies = agentMetrics.map((m) => m.latencyMs);
    const errors = agentMetrics.filter((m) => m.statusCode >= 400);
    const registeredAt = this.agentFirstSeen.get(agentId) ?? lastSeenAt;
    const uptimeSeconds = Math.floor((now - new Date(registeredAt).getTime()) / 1000);

    // Rate limit utilization: calls in last minute vs limit
    const oneMinuteAgo = now - 60_000;
    const recentCalls = agentMetrics.filter(
      (m) => new Date(m.timestamp).getTime() >= oneMinuteAgo,
    ).length;
    const rateLimitUtilizationPct = Number(
      ((recentCalls / RATE_LIMIT_PER_MINUTE) * 100).toFixed(2),
    );

    return {
      agentId,
      status,
      lastSeenAt,
      totalRequests: agentMetrics.length,
      avgLatencyMs: this._avg(latencies),
      errorRate: agentMetrics.length > 0
        ? Number((errors.length / agentMetrics.length).toFixed(4))
        : 0,
      rateLimitUtilizationPct,
      uptimeSeconds: Math.max(0, uptimeSeconds),
      registeredAt,
    };
  }

  // ─── Anomaly detection ─────────────────────────────────────────────

  getAnomalies(): Anomaly[] {
    return this.anomalies.slice().reverse();
  }

  // ─── SLA monitoring ────────────────────────────────────────────────

  getSlaReport(): SlaReport {
    const now = isoNow();
    const latencies = this.metrics.map((m) => m.latencyMs);
    const errors = this.metrics.filter((m) => m.statusCode >= 500);
    const sorted = [...latencies].sort((a, b) => a - b);

    const totalRequests = this.metrics.length;
    const totalErrors = errors.length;
    const uptimePct = totalRequests > 0
      ? Number((((totalRequests - totalErrors) / totalRequests) * 100).toFixed(3))
      : 100;
    const avgResponseTimeMs = this._avg(latencies);
    const p95ResponseTimeMs = this._percentile(sorted, 0.95);

    const slaTargets = { ...DEFAULT_SLA_TARGETS };
    const uptimeMet = uptimePct >= slaTargets.uptimePct;
    const avgResponseTimeMet = avgResponseTimeMs <= slaTargets.maxAvgResponseTimeMs;
    const p95ResponseTimeMet = p95ResponseTimeMs <= slaTargets.maxP95ResponseTimeMs;

    let overall: 'passing' | 'at_risk' | 'breached' = 'passing';
    if (!uptimeMet || !avgResponseTimeMet || !p95ResponseTimeMet) {
      overall = 'breached';
    } else if (
      totalRequests > 0 && (
        uptimePct < slaTargets.uptimePct + 0.05 ||
        avgResponseTimeMs > slaTargets.maxAvgResponseTimeMs * 0.8 ||
        p95ResponseTimeMs > slaTargets.maxP95ResponseTimeMs * 0.8
      )
    ) {
      overall = 'at_risk';
    }

    return {
      uptimePct,
      avgResponseTimeMs,
      p95ResponseTimeMs,
      totalRequests,
      totalErrors,
      slaTargets,
      slaStatus: {
        uptimeMet,
        avgResponseTimeMet,
        p95ResponseTimeMet,
        overall,
      },
      periodStart: this.startedAt,
      periodEnd: now,
    };
  }

  // ─── Incident timeline ─────────────────────────────────────────────

  getIncidents(): Incident[] {
    return this.incidents.slice().reverse();
  }

  // ─── Agent resource usage ──────────────────────────────────────────

  getAgentResourceUsage(agentId: string): AgentResourceUsage {
    const agentMetrics = this.metrics.filter((m) => m.agentId === agentId);
    const now = Date.now();
    const oneMinuteAgo = now - 60_000;

    const recentCalls = agentMetrics.filter(
      (m) => new Date(m.timestamp).getTime() >= oneMinuteAgo,
    ).length;

    const endpointUsage: Record<string, number> = {};
    for (const m of agentMetrics) {
      endpointUsage[m.endpoint] = (endpointUsage[m.endpoint] ?? 0) + 1;
    }

    const lastMetric = agentMetrics[agentMetrics.length - 1];

    return {
      agentId,
      totalApiCalls: agentMetrics.length,
      callsPerMinute: recentCalls,
      rateLimitUtilizationPct: Number(
        ((recentCalls / RATE_LIMIT_PER_MINUTE) * 100).toFixed(2),
      ),
      endpointUsage,
      lastActivityAt: lastMetric?.timestamp ?? isoNow(),
    };
  }

  // ─── Internal helpers ──────────────────────────────────────────────

  private _detectAnomalies(record: MetricRecord): void {
    const endpointMetrics = this.metrics.filter(
      (m) => m.endpoint === record.endpoint && m.id !== record.id,
    );

    if (endpointMetrics.length < 5) return; // Need baseline data

    const latencies = endpointMetrics.map((m) => m.latencyMs);
    const avgLatency = this._avg(latencies);

    // Latency spike detection
    if (record.latencyMs > avgLatency * LATENCY_SPIKE_MULTIPLIER && avgLatency > 0) {
      const anomaly = this._createAnomaly({
        type: 'latency_spike',
        severity: record.latencyMs > avgLatency * 5 ? 'critical' : 'warning',
        endpoint: record.endpoint,
        agentId: record.agentId,
        message: `Latency spike on ${record.endpoint}: ${record.latencyMs}ms vs ${avgLatency.toFixed(0)}ms avg`,
        currentValue: record.latencyMs,
        baselineValue: avgLatency,
      });

      this._maybeCreateIncident(anomaly);
    }

    // Error rate surge detection
    if (record.statusCode >= 400) {
      const recentWindow = this.metrics.slice(-50);
      const recentErrors = recentWindow.filter((m) => m.statusCode >= 400).length;
      const recentErrorRate = recentErrors / recentWindow.length;

      const allErrors = this.metrics.filter((m) => m.statusCode >= 400).length;
      const overallErrorRate = this.metrics.length > 0 ? allErrors / this.metrics.length : 0;

      if (
        recentErrorRate > ERROR_RATE_SPIKE_THRESHOLD &&
        recentErrorRate > overallErrorRate * 2 &&
        recentWindow.length >= 10
      ) {
        const anomaly = this._createAnomaly({
          type: 'error_rate_surge',
          severity: recentErrorRate > 0.3 ? 'critical' : 'warning',
          endpoint: record.endpoint,
          agentId: record.agentId,
          message: `Error rate surge: ${(recentErrorRate * 100).toFixed(1)}% in recent window vs ${(overallErrorRate * 100).toFixed(1)}% overall`,
          currentValue: recentErrorRate,
          baselineValue: overallErrorRate,
        });

        this._maybeCreateIncident(anomaly);
      }
    }

    // Rate limit breach detection
    if (record.agentId) {
      const now = Date.now();
      const oneMinuteAgo = now - 60_000;
      const recentAgentCalls = this.metrics.filter(
        (m) =>
          m.agentId === record.agentId &&
          new Date(m.timestamp).getTime() >= oneMinuteAgo,
      ).length;

      if (recentAgentCalls >= RATE_LIMIT_PER_MINUTE * 0.9) {
        this._createAnomaly({
          type: 'rate_limit_breach',
          severity: recentAgentCalls >= RATE_LIMIT_PER_MINUTE ? 'critical' : 'warning',
          agentId: record.agentId,
          message: `Agent ${record.agentId} approaching rate limit: ${recentAgentCalls}/${RATE_LIMIT_PER_MINUTE} calls/min`,
          currentValue: recentAgentCalls,
          baselineValue: RATE_LIMIT_PER_MINUTE,
        });
      }
    }
  }

  private _createAnomaly(data: Omit<Anomaly, 'id' | 'detectedAt'>): Anomaly {
    const anomaly: Anomaly = {
      id: uuid(),
      ...data,
      detectedAt: isoNow(),
    };

    this.anomalies.push(anomaly);

    if (this.anomalies.length > MAX_ANOMALIES) {
      this.anomalies.splice(0, this.anomalies.length - MAX_ANOMALIES);
    }

    return anomaly;
  }

  private _maybeCreateIncident(anomaly: Anomaly): void {
    // Check if there's already an open incident for this endpoint/agent
    const existingOpen = this.incidents.find(
      (i) =>
        i.status !== 'resolved' &&
        (anomaly.endpoint ? i.affectedEndpoints.includes(anomaly.endpoint) : false),
    );

    if (existingOpen) {
      // Add anomaly to existing incident
      existingOpen.anomalyIds.push(anomaly.id);
      existingOpen.timeline.push({
        timestamp: isoNow(),
        event: 'anomaly_added',
        details: anomaly.message,
      });

      if (anomaly.severity === 'critical' && existingOpen.severity !== 'critical') {
        existingOpen.severity = 'critical';
        existingOpen.timeline.push({
          timestamp: isoNow(),
          event: 'severity_escalated',
          details: 'Escalated to critical due to new anomaly',
        });
      }
      return;
    }

    // Only create incidents for critical anomalies or repeated warnings
    const recentAnomalies = this.anomalies.filter(
      (a) =>
        a.endpoint === anomaly.endpoint &&
        Date.now() - new Date(a.detectedAt).getTime() < 300_000, // 5 min window
    );

    if (anomaly.severity === 'critical' || recentAnomalies.length >= 3) {
      const incident: Incident = {
        id: uuid(),
        title: `${anomaly.type}: ${anomaly.message}`,
        severity: anomaly.severity === 'critical' ? 'critical' : 'medium',
        status: 'open',
        detectedAt: isoNow(),
        affectedEndpoints: anomaly.endpoint ? [anomaly.endpoint] : [],
        affectedAgents: anomaly.agentId ? [anomaly.agentId] : [],
        anomalyIds: [anomaly.id],
        timeline: [
          {
            timestamp: isoNow(),
            event: 'incident_created',
            details: `Auto-detected: ${anomaly.message}`,
          },
        ],
      };

      this.incidents.push(incident);

      if (this.incidents.length > MAX_INCIDENTS) {
        this.incidents.splice(0, this.incidents.length - MAX_INCIDENTS);
      }

      // Auto-resolve stale incidents (older than 30 minutes with no new anomalies)
      this._autoResolveStaleIncidents();
    }
  }

  private _autoResolveStaleIncidents(): void {
    const now = Date.now();
    const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

    for (const incident of this.incidents) {
      if (incident.status === 'resolved') continue;

      const lastEvent = incident.timeline[incident.timeline.length - 1];
      const lastEventTime = new Date(lastEvent.timestamp).getTime();

      if (now - lastEventTime > STALE_THRESHOLD_MS) {
        incident.status = 'resolved';
        incident.resolvedAt = isoNow();
        incident.durationMs = now - new Date(incident.detectedAt).getTime();
        incident.timeline.push({
          timestamp: isoNow(),
          event: 'auto_resolved',
          details: 'No new anomalies detected for 30 minutes',
        });
      }
    }
  }

  private _computeEndpointMetrics(endpoint: string, records: MetricRecord[]): EndpointMetrics {
    const latencies = records.map((r) => r.latencyMs);
    const sorted = [...latencies].sort((a, b) => a - b);
    const errors = records.filter((r) => r.statusCode >= 400);

    // Throughput: requests per minute based on time span
    const timestamps = records.map((r) => new Date(r.timestamp).getTime());
    const timeSpanMs = timestamps.length > 1
      ? Math.max(timestamps[timestamps.length - 1] - timestamps[0], 1)
      : 60_000;
    const throughputPerMinute = Number(
      ((records.length / timeSpanMs) * 60_000).toFixed(2),
    );

    return {
      endpoint,
      totalRequests: records.length,
      avgLatencyMs: this._avg(latencies),
      p50LatencyMs: this._percentile(sorted, 0.5),
      p95LatencyMs: this._percentile(sorted, 0.95),
      p99LatencyMs: this._percentile(sorted, 0.99),
      maxLatencyMs: sorted.length > 0 ? sorted[sorted.length - 1] : 0,
      minLatencyMs: sorted.length > 0 ? sorted[0] : 0,
      errorCount: errors.length,
      errorRate: records.length > 0
        ? Number((errors.length / records.length).toFixed(4))
        : 0,
      throughputPerMinute,
    };
  }

  private _avg(values: number[]): number {
    if (values.length === 0) return 0;
    return Number((values.reduce((s, v) => s + v, 0) / values.length).toFixed(2));
  }

  private _percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const idx = Math.ceil(p * sorted.length) - 1;
    return sorted[Math.max(0, idx)];
  }
}
