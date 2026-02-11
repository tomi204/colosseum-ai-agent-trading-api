import { describe, expect, it, vi } from 'vitest';
import { CreditRatingService } from '../src/services/creditRatingService.js';
import { AppState, Agent, ExecutionRecord, TradeIntent } from '../src/types.js';
import { createDefaultState } from '../src/infra/storage/defaultState.js';

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

describe('CreditRatingService', () => {
  it('returns null for unknown agent', () => {
    const state = createDefaultState();
    const service = new CreditRatingService(createMockStore(state));
    expect(service.calculateRating('nonexistent')).toBeNull();
  });

  it('computes a rating for an agent with no trades', () => {
    const state = createDefaultState();
    state.agents['agent-1'] = makeAgent('agent-1', 'Test Agent');
    const service = new CreditRatingService(createMockStore(state));

    const rating = service.calculateRating('agent-1');
    expect(rating).not.toBeNull();
    expect(rating!.agentId).toBe('agent-1');
    expect(rating!.score).toBeGreaterThanOrEqual(0);
    expect(rating!.score).toBeLessThanOrEqual(100);
    expect(rating!.grade).toBeDefined();
    expect(rating!.factors.length).toBe(5);
  });

  it('assigns high score to agent with all winning trades and no rejections', () => {
    const state = createDefaultState();
    const agent = makeAgent('agent-1', 'Winner Agent');
    state.agents['agent-1'] = agent;

    // Add 10 winning buy+sell pairs
    const executions: Record<string, ExecutionRecord> = {};
    const intents: Record<string, TradeIntent> = {};

    for (let i = 0; i < 10; i++) {
      const buyId = `buy-${i}`;
      const sellId = `sell-${i}`;
      const intentBuyId = `intent-buy-${i}`;
      const intentSellId = `intent-sell-${i}`;

      executions[buyId] = makeExecution({
        id: buyId,
        intentId: intentBuyId,
        side: 'buy',
        realizedPnlUsd: 0,
        createdAt: new Date(Date.now() - (20 - i * 2) * 60000).toISOString(),
      });
      executions[sellId] = makeExecution({
        id: sellId,
        intentId: intentSellId,
        side: 'sell',
        realizedPnlUsd: 50,
        createdAt: new Date(Date.now() - (19 - i * 2) * 60000).toISOString(),
      });

      intents[intentBuyId] = {
        id: intentBuyId, agentId: 'agent-1', symbol: 'SOL', side: 'buy',
        createdAt: '', updatedAt: '', status: 'executed',
      } as TradeIntent;
      intents[intentSellId] = {
        id: intentSellId, agentId: 'agent-1', symbol: 'SOL', side: 'sell',
        createdAt: '', updatedAt: '', status: 'executed',
      } as TradeIntent;
    }

    state.executions = executions;
    state.tradeIntents = intents;

    const service = new CreditRatingService(createMockStore(state));
    const rating = service.calculateRating('agent-1');

    expect(rating).not.toBeNull();
    // 100% win rate → 25 points, no drawdown → 25 points, good hold time → ~15, 0% rejection → 20
    // trade freq is low (20/150) → small
    expect(rating!.score).toBeGreaterThan(60);
    expect(rating!.factors.find((f) => f.name === 'winRate')!.normalizedScore).toBe(100);
  });

  it('penalizes high drawdown', () => {
    const state = createDefaultState();
    state.agents['agent-1'] = makeAgent('agent-1', 'Drawdown Agent');

    // Series of losing trades to create drawdown
    state.executions = {
      'e1': makeExecution({ id: 'e1', side: 'sell', realizedPnlUsd: -2000, createdAt: '2026-01-01T10:00:00Z' }),
      'e2': makeExecution({ id: 'e2', side: 'sell', realizedPnlUsd: -3000, createdAt: '2026-01-01T11:00:00Z' }),
    };

    const service = new CreditRatingService(createMockStore(state));
    const rating = service.calculateRating('agent-1');

    expect(rating).not.toBeNull();
    const drawdownFactor = rating!.factors.find((f) => f.name === 'maxDrawdown')!;
    // 5000 loss on 10000 capital = 50% drawdown → score ~50
    expect(drawdownFactor.normalizedScore).toBeLessThan(60);
  });

  it('penalizes high risk rejection rate', () => {
    const state = createDefaultState();
    state.agents['agent-1'] = makeAgent('agent-1', 'Risky Agent', {
      riskRejectionsByReason: { 'max_drawdown': 8, 'daily_loss_cap': 2 },
    });

    // 10 rejections out of 20 intents = 50% rejection rate
    for (let i = 0; i < 20; i++) {
      state.tradeIntents[`i${i}`] = {
        id: `i${i}`, agentId: 'agent-1', symbol: 'SOL', side: 'buy',
        createdAt: '', updatedAt: '', status: i < 10 ? 'executed' : 'rejected',
      } as TradeIntent;
    }

    const service = new CreditRatingService(createMockStore(state));
    const rating = service.calculateRating('agent-1');

    expect(rating).not.toBeNull();
    const rejectionFactor = rating!.factors.find((f) => f.name === 'riskRejectionRate')!;
    expect(rejectionFactor.normalizedScore).toBe(50); // 50% rejection → 50 score
  });

  it('assigns correct letter grades', () => {
    const state = createDefaultState();
    state.agents['agent-1'] = makeAgent('agent-1', 'Test');
    const service = new CreditRatingService(createMockStore(state));

    // Test via getRating to also test caching
    const rating = service.getRating('agent-1');
    expect(rating).not.toBeNull();
    expect(['A+', 'A', 'B', 'C', 'D', 'F']).toContain(rating!.grade);

    // Verify grade-score mapping
    if (rating!.score >= 90) expect(rating!.grade).toBe('A+');
    else if (rating!.score >= 80) expect(rating!.grade).toBe('A');
    else if (rating!.score >= 70) expect(rating!.grade).toBe('B');
    else if (rating!.score >= 60) expect(rating!.grade).toBe('C');
    else if (rating!.score >= 50) expect(rating!.grade).toBe('D');
    else expect(rating!.grade).toBe('F');
  });

  it('getRating returns cached value after calculateRating', () => {
    const state = createDefaultState();
    state.agents['agent-1'] = makeAgent('agent-1', 'Cached Agent');
    const service = new CreditRatingService(createMockStore(state));

    const fresh = service.calculateRating('agent-1');
    const cached = service.getRating('agent-1');

    expect(cached).not.toBeNull();
    expect(cached!.score).toBe(fresh!.score);
    expect(cached!.grade).toBe(fresh!.grade);
  });

  it('getRatingBreakdown returns factor details', () => {
    const state = createDefaultState();
    state.agents['agent-1'] = makeAgent('agent-1', 'Detail Agent');
    const service = new CreditRatingService(createMockStore(state));

    const breakdown = service.getRatingBreakdown('agent-1');
    expect(breakdown).not.toBeNull();
    expect(breakdown!.factors.length).toBe(5);

    const factorNames = breakdown!.factors.map((f) => f.name);
    expect(factorNames).toContain('winRate');
    expect(factorNames).toContain('maxDrawdown');
    expect(factorNames).toContain('tradeFrequency');
    expect(factorNames).toContain('avgHoldTime');
    expect(factorNames).toContain('riskRejectionRate');

    // Check weights sum to 1
    const totalWeight = breakdown!.factors.reduce((sum, f) => sum + f.weight, 0);
    expect(totalWeight).toBeCloseTo(1.0, 5);
  });

  it('getAllRatings returns leaderboard sorted by score', () => {
    const state = createDefaultState();
    state.agents['a1'] = makeAgent('a1', 'Alpha');
    state.agents['a2'] = makeAgent('a2', 'Beta', {
      riskRejectionsByReason: { 'max_drawdown': 50 },
    });

    // Give a2 lots of intents to penalize rejection score
    for (let i = 0; i < 50; i++) {
      state.tradeIntents[`i${i}`] = {
        id: `i${i}`, agentId: 'a2', symbol: 'SOL', side: 'buy',
        createdAt: '', updatedAt: '', status: 'rejected',
      } as TradeIntent;
    }

    const service = new CreditRatingService(createMockStore(state));
    const leaderboard = service.getAllRatings();

    expect(leaderboard.entries.length).toBe(2);
    expect(leaderboard.entries[0].rank).toBe(1);
    expect(leaderboard.entries[1].rank).toBe(2);
    // Agent with no rejections should rank higher
    expect(leaderboard.entries[0].agentId).toBe('a1');
    expect(leaderboard.entries[0].score).toBeGreaterThanOrEqual(leaderboard.entries[1].score);
  });

  it('score stays within 0-100 bounds', () => {
    const state = createDefaultState();
    state.agents['agent-1'] = makeAgent('agent-1', 'Bounded');
    const service = new CreditRatingService(createMockStore(state));

    const rating = service.calculateRating('agent-1');
    expect(rating).not.toBeNull();
    expect(rating!.score).toBeGreaterThanOrEqual(0);
    expect(rating!.score).toBeLessThanOrEqual(100);
  });

  it('getRating returns null for unknown agent', () => {
    const state = createDefaultState();
    const service = new CreditRatingService(createMockStore(state));
    expect(service.getRating('ghost')).toBeNull();
  });
});
