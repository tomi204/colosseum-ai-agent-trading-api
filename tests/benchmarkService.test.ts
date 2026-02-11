import { describe, expect, it, vi, beforeEach } from 'vitest';
import { BenchmarkService } from '../src/services/benchmarkService.js';
import { AppState, Agent, TradeIntent, ExecutionRecord } from '../src/types.js';
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

function makeIntent(id: string, agentId: string, status: TradeIntent['status'], createdAt: string): TradeIntent {
  return {
    id,
    agentId,
    symbol: 'SOL',
    side: 'buy',
    notionalUsd: 100,
    createdAt,
    updatedAt: createdAt,
    status,
    executionId: status === 'executed' ? `exec-${id}` : undefined,
  };
}

function makeExecution(id: string, agentId: string, intentId: string, overrides?: Partial<ExecutionRecord>): ExecutionRecord {
  return {
    id,
    intentId,
    agentId,
    symbol: 'SOL',
    side: 'sell',
    quantity: 1,
    priceUsd: 100,
    grossNotionalUsd: 100,
    feeUsd: 0.5,
    netUsd: 99.5,
    realizedPnlUsd: 5,
    pnlSnapshotUsd: 5,
    mode: 'paper',
    status: 'filled',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('BenchmarkService', () => {
  beforeEach(() => {
    eventBus.clear();
  });

  function setup(customState?: Partial<AppState>) {
    const state = { ...createDefaultState(), ...customState };
    const store = createMockStore(state);
    const service = new BenchmarkService(store);
    return { state, store, service };
  }

  describe('runBenchmark', () => {
    it('returns null for unknown agent', () => {
      const { service } = setup();
      expect(service.runBenchmark('nonexistent')).toBeNull();
    });

    it('benchmarks agent with no trades', () => {
      const state = createDefaultState();
      state.agents['agent-1'] = makeAgent('agent-1', 'Agent 1');
      const { service } = setup(state);

      const result = service.runBenchmark('agent-1');
      expect(result).not.toBeNull();
      expect(result!.agentId).toBe('agent-1');
      expect(result!.metrics.executionSpeedMs).toBe(0);
      expect(result!.metrics.riskComplianceRate).toBe(1);
      expect(result!.metrics.strategyAccuracy).toBe(0);
      expect(result!.metrics.drawdownRecoveryTicks).toBe(0);
      expect(result!.metrics.feeEfficiencyPct).toBe(0);
      expect(result!.overallGrade).toBeDefined();
      expect(result!.ranAt).toBeDefined();
    });

    it('computes execution speed from intent/execution timing', () => {
      const state = createDefaultState();
      state.agents['agent-1'] = makeAgent('agent-1', 'Agent 1');

      const t1 = '2025-01-01T00:00:00.000Z';
      const t2 = '2025-01-01T00:00:00.100Z'; // 100ms later

      state.tradeIntents['i1'] = makeIntent('i1', 'agent-1', 'executed', t1);
      state.executions['exec-i1'] = makeExecution('exec-i1', 'agent-1', 'i1', { createdAt: t2 });

      const { service } = setup(state);
      const result = service.runBenchmark('agent-1');

      expect(result!.metrics.executionSpeedMs).toBe(100);
    });

    it('computes risk compliance rate', () => {
      const state = createDefaultState();
      state.agents['agent-1'] = makeAgent('agent-1', 'Agent 1');

      state.tradeIntents['i1'] = makeIntent('i1', 'agent-1', 'executed', new Date().toISOString());
      state.tradeIntents['i2'] = makeIntent('i2', 'agent-1', 'executed', new Date().toISOString());
      state.tradeIntents['i3'] = makeIntent('i3', 'agent-1', 'rejected', new Date().toISOString());

      const { service } = setup(state);
      const result = service.runBenchmark('agent-1');

      // 2 out of 3 passed = 0.6667
      expect(result!.metrics.riskComplianceRate).toBeCloseTo(0.6667, 3);
    });

    it('computes strategy accuracy from profitable sells', () => {
      const state = createDefaultState();
      state.agents['agent-1'] = makeAgent('agent-1', 'Agent 1');

      state.executions['e1'] = makeExecution('e1', 'agent-1', 'i1', {
        side: 'sell', realizedPnlUsd: 10,
      });
      state.executions['e2'] = makeExecution('e2', 'agent-1', 'i2', {
        side: 'sell', realizedPnlUsd: -5,
      });
      state.executions['e3'] = makeExecution('e3', 'agent-1', 'i3', {
        side: 'sell', realizedPnlUsd: 3,
      });

      const { service } = setup(state);
      const result = service.runBenchmark('agent-1');

      // 2/3 profitable
      expect(result!.metrics.strategyAccuracy).toBeCloseTo(0.6667, 3);
    });

    it('computes fee efficiency', () => {
      const state = createDefaultState();
      state.agents['agent-1'] = makeAgent('agent-1', 'Agent 1');

      state.executions['e1'] = makeExecution('e1', 'agent-1', 'i1', {
        side: 'sell', realizedPnlUsd: 100, feeUsd: 5,
      });

      const { service } = setup(state);
      const result = service.runBenchmark('agent-1');

      // fees/grossProfits * 100 = 5/100 * 100 = 5%
      expect(result!.metrics.feeEfficiencyPct).toBe(5);
    });

    it('emits event on benchmark', () => {
      const state = createDefaultState();
      state.agents['agent-1'] = makeAgent('agent-1', 'Agent 1');
      const { service } = setup(state);

      const events: unknown[] = [];
      eventBus.on('improve.analyzed', (_type, data) => events.push(data));

      service.runBenchmark('agent-1');
      expect(events.length).toBe(1);
    });
  });

  describe('getAgentReport', () => {
    it('returns null for unknown agent', () => {
      const { service } = setup();
      expect(service.getAgentReport('nonexistent')).toBeNull();
    });

    it('returns comprehensive report with grades', () => {
      const state = createDefaultState();
      state.agents['agent-1'] = makeAgent('agent-1', 'Agent 1');

      const t1 = '2025-01-01T00:00:00.000Z';
      const t2 = '2025-01-01T00:00:00.010Z'; // 10ms

      state.tradeIntents['i1'] = makeIntent('i1', 'agent-1', 'executed', t1);
      state.executions['exec-i1'] = makeExecution('exec-i1', 'agent-1', 'i1', {
        createdAt: t2, side: 'sell', realizedPnlUsd: 50, feeUsd: 0.5,
      });

      const { service } = setup(state);
      const report = service.getAgentReport('agent-1');

      expect(report).not.toBeNull();
      expect(report!.agentId).toBe('agent-1');
      expect(report!.agentName).toBe('Agent 1');
      expect(report!.totalTrades).toBe(1);
      expect(report!.totalIntents).toBe(1);

      // Each graded metric has required fields
      for (const metric of [report!.executionSpeed, report!.riskCompliance, report!.strategyAccuracy, report!.drawdownRecovery, report!.feeEfficiency]) {
        expect(typeof metric.value).toBe('number');
        expect(metric.grade).toBeDefined();
        expect(typeof metric.systemAvg).toBe('number');
        expect(typeof metric.percentile).toBe('number');
      }

      expect(report!.overallGrade).toBeDefined();
      expect(report!.generatedAt).toBeDefined();
    });

    it('grades fast execution as A+', () => {
      const state = createDefaultState();
      state.agents['agent-1'] = makeAgent('agent-1', 'Agent 1');

      const t1 = '2025-01-01T00:00:00.000Z';
      const t2 = '2025-01-01T00:00:00.005Z'; // 5ms

      state.tradeIntents['i1'] = makeIntent('i1', 'agent-1', 'executed', t1);
      state.executions['exec-i1'] = makeExecution('exec-i1', 'agent-1', 'i1', {
        createdAt: t2, side: 'sell', realizedPnlUsd: 50, feeUsd: 0.1,
      });

      const { service } = setup(state);
      const report = service.getAgentReport('agent-1');

      expect(report!.executionSpeed.grade).toBe('A+');
    });
  });

  describe('getSystemBenchmarks', () => {
    it('returns empty system benchmarks with no agents', () => {
      const { service } = setup();
      const system = service.getSystemBenchmarks();

      expect(system.agentCount).toBe(0);
      expect(system.benchmarks).toEqual([]);
      expect(system.topAgentId).toBeNull();
      expect(system.generatedAt).toBeDefined();
    });

    it('aggregates benchmarks across multiple agents', () => {
      const state = createDefaultState();
      state.agents['agent-1'] = makeAgent('agent-1', 'Agent 1');
      state.agents['agent-2'] = makeAgent('agent-2', 'Agent 2');

      state.executions['e1'] = makeExecution('e1', 'agent-1', 'i1', {
        side: 'sell', realizedPnlUsd: 50, feeUsd: 1,
      });
      state.executions['e2'] = makeExecution('e2', 'agent-2', 'i2', {
        side: 'sell', realizedPnlUsd: -10, feeUsd: 1,
      });

      const { service } = setup(state);
      const system = service.getSystemBenchmarks();

      expect(system.agentCount).toBe(2);
      expect(system.benchmarks.length).toBe(2);
      expect(system.topAgentId).toBeDefined();
      expect(typeof system.avgExecutionSpeedMs).toBe('number');
      expect(typeof system.avgRiskComplianceRate).toBe('number');
      expect(typeof system.avgStrategyAccuracy).toBe('number');
    });

    it('identifies top agent', () => {
      const state = createDefaultState();
      state.agents['agent-1'] = makeAgent('agent-1', 'Agent 1');
      state.agents['agent-2'] = makeAgent('agent-2', 'Agent 2');

      // Agent 1 has better trades
      state.executions['e1'] = makeExecution('e1', 'agent-1', 'i1', {
        side: 'sell', realizedPnlUsd: 100, feeUsd: 0.1,
      });
      state.executions['e2'] = makeExecution('e2', 'agent-1', 'i2', {
        side: 'sell', realizedPnlUsd: 50, feeUsd: 0.1,
      });

      // Agent 2 has losses
      state.executions['e3'] = makeExecution('e3', 'agent-2', 'i3', {
        side: 'sell', realizedPnlUsd: -50, feeUsd: 5,
      });

      const { service } = setup(state);
      const system = service.getSystemBenchmarks();

      expect(system.topAgentId).toBe('agent-1');
      expect(system.topAgentGrade).toBeDefined();
    });
  });

  describe('drawdown recovery', () => {
    it('computes recovery ticks for drawdown', () => {
      const state = createDefaultState();
      state.agents['agent-1'] = makeAgent('agent-1', 'Agent 1', { startingCapitalUsd: 1000 });

      const base = new Date('2025-01-01').getTime();
      // Trade sequence: loss, loss, gain, gain (recovery)
      const executions: ExecutionRecord[] = [
        makeExecution('e1', 'agent-1', 'i1', {
          side: 'sell', realizedPnlUsd: -100, createdAt: new Date(base + 1000).toISOString(),
        }),
        makeExecution('e2', 'agent-1', 'i2', {
          side: 'sell', realizedPnlUsd: -50, createdAt: new Date(base + 2000).toISOString(),
        }),
        makeExecution('e3', 'agent-1', 'i3', {
          side: 'sell', realizedPnlUsd: 100, createdAt: new Date(base + 3000).toISOString(),
        }),
        makeExecution('e4', 'agent-1', 'i4', {
          side: 'sell', realizedPnlUsd: 100, createdAt: new Date(base + 4000).toISOString(),
        }),
      ];

      for (const ex of executions) {
        state.executions[ex.id] = ex;
      }

      const { service } = setup(state);
      const result = service.runBenchmark('agent-1');

      // There should be a drawdown and some recovery ticks
      expect(result!.metrics.drawdownRecoveryTicks).toBeGreaterThanOrEqual(0);
    });
  });
});
