/**
 * Agent Compliance & Audit Service
 *
 * Provides regulatory readiness for AI trading agents:
 * - Tamper-evident audit log with SHA-256 hash chaining (append-only)
 * - Configurable compliance rule engine (max daily volume, restricted tokens, trading hours)
 * - Compliance report generation (daily/weekly summaries)
 * - Suspicious activity detection (wash trading, unusual volume spikes, circular trades)
 * - KYC status tracking per agent
 * - Regulatory export in CSV/JSON format
 */

import { v4 as uuid } from 'uuid';
import { sha256Hex, stableStringify } from '../utils/hash.js';
import { isoNow, dayKey } from '../utils/time.js';
import { StateStore } from '../infra/storage/stateStore.js';
import { eventBus } from '../infra/eventBus.js';

// ─── Audit Log Types ─────────────────────────────────────────────────

export interface AuditEntry {
  id: string;
  agentId: string;
  action: string;
  details: Record<string, unknown>;
  timestamp: string;
  payloadHash: string;
  prevHash: string | null;
  entryHash: string;
}

export interface AuditLogFilters {
  agentId?: string;
  action?: string;
  startDate?: string;
  endDate?: string;
  limit?: number;
  offset?: number;
}

// ─── Compliance Rule Types ───────────────────────────────────────────

export type ComplianceRuleType =
  | 'max-daily-volume'
  | 'restricted-token'
  | 'trading-hours'
  | 'max-single-trade'
  | 'max-daily-trades'
  | 'custom';

export interface ComplianceRule {
  id: string;
  type: ComplianceRuleType;
  name: string;
  description: string;
  enabled: boolean;
  params: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface RuleViolation {
  ruleId: string;
  ruleName: string;
  ruleType: ComplianceRuleType;
  agentId: string;
  details: string;
  timestamp: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
}

// ─── KYC Types ───────────────────────────────────────────────────────

export type KycStatus = 'pending' | 'verified' | 'rejected' | 'expired' | 'not_started';

export interface KycRecord {
  agentId: string;
  status: KycStatus;
  level: number; // 1 = basic, 2 = enhanced, 3 = full
  submittedAt: string | null;
  verifiedAt: string | null;
  expiresAt: string | null;
  rejectionReason: string | null;
  documents: string[];
  updatedAt: string;
}

// ─── Suspicious Activity Types ───────────────────────────────────────

export type SuspiciousActivityType =
  | 'wash-trading'
  | 'volume-spike'
  | 'circular-trades'
  | 'rapid-fire'
  | 'layering';

export interface SuspiciousActivity {
  id: string;
  agentId: string;
  type: SuspiciousActivityType;
  description: string;
  confidence: number; // 0-1
  severity: 'low' | 'medium' | 'high' | 'critical';
  evidence: Record<string, unknown>;
  detectedAt: string;
  resolved: boolean;
}

// ─── Report Types ────────────────────────────────────────────────────

export interface ComplianceReport {
  agentId: string;
  period: 'daily' | 'weekly';
  startDate: string;
  endDate: string;
  generatedAt: string;
  summary: {
    totalTrades: number;
    totalVolumeUsd: number;
    ruleViolations: number;
    suspiciousActivities: number;
    kycStatus: KycStatus;
    complianceScore: number; // 0-100
  };
  violations: RuleViolation[];
  suspiciousActivities: SuspiciousActivity[];
  tradeBreakdown: {
    bySymbol: Record<string, { count: number; volumeUsd: number }>;
    bySide: { buy: number; sell: number };
  };
}

// ─── Export Types ────────────────────────────────────────────────────

export interface RegulatoryExport {
  agentId: string;
  exportedAt: string;
  format: 'json' | 'csv';
  data: unknown;
}

// ─── Constants ───────────────────────────────────────────────────────

const MAX_AUDIT_ENTRIES = 50_000;
const WASH_TRADE_WINDOW_MS = 60_000; // 1 minute
const VOLUME_SPIKE_MULTIPLIER = 5;
const RAPID_FIRE_THRESHOLD = 10; // trades per minute

// ─── Service ─────────────────────────────────────────────────────────

export class ComplianceService {
  private auditLog: AuditEntry[] = [];
  private lastHash: string | null = null;
  private rules: Map<string, ComplianceRule> = new Map();
  private kycRecords: Map<string, KycRecord> = new Map();
  private suspiciousActivities: Map<string, SuspiciousActivity[]> = new Map();
  private violations: Map<string, RuleViolation[]> = new Map();

