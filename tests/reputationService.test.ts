import { describe, expect, it, beforeEach, vi } from 'vitest';
import { ReputationService } from '../src/services/reputationService.js';
import { AppState, Agent, ExecutionRecord, ExecutionReceipt, TradeIntent } from '../src/types.js';
import { createDefaultState } from '../src/infra/storage/defaultState.js';

/**
 * Minimal StateStore stub for testing.
 */
function createMockStore(state: AppState) {
  return {
    snapshot: () => structuredClone(state),
    transaction: vi.fn(),
    init: vi.fn(),
    flush: vi.fn(),
  } as any;
}

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-1',
    name: 'Test Agent',
    apiKey: 'key-1',
    createdAt: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString(), // 15 days ago
    updatedAt: new Date().toISOString(),
    startingCapitalUsd: 10000,
    cashUsd: 10000,
    realizedPnlUsd: 500,
    peakEquityUsd: 10500,
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
    lastTradeAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeExecution(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    id: 'exec-1',
    intentId: 'intent-1',
    agentId: 'agent-1',
    symbol: 'SOL',
    side: 'sell',
    quantity: 1,
    priceUsd: 110,
    grossNotionalUsd: 110,
    feeUsd: 0.088,
    netUsd: 109.912,
    realizedPnlUsd: 10,
    pnlSnapshotUsd: 10,
    mode: 'paper',
    status: 'filled',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeReceipt(executionId: string, agentId: string): ExecutionReceipt {
  return {
    version: 'v1',
    executionId,
    payload: {
      executionId,
      intentId: 'intent-1',
      agentId,
      symbol: 'SOL',
      side: 'sell',
      quantity: 1,
      priceUsd: 110,
      grossNotionalUsd: 110,
      feeUsd: 0.088,
      netUsd: 109.912,
      realizedPnlUsd: 10,
      pnlSnapshotUsd: 10,
      mode: 'paper',
      status: 'filled',
      timestamp: new Date().toISOString(),
    },
    payloadHash: 'hash-1',
    receiptHash: 'rhash-1',
    signaturePayload: {
      scheme: 'colosseum-receipt-signature-v1',
      message: 'msg',
      messageHash: 'mhash',
    },
    createdAt: new Date().toISOString(),
  };
}

describe('ReputationService', () => {
  it('returns null for unknown agent', () => {
    const state = createDefaultState();
    const service = new ReputationService(createMockStore(state));
    expect(service.calculate('nonexistent')).toBeNull();
  });

  it('calculates a positive score for an active agent with wins', () => {
    const state = createDefaultState();
    const agent = makeAgent();
    state.agents[agent.id] = agent;

    // Add 3 winning sell trades and 1 losing
    const exec1 = makeExecution({ id: 'e1', realizedPnlUsd: 50, side: 'sell', createdAt: '2026-02-10T10:00:00.000Z' });
    const exec2 = makeExecution({ id: 'e2', realizedPnlUsd: 30, side: 'sell', createdAt: '2026-02-10T11:00:00.000Z' });
    const exec3 = makeExecution({ id: 'e3', realizedPnlUsd: -10, side: 'sell', createdAt: '2026-02-11T10:00:00.000Z' });
    const exec4 = makeExecution({ id: 'e4', realizedPnlUsd: 20, side: 'sell', createdAt: '2026-02-11T12:00:00.000Z' });

    state.executions = { e1: exec1, e2: exec2, e3: exec3, e4: exec4 };

    // Add receipts for all
    state.executionReceipts = {
      e1: makeReceipt('e1', agent.id),
      e2: makeReceipt('e2', agent.id),
      e3: makeReceipt('e3', agent.id),
      e4: makeReceipt('e4', agent.id),
    };

    // Add trade intents
    state.tradeIntents = {
      i1: { id: 'i1', agentId: agent.id, symbol: 'SOL', side: 'sell', createdAt: '', updatedAt: '', status: 'executed' } as TradeIntent,
      i2: { id: 'i2', agentId: agent.id, symbol: 'SOL', side: 'sell', createdAt: '', updatedAt: '', status: 'executed' } as TradeIntent,
      i3: { id: 'i3', agentId: agent.id, symbol: 'SOL', side: 'sell', createdAt: '', updatedAt: '', status: 'executed' } as TradeIntent,
      i4: { id: 'i4', agentId: agent.id, symbol: 'SOL', side: 'sell', createdAt: '', updatedAt: '', status: 'executed' } as TradeIntent,
    };

    const service = new ReputationService(createMockStore(state));
    const result = service.calculate(agent.id);

    expect(result).not.toBeNull();
    expect(result!.agentId).toBe(agent.id);
    expect(result!.score).toBeGreaterThan(0);
    expect(result!.score).toBeLessThanOrEqual(1000);
    expect(result!.breakdown.tradeSuccessRate).toBe(750); // 3/4 = 0.75 * 1000
    expect(result!.breakdown.riskDiscipline).toBe(1000); // 0 rejections
    expect(result!.breakdown.receiptVerification).toBe(1000); // all receipts exist
  });

  it('penalizes risk rejections in the discipline score', () => {
    const state = createDefaultState();
    const agent = makeAgent({
      riskRejectionsByReason: { 'max_drawdown': 5 },
    });
    state.agents[agent.id] = agent;

    // 10 intents, 5 rejections → 50% rejection rate → discipline = 500
    for (let i = 0; i < 10; i++) {
      state.tradeIntents[`i${i}`] = {
        id: `i${i}`, agentId: agent.id, symbol: 'SOL', side: 'buy',
        createdAt: '', updatedAt: '', status: 'executed',
      } as TradeIntent;
    }

    const service = new ReputationService(createMockStore(state));
    const result = service.calculate(agent.id);

    expect(result).not.toBeNull();
    expect(result!.breakdown.riskDiscipline).toBe(500);
  });

  it('applies inactivity decay when agent has not traded recently', () => {
    const state = createDefaultState();
    const longAgo = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
    const agent = makeAgent({
      lastTradeAt: longAgo,
      createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    });
    state.agents[agent.id] = agent;

    const service = new ReputationService(createMockStore(state));
    const decayed = service.calculate(agent.id);

    // Also compute without decay for comparison
    const freshAgent = makeAgent({
      lastTradeAt: new Date().toISOString(),
      createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const freshState = createDefaultState();
    freshState.agents[freshAgent.id] = freshAgent;
    const freshService = new ReputationService(createMockStore(freshState));
    const fresh = freshService.calculate(freshAgent.id);

    expect(decayed).not.toBeNull();
    expect(fresh).not.toBeNull();
    expect(decayed!.score).toBeLessThan(fresh!.score);
  });

  it('produces a leaderboard sorted by score descending', () => {
    const state = createDefaultState();

    const agent1 = makeAgent({ id: 'a1', name: 'Alpha' });
    const agent2 = makeAgent({
      id: 'a2', name: 'Beta',
      riskRejectionsByReason: { 'max_drawdown': 100 },
    });

    state.agents[agent1.id] = agent1;
    state.agents[agent2.id] = agent2;

    // Give agent2 lots of intents to penalize discipline
    for (let i = 0; i < 100; i++) {
      state.tradeIntents[`i${i}`] = {
        id: `i${i}`, agentId: 'a2', symbol: 'SOL', side: 'buy',
        createdAt: '', updatedAt: '', status: 'rejected',
      } as TradeIntent;
    }

    const service = new ReputationService(createMockStore(state));
    const board = service.leaderboard();

    expect(board.entries.length).toBe(2);
    expect(board.entries[0].rank).toBe(1);
    expect(board.entries[1].rank).toBe(2);
    // Agent with 0 rejections should rank higher
    expect(board.entries[0].agentId).toBe('a1');
  });

  it('score stays within 0-1000 bounds', () => {
    const state = createDefaultState();
    const agent = makeAgent();
    state.agents[agent.id] = agent;

    const service = new ReputationService(createMockStore(state));
    const result = service.calculate(agent.id);

    expect(result).not.toBeNull();
    expect(result!.score).toBeGreaterThanOrEqual(0);
    expect(result!.score).toBeLessThanOrEqual(1000);
  });
});
