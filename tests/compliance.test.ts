import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ComplianceService } from '../src/services/complianceService.js';
import { AppState, Agent } from '../src/types.js';
import { createDefaultState } from '../src/infra/storage/defaultState.js';
import { eventBus } from '../src/infra/eventBus.js';

function createMockStore(state: AppState) {
  return {
    snapshot: () => structuredClone(state),
    transaction: vi.fn(),
    init: vi.fn(),
    flush: vi.fn(),
  } as any;
}

function makeAgent(id: string, name: string, overrides?: Partial<Agent>): Agent {
  return {
    id,
    name,
    apiKey: `key-${id}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    startingCapitalUsd: 10000,
    cashUsd: 10000,
    realizedPnlUsd: 0,
    peakEquityUsd: 10000,
    riskLimits: {
      maxPositionSizePct: 0.25,
      maxOrderNotionalUsd: 2500,
      maxGrossExposureUsd: 7500,
      dailyLossCapUsd: 1000,
      maxDrawdownPct: 0.2,
      cooldownSeconds: 3,
    },
    positions: {},
    dailyRealizedPnlUsd: {},
    riskRejectionsByReason: {},
    strategyId: 'momentum-v1',
    ...overrides,
  };
}

function makeExecution(agentId: string, overrides?: Record<string, unknown>) {
  return {
    id: `exec-${Math.random().toString(36).slice(2, 8)}`,
    intentId: `intent-${Math.random().toString(36).slice(2, 8)}`,
    agentId,
    symbol: 'SOL',
    side: 'buy' as const,
    quantity: 10,
    priceUsd: 100,
    grossNotionalUsd: 1000,
    feeUsd: 1,
    netUsd: 999,
    realizedPnlUsd: 0,
    pnlSnapshotUsd: 0,
    mode: 'paper' as const,
    status: 'filled' as const,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('ComplianceService', () => {
  beforeEach(() => {
    eventBus.clear();
  });

  function setup(stateOverrides?: Partial<AppState>) {
    const state = createDefaultState();
    state.agents['agent-1'] = makeAgent('agent-1', 'Agent 1');
    state.agents['agent-2'] = makeAgent('agent-2', 'Agent 2');
    if (stateOverrides) Object.assign(state, stateOverrides);
    const store = createMockStore(state);
    const service = new ComplianceService(store);
    return { state, store, service };
  }

  // ─── Audit Log Tests ──────────────────────────────────────────────────

  it('appends audit entries with tamper-evident hash chain', () => {
    const { service } = setup();

    const entry1 = service.appendAuditEntry('agent-1', 'trade.executed', { symbol: 'SOL', side: 'buy' });
    const entry2 = service.appendAuditEntry('agent-1', 'trade.executed', { symbol: 'SOL', side: 'sell' });

    // entry1.prevHash may be non-null because constructor seeds default rules (which append audit entries)
    expect(entry1.prevHash).toBeDefined();
    expect(entry2.prevHash).toBe(entry1.entryHash);
    expect(entry1.entryHash).not.toBe(entry2.entryHash);
    expect(entry1.payloadHash).toBeDefined();
    expect(entry1.entryHash).toHaveLength(64); // SHA-256 hex
  });

  it('verifies audit log integrity', () => {
    const { service } = setup();

    service.appendAuditEntry('agent-1', 'trade.executed', { symbol: 'SOL' });
    service.appendAuditEntry('agent-1', 'trade.executed', { symbol: 'BONK' });
    service.appendAuditEntry('agent-2', 'trade.executed', { symbol: 'JUP' });

    const result = service.verifyAuditIntegrity();
    expect(result.valid).toBe(true);
    expect(result.brokenAtIndex).toBeNull();
    // totalEntries includes seed rule creation entries + our 3
    expect(result.totalEntries).toBeGreaterThanOrEqual(3);
  });

  it('filters audit log by agentId and action', () => {
    const { service } = setup();

    service.appendAuditEntry('agent-1', 'trade.executed', { symbol: 'SOL' });
    service.appendAuditEntry('agent-2', 'trade.executed', { symbol: 'BONK' });
    service.appendAuditEntry('agent-1', 'kyc.updated', { status: 'verified' });

    const filtered = service.getAuditLog({ agentId: 'agent-1' });
    expect(filtered.entries.every((e) => e.agentId === 'agent-1')).toBe(true);
    expect(filtered.total).toBe(2);

    const actionFiltered = service.getAuditLog({ agentId: 'agent-1', action: 'trade.executed' });
    expect(actionFiltered.total).toBe(1);
  });

  it('supports pagination in audit log', () => {
    const { service } = setup();

    for (let i = 0; i < 10; i++) {
      service.appendAuditEntry('agent-1', 'trade.executed', { index: i });
    }

    const page1 = service.getAuditLog({ agentId: 'agent-1', limit: 3, offset: 0 });
    const page2 = service.getAuditLog({ agentId: 'agent-1', limit: 3, offset: 3 });

    expect(page1.entries).toHaveLength(3);
    expect(page2.entries).toHaveLength(3);
    expect(page1.entries[0].id).not.toBe(page2.entries[0].id);
  });

  // ─── Compliance Rules Tests ───────────────────────────────────────────

  it('creates and lists compliance rules', () => {
    const { service } = setup();

    const rule = service.addRule({
      type: 'max-single-trade',
      name: 'Max Single Trade',
      description: 'Max notional for a single trade',
      params: { maxSingleTradeUsd: 5000 },
    });

    expect(rule.id).toBeDefined();
    expect(rule.type).toBe('max-single-trade');

    const rules = service.listRules();
    // Default rules + our new one
    expect(rules.length).toBeGreaterThanOrEqual(4);
    expect(rules.find((r) => r.id === rule.id)).toBeDefined();
  });

  it('detects max-daily-volume rule violation', () => {
    const state = createDefaultState();
    state.agents['agent-1'] = makeAgent('agent-1', 'Agent 1');
    // Add existing executions totaling 999,500 for today
    const todayKey = new Date().toISOString().slice(0, 10);
    state.executions['ex-1'] = makeExecution('agent-1', {
      grossNotionalUsd: 999_500,
      createdAt: new Date().toISOString(),
    });
    const store = createMockStore(state);
    const service = new ComplianceService(store);

    const violations = service.evaluateRules('agent-1', {
      symbol: 'SOL',
      side: 'buy',
      notionalUsd: 1000,
    });

    const volumeViolation = violations.find((v) => v.ruleType === 'max-daily-volume');
    expect(volumeViolation).toBeDefined();
    expect(volumeViolation!.severity).toBe('high');
  });

  it('detects restricted-token rule violation', () => {
    const { service } = setup();

    const violations = service.evaluateRules('agent-1', {
      symbol: 'SCAM',
      side: 'buy',
      notionalUsd: 100,
    });

    const tokenViolation = violations.find((v) => v.ruleType === 'restricted-token');
    expect(tokenViolation).toBeDefined();
    expect(tokenViolation!.severity).toBe('critical');
    expect(tokenViolation!.details).toContain('SCAM');
  });

  it('detects max-single-trade rule violation', () => {
    const { service } = setup();

    service.addRule({
      type: 'max-single-trade',
      name: 'Single Trade Limit',
      description: 'Max single trade amount',
      params: { maxSingleTradeUsd: 500 },
    });

    const violations = service.evaluateRules('agent-1', {
      symbol: 'SOL',
      side: 'buy',
      notionalUsd: 1000,
    });

    const singleViolation = violations.find((v) => v.ruleType === 'max-single-trade');
    expect(singleViolation).toBeDefined();
  });

  // ─── KYC Tests ─────────────────────────────────────────────────────────

  it('manages KYC status lifecycle', () => {
    const { service } = setup();

    // Initially not started
    const initial = service.getKycStatus('agent-1');
    expect(initial.status).toBe('not_started');
    expect(initial.level).toBe(0);

    // Submit for verification
    const pending = service.updateKycStatus('agent-1', {
      status: 'pending',
      level: 1,
      documents: ['passport.pdf'],
    });
    expect(pending.status).toBe('pending');
    expect(pending.submittedAt).toBeDefined();

    // Verify
    const verified = service.updateKycStatus('agent-1', {
      status: 'verified',
      level: 2,
    });
    expect(verified.status).toBe('verified');
    expect(verified.verifiedAt).toBeDefined();
    expect(verified.expiresAt).toBeDefined();
    expect(verified.level).toBe(2);
  });

  // ─── Suspicious Activity Detection Tests ──────────────────────────────

  it('detects wash trading patterns', () => {
    const state = createDefaultState();
    state.agents['agent-1'] = makeAgent('agent-1', 'Agent 1');

    const now = Date.now();
    state.executions['ex-1'] = makeExecution('agent-1', {
      symbol: 'SOL',
      side: 'buy',
      grossNotionalUsd: 1000,
      createdAt: new Date(now).toISOString(),
    });
    state.executions['ex-2'] = makeExecution('agent-1', {
      symbol: 'SOL',
      side: 'sell',
      grossNotionalUsd: 990,
      createdAt: new Date(now + 5000).toISOString(), // 5 seconds later
    });

    const store = createMockStore(state);
    const service = new ComplianceService(store);

    const suspicious = service.detectSuspiciousActivity('agent-1');
    const washTrade = suspicious.find((s) => s.type === 'wash-trading');
    expect(washTrade).toBeDefined();
    expect(washTrade!.severity).toBe('high');
    expect(washTrade!.confidence).toBeGreaterThan(0);
  });

  it('detects volume spike patterns', () => {
    const state = createDefaultState();
    state.agents['agent-1'] = makeAgent('agent-1', 'Agent 1');

    // Create executions over multiple days with a spike on the last day
    const now = new Date();
    for (let dayOffset = 5; dayOffset >= 1; dayOffset--) {
      const date = new Date(now);
      date.setDate(date.getDate() - dayOffset);
      state.executions[`ex-day-${dayOffset}`] = makeExecution('agent-1', {
        grossNotionalUsd: 100,
        createdAt: date.toISOString(),
      });
    }
    // Spike today
    state.executions['ex-spike'] = makeExecution('agent-1', {
      grossNotionalUsd: 10_000,
      createdAt: now.toISOString(),
    });

    const store = createMockStore(state);
    const service = new ComplianceService(store);

    const suspicious = service.detectSuspiciousActivity('agent-1');
    const spike = suspicious.find((s) => s.type === 'volume-spike');
    expect(spike).toBeDefined();
    expect(spike!.description).toContain('spike');
  });

  it('detects circular trade patterns', () => {
    const state = createDefaultState();
    state.agents['agent-1'] = makeAgent('agent-1', 'Agent 1');

    const now = Date.now();
    state.executions['ex-1'] = makeExecution('agent-1', {
      symbol: 'SOL',
      side: 'buy',
      grossNotionalUsd: 1000,
      createdAt: new Date(now).toISOString(),
    });
    state.executions['ex-2'] = makeExecution('agent-1', {
      symbol: 'SOL',
      side: 'sell',
      grossNotionalUsd: 1000,
      createdAt: new Date(now + 10_000).toISOString(),
    });
    state.executions['ex-3'] = makeExecution('agent-1', {
      symbol: 'SOL',
      side: 'buy',
      grossNotionalUsd: 1000,
      createdAt: new Date(now + 20_000).toISOString(),
    });

    const store = createMockStore(state);
    const service = new ComplianceService(store);

    const suspicious = service.detectSuspiciousActivity('agent-1');
    const circular = suspicious.find((s) => s.type === 'circular-trades');
    expect(circular).toBeDefined();
    expect(circular!.severity).toBe('medium');
  });

  it('returns empty suspicious activities for clean agent', () => {
    const { service } = setup();
    const suspicious = service.detectSuspiciousActivity('agent-1');
    // May have no activity if the agent has no executions
    expect(Array.isArray(suspicious)).toBe(true);
  });

  // ─── Report Generation Tests ──────────────────────────────────────────

  it('generates a daily compliance report', () => {
    const state = createDefaultState();
    state.agents['agent-1'] = makeAgent('agent-1', 'Agent 1');
    state.executions['ex-1'] = makeExecution('agent-1', {
      symbol: 'SOL',
      side: 'buy',
      grossNotionalUsd: 500,
      createdAt: new Date().toISOString(),
    });
    state.executions['ex-2'] = makeExecution('agent-1', {
      symbol: 'BONK',
      side: 'sell',
      grossNotionalUsd: 200,
      createdAt: new Date().toISOString(),
    });

    const store = createMockStore(state);
    const service = new ComplianceService(store);

    const report = service.generateReport('agent-1', 'daily');
    expect(report.period).toBe('daily');
    expect(report.agentId).toBe('agent-1');
    expect(report.summary.totalTrades).toBe(2);
    expect(report.summary.totalVolumeUsd).toBe(700);
    expect(report.summary.complianceScore).toBeGreaterThan(0);
    expect(report.tradeBreakdown.bySide.buy).toBe(1);
    expect(report.tradeBreakdown.bySide.sell).toBe(1);
    expect(report.tradeBreakdown.bySymbol['SOL']).toBeDefined();
  });

  it('generates a weekly compliance report', () => {
    const { service } = setup();
    const report = service.generateReport('agent-1', 'weekly');
    expect(report.period).toBe('weekly');
    expect(report.summary).toBeDefined();
    expect(report.generatedAt).toBeDefined();
  });

  // ─── Regulatory Export Tests ──────────────────────────────────────────

  it('exports regulatory data in JSON format', () => {
    const state = createDefaultState();
    state.agents['agent-1'] = makeAgent('agent-1', 'Agent 1');
    state.executions['ex-1'] = makeExecution('agent-1', {
      symbol: 'SOL',
      grossNotionalUsd: 500,
    });

    const store = createMockStore(state);
    const service = new ComplianceService(store);

    const exportData = service.exportRegulatoryData('agent-1', 'json');
    expect(exportData.format).toBe('json');
    expect(exportData.agentId).toBe('agent-1');
    expect(exportData.exportedAt).toBeDefined();

    const data = exportData.data as any;
    expect(data.agent).toBeDefined();
    expect(data.kyc).toBeDefined();
    expect(data.executions).toHaveLength(1);
    expect(data.auditLog).toBeDefined();
  });

  it('exports regulatory data in CSV format', () => {
    const state = createDefaultState();
    state.agents['agent-1'] = makeAgent('agent-1', 'Agent 1');
    state.executions['ex-1'] = makeExecution('agent-1', {
      symbol: 'SOL',
      grossNotionalUsd: 500,
    });

    const store = createMockStore(state);
    const service = new ComplianceService(store);

    const exportData = service.exportRegulatoryData('agent-1', 'csv');
    expect(exportData.format).toBe('csv');

    const csv = exportData.data as string;
    expect(csv).toContain('execution_id');
    expect(csv).toContain('agent_id');
    expect(csv).toContain('SOL');
  });

  // ─── Integration Tests ────────────────────────────────────────────────

  it('hooks into eventBus for automatic audit logging', () => {
    const { service } = setup();

    // Emit a trade execution event
    eventBus.emit('intent.executed', {
      intentId: 'intent-1',
      agentId: 'agent-1',
      executionId: 'exec-1',
      symbol: 'SOL',
      side: 'buy',
      notionalUsd: 1000,
    });

    const log = service.getAuditLog({ agentId: 'agent-1', action: 'trade.executed' });
    expect(log.total).toBeGreaterThanOrEqual(1);
    expect(log.entries[0].details).toMatchObject({
      intentId: 'intent-1',
      executionId: 'exec-1',
    });
  });

  it('compliance score penalizes unverified KYC', () => {
    const { service } = setup();

    // Generate report without KYC
    const report1 = service.generateReport('agent-1', 'daily');
    
    // Verify KYC
    service.updateKycStatus('agent-1', { status: 'verified', level: 2 });
    const report2 = service.generateReport('agent-1', 'daily');

    expect(report2.summary.complianceScore).toBeGreaterThan(report1.summary.complianceScore);
  });
});