  constructor(private readonly store: StateStore) {
    this.hookEventBus();
    this.seedDefaultRules();
  }

  // ─── Audit Log ───────────────────────────────────────────────────────

  /**
   * Append to the tamper-evident audit log. Each entry is chained
   * to the previous one via SHA-256 hashing.
   */
  appendAuditEntry(agentId: string, action: string, details: Record<string, unknown>): AuditEntry {
    const timestamp = isoNow();
    const id = uuid();

    const payloadHash = sha256Hex(stableStringify({ id, agentId, action, details, timestamp }));
    const prevHash = this.lastHash;
    const entryHash = sha256Hex(`${payloadHash}:${prevHash ?? 'GENESIS'}`);

    const entry: AuditEntry = {
      id,
      agentId,
      action,
      details,
      timestamp,
      payloadHash,
      prevHash,
      entryHash,
    };

    this.auditLog.push(entry);
    this.lastHash = entryHash;

    // Trim if exceeding max
    if (this.auditLog.length > MAX_AUDIT_ENTRIES) {
      this.auditLog = this.auditLog.slice(-MAX_AUDIT_ENTRIES / 2);
    }

    return entry;
  }

  /**
   * Query the audit log with optional filters.
   */
  getAuditLog(filters: AuditLogFilters = {}): { entries: AuditEntry[]; total: number } {
    let entries = [...this.auditLog];

    if (filters.agentId) {
      entries = entries.filter((e) => e.agentId === filters.agentId);
    }
    if (filters.action) {
      entries = entries.filter((e) => e.action === filters.action);
    }
    if (filters.startDate) {
      entries = entries.filter((e) => e.timestamp >= filters.startDate!);
    }
    if (filters.endDate) {
      entries = entries.filter((e) => e.timestamp <= filters.endDate!);
    }

    const total = entries.length;

    // Sort newest first
    entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    const offset = filters.offset ?? 0;
    const limit = Math.min(filters.limit ?? 100, 500);
    entries = entries.slice(offset, offset + limit);

    return { entries, total };
  }

  /**
   * Verify the integrity of the audit log hash chain.
   */
  verifyAuditIntegrity(): { valid: boolean; brokenAtIndex: number | null; totalEntries: number } {
    let prevHash: string | null = null;

    for (let i = 0; i < this.auditLog.length; i++) {
      const entry = this.auditLog[i];
      const expectedHash = sha256Hex(`${entry.payloadHash}:${prevHash ?? 'GENESIS'}`);

      if (entry.entryHash !== expectedHash || entry.prevHash !== prevHash) {
        return { valid: false, brokenAtIndex: i, totalEntries: this.auditLog.length };
      }

      prevHash = entry.entryHash;
    }

    return { valid: true, brokenAtIndex: null, totalEntries: this.auditLog.length };
  }

  // ─── Compliance Rules ────────────────────────────────────────────────

  /**
   * Add a new compliance rule.
   */
  addRule(input: {
    type: ComplianceRuleType;
    name: string;
    description: string;
    params: Record<string, unknown>;
    enabled?: boolean;
  }): ComplianceRule {
    const now = isoNow();
    const rule: ComplianceRule = {
      id: uuid(),
      type: input.type,
      name: input.name,
      description: input.description,
      enabled: input.enabled ?? true,
      params: input.params,
      createdAt: now,
      updatedAt: now,
    };

    this.rules.set(rule.id, rule);

    this.appendAuditEntry('system', 'rule.created', {
      ruleId: rule.id,
      type: rule.type,
      name: rule.name,
    });

    return rule;
  }

  /**
   * List all compliance rules.
   */
  listRules(): ComplianceRule[] {
    return Array.from(this.rules.values());
  }

  /**
   * Evaluate all enabled rules against a potential trade.
   */
  evaluateRules(agentId: string, trade: {
    symbol: string;
    side: 'buy' | 'sell';
    notionalUsd: number;
    timestamp?: string;
  }): RuleViolation[] {
    const newViolations: RuleViolation[] = [];
    const now = trade.timestamp ?? isoNow();
    const state = this.store.snapshot();

    for (const rule of this.rules.values()) {
      if (!rule.enabled) continue;

      let violation: RuleViolation | null = null;

      switch (rule.type) {
        case 'max-daily-volume': {
          const maxVolume = rule.params.maxDailyVolumeUsd as number;
          const todayVolume = this.getDailyVolume(agentId);
          if (todayVolume + trade.notionalUsd > maxVolume) {
            violation = {
              ruleId: rule.id,
              ruleName: rule.name,
              ruleType: rule.type,
              agentId,
              details: `Daily volume would exceed limit: ${todayVolume + trade.notionalUsd} > ${maxVolume} USD`,
              timestamp: now,
              severity: 'high',
            };
          }
          break;
        }

        case 'restricted-token': {
          const restricted = rule.params.restrictedTokens as string[];
          if (restricted.includes(trade.symbol.toUpperCase())) {
            violation = {
              ruleId: rule.id,
              ruleName: rule.name,
              ruleType: rule.type,
              agentId,
              details: `Token ${trade.symbol} is restricted`,
              timestamp: now,
              severity: 'critical',
            };
          }
          break;
        }

        case 'trading-hours': {
          const startHour = rule.params.startHourUtc as number;
          const endHour = rule.params.endHourUtc as number;
          const currentHour = new Date(now).getUTCHours();
          if (currentHour < startHour || currentHour >= endHour) {
            violation = {
              ruleId: rule.id,
              ruleName: rule.name,
              ruleType: rule.type,
              agentId,
              details: `Trade outside allowed hours (${startHour}:00-${endHour}:00 UTC). Current hour: ${currentHour}`,
              timestamp: now,
              severity: 'medium',
            };
          }
          break;
        }

        case 'max-single-trade': {
          const maxSingle = rule.params.maxSingleTradeUsd as number;
          if (trade.notionalUsd > maxSingle) {
            violation = {
              ruleId: rule.id,
              ruleName: rule.name,
              ruleType: rule.type,
              agentId,
              details: `Single trade ${trade.notionalUsd} USD exceeds limit of ${maxSingle} USD`,
              timestamp: now,
              severity: 'high',
            };
          }
          break;
        }

        case 'max-daily-trades': {
          const maxTrades = rule.params.maxDailyTrades as number;
          const todayTrades = this.getDailyTradeCount(agentId);
          if (todayTrades >= maxTrades) {
            violation = {
              ruleId: rule.id,
              ruleName: rule.name,
              ruleType: rule.type,
              agentId,
              details: `Daily trade count ${todayTrades + 1} would exceed limit of ${maxTrades}`,
              timestamp: now,
              severity: 'medium',
            };
          }
          break;
        }

        default:
          break;
      }

      if (violation) {
        newViolations.push(violation);
        if (!this.violations.has(agentId)) {
          this.violations.set(agentId, []);
        }
        this.violations.get(agentId)!.push(violation);

        this.appendAuditEntry(agentId, 'rule.violation', {
          ruleId: rule.id,
          ruleType: rule.type,
          details: violation.details,
          severity: violation.severity,
        });
      }
    }

    return newViolations;
  }

  // ─── KYC Status Tracking ──────────────────────────────────────────────

  /**
   * Get KYC status for an agent.
   */
  getKycStatus(agentId: string): KycRecord {
    if (!this.kycRecords.has(agentId)) {
      // Auto-create a default record
      const record: KycRecord = {
        agentId,
        status: 'not_started',
        level: 0,
        submittedAt: null,
        verifiedAt: null,
        expiresAt: null,
        rejectionReason: null,
        documents: [],
        updatedAt: isoNow(),
      };
      this.kycRecords.set(agentId, record);
    }
    return this.kycRecords.get(agentId)!;
  }

  /**
   * Update KYC status for an agent.
   */
  updateKycStatus(agentId: string, update: {
    status?: KycStatus;
    level?: number;
    documents?: string[];
    rejectionReason?: string | null;
  }): KycRecord {
    const record = this.getKycStatus(agentId);
    const now = isoNow();

    if (update.status !== undefined) record.status = update.status;
    if (update.level !== undefined) record.level = update.level;
    if (update.documents !== undefined) record.documents = update.documents;
    if (update.rejectionReason !== undefined) record.rejectionReason = update.rejectionReason;

    if (update.status === 'verified') {
      record.verifiedAt = now;
      // KYC valid for 1 year
      const expiry = new Date();
      expiry.setFullYear(expiry.getFullYear() + 1);
      record.expiresAt = expiry.toISOString();
    }

    if (update.status === 'pending' && !record.submittedAt) {
      record.submittedAt = now;
    }

    record.updatedAt = now;
    this.kycRecords.set(agentId, record);

    this.appendAuditEntry(agentId, 'kyc.updated', {
      status: record.status,
      level: record.level,
    });

    return record;
  }

  // ─── Suspicious Activity Detection ────────────────────────────────────

  /**
   * Analyze an agent's trading patterns for suspicious activity.
   */
  detectSuspiciousActivity(agentId: string): SuspiciousActivity[] {
    const state = this.store.snapshot();
    const executions = Object.values(state.executions)
      .filter((ex) => ex.agentId === agentId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    const detected: SuspiciousActivity[] = [];

    // 1. Wash trading detection: rapid buy-sell or sell-buy on the same token
    detected.push(...this.detectWashTrading(agentId, executions));

    // 2. Volume spike detection
    detected.push(...this.detectVolumeSpikes(agentId, executions));

    // 3. Circular trade detection
    detected.push(...this.detectCircularTrades(agentId, executions));

    // 4. Rapid-fire trading detection
    detected.push(...this.detectRapidFire(agentId, executions));

    // Store and return
    this.suspiciousActivities.set(agentId, [
      ...(this.suspiciousActivities.get(agentId) ?? []),
      ...detected,
    ]);

    for (const activity of detected) {
      this.appendAuditEntry(agentId, 'suspicious.detected', {
        type: activity.type,
        confidence: activity.confidence,
        severity: activity.severity,
        description: activity.description,
      });
    }

    return detected;
  }

  /**
   * Get suspicious activities for an agent.
   */
  getSuspiciousActivities(agentId: string): SuspiciousActivity[] {
    return this.suspiciousActivities.get(agentId) ?? [];
  }

  // ─── Report Generation ────────────────────────────────────────────────

  /**
   * Generate a compliance report for an agent.
   */
  generateReport(agentId: string, period: 'daily' | 'weekly'): ComplianceReport {
    const state = this.store.snapshot();
    const now = new Date();
    const startDate = new Date(now);

    if (period === 'daily') {
      startDate.setDate(startDate.getDate() - 1);
    } else {
      startDate.setDate(startDate.getDate() - 7);
    }

    const startStr = startDate.toISOString();
    const endStr = now.toISOString();

    // Gather executions in period
    const executions = Object.values(state.executions)
      .filter((ex) => ex.agentId === agentId && ex.createdAt >= startStr && ex.createdAt <= endStr);

    // Trade breakdown
    const bySymbol: Record<string, { count: number; volumeUsd: number }> = {};
    let buyCount = 0;
    let sellCount = 0;
    let totalVolume = 0;

    for (const ex of executions) {
      if (!bySymbol[ex.symbol]) {
        bySymbol[ex.symbol] = { count: 0, volumeUsd: 0 };
      }
      bySymbol[ex.symbol].count += 1;
      bySymbol[ex.symbol].volumeUsd += ex.grossNotionalUsd;
      totalVolume += ex.grossNotionalUsd;

      if (ex.side === 'buy') buyCount++;
      else sellCount++;
    }

    const agentViolations = (this.violations.get(agentId) ?? [])
      .filter((v) => v.timestamp >= startStr && v.timestamp <= endStr);

    const agentSuspicious = (this.suspiciousActivities.get(agentId) ?? [])
      .filter((s) => s.detectedAt >= startStr && s.detectedAt <= endStr);

    const kyc = this.getKycStatus(agentId);

    // Compliance score: 100 - deductions
    let score = 100;
    score -= agentViolations.length * 10;
    score -= agentSuspicious.length * 15;
    if (kyc.status !== 'verified') score -= 20;
    score = Math.max(0, Math.min(100, score));

    const report: ComplianceReport = {
      agentId,
      period,
      startDate: startStr,
      endDate: endStr,
      generatedAt: isoNow(),
      summary: {
        totalTrades: executions.length,
        totalVolumeUsd: Number(totalVolume.toFixed(2)),
        ruleViolations: agentViolations.length,
        suspiciousActivities: agentSuspicious.length,
        kycStatus: kyc.status,
        complianceScore: score,
      },
      violations: agentViolations,
      suspiciousActivities: agentSuspicious,
      tradeBreakdown: {
        bySymbol,
        bySide: { buy: buyCount, sell: sellCount },
      },
    };

    this.appendAuditEntry(agentId, 'report.generated', {
      period,
      complianceScore: score,
      totalTrades: executions.length,
    });

    return report;
  }

  // ─── Regulatory Export ────────────────────────────────────────────────

  /**
   * Export agent data in a regulatory-ready format (JSON or CSV).
   */
  exportRegulatoryData(agentId: string, format: 'json' | 'csv' = 'json'): RegulatoryExport {
    const state = this.store.snapshot();

    const executions = Object.values(state.executions)
      .filter((ex) => ex.agentId === agentId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    const kyc = this.getKycStatus(agentId);
    const violations = this.violations.get(agentId) ?? [];
    const suspicious = this.suspiciousActivities.get(agentId) ?? [];

    const auditEntries = this.auditLog.filter((e) => e.agentId === agentId);

    if (format === 'csv') {
      const header = 'execution_id,agent_id,symbol,side,quantity,price_usd,notional_usd,fee_usd,mode,status,created_at';
      const rows = executions.map((ex) =>
        `${ex.id},${ex.agentId},${ex.symbol},${ex.side},${ex.quantity},${ex.priceUsd},${ex.grossNotionalUsd},${ex.feeUsd},${ex.mode},${ex.status},${ex.createdAt}`
      );
      const csv = [header, ...rows].join('\n');

      this.appendAuditEntry(agentId, 'export.regulatory', { format: 'csv', recordCount: executions.length });

      return {
        agentId,
        exportedAt: isoNow(),
        format: 'csv',
        data: csv,
      };
    }

    // JSON format
    const data = {
      agent: state.agents[agentId] ? {
        id: state.agents[agentId].id,
        name: state.agents[agentId].name,
        createdAt: state.agents[agentId].createdAt,
        strategyId: state.agents[agentId].strategyId,
      } : null,
      kyc,
      executions: executions.map((ex) => ({
        id: ex.id,
        symbol: ex.symbol,
        side: ex.side,
        quantity: ex.quantity,
        priceUsd: ex.priceUsd,
        grossNotionalUsd: ex.grossNotionalUsd,
        feeUsd: ex.feeUsd,
        mode: ex.mode,
        status: ex.status,
        createdAt: ex.createdAt,
      })),
      violations,
      suspiciousActivities: suspicious,
      auditLog: auditEntries.slice(-500), // Last 500 entries
    };

    this.appendAuditEntry(agentId, 'export.regulatory', { format: 'json', recordCount: executions.length });

    return {
      agentId,
      exportedAt: isoNow(),
      format: 'json',
      data,
    };
  }

  // ─── Private Helpers ──────────────────────────────────────────────────

  private getDailyVolume(agentId: string): number {
    const state = this.store.snapshot();
    const today = dayKey();

    return Object.values(state.executions)
      .filter((ex) => ex.agentId === agentId && dayKey(ex.createdAt) === today)
      .reduce((sum, ex) => sum + ex.grossNotionalUsd, 0);
  }

  private getDailyTradeCount(agentId: string): number {
    const state = this.store.snapshot();
    const today = dayKey();

    return Object.values(state.executions)
      .filter((ex) => ex.agentId === agentId && dayKey(ex.createdAt) === today)
      .length;
  }

  private detectWashTrading(agentId: string, executions: Array<{
    symbol: string;
    side: string;
    createdAt: string;
    grossNotionalUsd: number;
  }>): SuspiciousActivity[] {
    const detected: SuspiciousActivity[] = [];

    for (let i = 0; i < executions.length; i++) {
      for (let j = i + 1; j < executions.length; j++) {
        const a = executions[i];
        const b = executions[j];

        if (a.symbol !== b.symbol) continue;
        if (a.side === b.side) continue;

        const timeDiff = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
        if (timeDiff > WASH_TRADE_WINDOW_MS) break; // sorted by time, no need to check further

        const volumeRatio = Math.min(a.grossNotionalUsd, b.grossNotionalUsd) /
          Math.max(a.grossNotionalUsd, b.grossNotionalUsd);

        if (volumeRatio > 0.8) {
          detected.push({
            id: uuid(),
            agentId,
            type: 'wash-trading',
            description: `Potential wash trade on ${a.symbol}: buy/sell within ${timeDiff}ms with similar volume (ratio: ${volumeRatio.toFixed(2)})`,
            confidence: Math.min(1, volumeRatio * (1 - timeDiff / WASH_TRADE_WINDOW_MS)),
            severity: 'high',
            evidence: {
              symbol: a.symbol,
              timeDiffMs: timeDiff,
              volumeRatio,
              tradeA: { side: a.side, notionalUsd: a.grossNotionalUsd },
              tradeB: { side: b.side, notionalUsd: b.grossNotionalUsd },
            },
            detectedAt: isoNow(),
            resolved: false,
          });
        }
      }
    }

    return detected;
  }

  private detectVolumeSpikes(agentId: string, executions: Array<{
    grossNotionalUsd: number;
    createdAt: string;
  }>): SuspiciousActivity[] {
    const detected: SuspiciousActivity[] = [];
    if (executions.length < 5) return detected;

    // Calculate average daily volume
    const dailyVolumes: Record<string, number> = {};
    for (const ex of executions) {
      const day = dayKey(ex.createdAt);
      dailyVolumes[day] = (dailyVolumes[day] ?? 0) + ex.grossNotionalUsd;
    }

    const volumes = Object.values(dailyVolumes);
    if (volumes.length < 2) return detected;

    const avg = volumes.slice(0, -1).reduce((sum, v) => sum + v, 0) / (volumes.length - 1);
    const latestVolume = volumes[volumes.length - 1];

    if (avg > 0 && latestVolume > avg * VOLUME_SPIKE_MULTIPLIER) {
      detected.push({
        id: uuid(),
        agentId,
        type: 'volume-spike',
        description: `Volume spike detected: latest daily volume $${latestVolume.toFixed(2)} is ${(latestVolume / avg).toFixed(1)}x the average $${avg.toFixed(2)}`,
        confidence: Math.min(1, (latestVolume / avg - VOLUME_SPIKE_MULTIPLIER) / VOLUME_SPIKE_MULTIPLIER),
        severity: latestVolume > avg * 10 ? 'critical' : 'medium',
        evidence: {
          latestVolumeUsd: latestVolume,
          averageVolumeUsd: avg,
          multiplier: latestVolume / avg,
        },
        detectedAt: isoNow(),
        resolved: false,
      });
    }

    return detected;
  }

  private detectCircularTrades(agentId: string, executions: Array<{
    symbol: string;
    side: string;
    createdAt: string;
    grossNotionalUsd: number;
  }>): SuspiciousActivity[] {
    const detected: SuspiciousActivity[] = [];

    // Look for patterns like: buy A -> sell A -> buy A within short timeframe
    const symbolTrades: Record<string, Array<{ side: string; createdAt: string; grossNotionalUsd: number }>> = {};

    for (const ex of executions) {
      if (!symbolTrades[ex.symbol]) symbolTrades[ex.symbol] = [];
      symbolTrades[ex.symbol].push({ side: ex.side, createdAt: ex.createdAt, grossNotionalUsd: ex.grossNotionalUsd });
    }

    for (const [symbol, trades] of Object.entries(symbolTrades)) {
      if (trades.length < 3) continue;

      for (let i = 0; i <= trades.length - 3; i++) {
        const [a, b, c] = [trades[i], trades[i + 1], trades[i + 2]];

        // Circular pattern: same direction at start and end, different in middle
        if (a.side === c.side && a.side !== b.side) {
          const totalTime = new Date(c.createdAt).getTime() - new Date(a.createdAt).getTime();

          if (totalTime < WASH_TRADE_WINDOW_MS * 5) {
            detected.push({
              id: uuid(),
              agentId,
              type: 'circular-trades',
              description: `Circular trade pattern on ${symbol}: ${a.side} -> ${b.side} -> ${c.side} within ${totalTime}ms`,
              confidence: 0.7,
              severity: 'medium',
              evidence: {
                symbol,
                pattern: [a.side, b.side, c.side],
                totalTimeMs: totalTime,
                volumes: [a.grossNotionalUsd, b.grossNotionalUsd, c.grossNotionalUsd],
              },
              detectedAt: isoNow(),
              resolved: false,
            });
          }
        }
      }
    }

    return detected;
  }

  private detectRapidFire(agentId: string, executions: Array<{
    createdAt: string;
  }>): SuspiciousActivity[] {
    const detected: SuspiciousActivity[] = [];
    if (executions.length < RAPID_FIRE_THRESHOLD) return detected;

    // Check each 1-minute window
    for (let i = 0; i <= executions.length - RAPID_FIRE_THRESHOLD; i++) {
      const windowStart = new Date(executions[i].createdAt).getTime();
      const windowEnd = windowStart + 60_000;

      let count = 0;
      for (let j = i; j < executions.length; j++) {
        const t = new Date(executions[j].createdAt).getTime();
        if (t > windowEnd) break;
        count++;
      }

      if (count >= RAPID_FIRE_THRESHOLD) {
        detected.push({
          id: uuid(),
          agentId,
          type: 'rapid-fire',
          description: `Rapid-fire trading detected: ${count} trades within 1 minute`,
          confidence: Math.min(1, count / (RAPID_FIRE_THRESHOLD * 2)),
          severity: count >= RAPID_FIRE_THRESHOLD * 2 ? 'high' : 'medium',
          evidence: {
            tradeCount: count,
            windowMs: 60_000,
            threshold: RAPID_FIRE_THRESHOLD,
          },
          detectedAt: isoNow(),
          resolved: false,
        });
        break; // Report once
      }
    }

    return detected;
  }

  private seedDefaultRules(): void {
    this.addRule({
      type: 'max-daily-volume',
      name: 'Default Daily Volume Limit',
      description: 'Maximum daily trading volume per agent',
      params: { maxDailyVolumeUsd: 1_000_000 },
    });

    this.addRule({
      type: 'restricted-token',
      name: 'Default Restricted Tokens',
      description: 'Tokens that agents are not allowed to trade',
      params: { restrictedTokens: ['SCAM', 'RUG'] },
    });

    this.addRule({
      type: 'trading-hours',
      name: 'Default Trading Hours',
      description: 'Allowed trading hours (24/7 for crypto)',
      params: { startHourUtc: 0, endHourUtc: 24 },
      enabled: false, // Disabled by default for crypto
    });
  }

  private hookEventBus(): void {
    eventBus.on('intent.executed', (_type, data: unknown) => {
      const d = data as {
        intentId: string;
        agentId: string;
        executionId: string;
        symbol: string;
        side: string;
        notionalUsd: number;
      };

      this.appendAuditEntry(d.agentId, 'trade.executed', {
        intentId: d.intentId,
        executionId: d.executionId,
        symbol: d.symbol,
        side: d.side,
        notionalUsd: d.notionalUsd,
      });
    });

    eventBus.on('intent.rejected', (_type, data: unknown) => {
      const d = data as { intentId: string; agentId: string; reason: string };
      this.appendAuditEntry(d.agentId, 'trade.rejected', {
        intentId: d.intentId,
        reason: d.reason,
      });
    });

    eventBus.on('agent.registered', (_type, data: unknown) => {
      const d = data as { agentId: string; name: string };
      this.appendAuditEntry(d.agentId, 'agent.registered', {
        name: d.name,
      });
    });
  }
}
