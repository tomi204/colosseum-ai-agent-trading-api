import { describe, expect, it, beforeEach, vi } from 'vitest';
import { CopyTradingService } from '../src/services/copyTradingService.js';
import { AppState, Agent, ExecutionRecord, TradeIntent } from '../src/types.js';
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

function makeExecution(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    id: 'exec-1',
    intentId: 'intent-1',
    agentId: 'leader',
    symbol: 'SOL',
    side: 'buy',
    quantity: 10,
    priceUsd: 100,
    grossNotionalUsd: 1000,
    feeUsd: 0.8,
    netUsd: 999.2,
    realizedPnlUsd: 0,
    pnlSnapshotUsd: 0,
    mode: 'paper',
    status: 'filled',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('CopyTradingService', () => {
  beforeEach(() => {
    eventBus.clear();
  });

  function setup() {
    const state = createDefaultState();
    state.agents['leader'] = makeAgent('leader', 'Leader Agent');
    state.agents['follower1'] = makeAgent('follower1', 'Follower 1');
    state.agents['follower2'] = makeAgent('follower2', 'Follower 2');
    const store = createMockStore(state);
    const service = new CopyTradingService(store);
    return { state, store, service };
  }

  it('creates a follow relation', () => {
    const { service } = setup();
    const relation = service.followAgent('follower1', 'leader', {
      copyRatio: 0.5,
      maxNotionalUsd: 500,
    });

    expect(relation.id).toBeDefined();
    expect(relation.followerId).toBe('follower1');
    expect(relation.targetId).toBe('leader');
    expect(relation.copyRatio).toBe(0.5);
    expect(relation.maxNotionalUsd).toBe(500);
    expect(relation.createdAt).toBeDefined();
  });

  it('lists followers of an agent', () => {
    const { service } = setup();
    service.followAgent('follower1', 'leader', { copyRatio: 0.5, maxNotionalUsd: 500 });
    service.followAgent('follower2', 'leader', { copyRatio: 0.8, maxNotionalUsd: 1000 });

    const followers = service.getFollowers('leader');
    expect(followers.length).toBe(2);
    expect(followers.map((f) => f.followerId).sort()).toEqual(['follower1', 'follower2']);
  });

  it('lists who an agent is following', () => {
    const { service } = setup();
    service.followAgent('follower1', 'leader', { copyRatio: 0.5, maxNotionalUsd: 500 });

    const following = service.getFollowing('follower1');
    expect(following.length).toBe(1);
    expect(following[0].targetId).toBe('leader');
  });

  it('unfollows an agent', () => {
    const { service } = setup();
    service.followAgent('follower1', 'leader', { copyRatio: 0.5, maxNotionalUsd: 500 });

    const result = service.unfollowAgent('follower1', 'leader');
    expect(result.unfollowed).toBe(true);

    expect(service.getFollowing('follower1').length).toBe(0);
    expect(service.getFollowers('leader').length).toBe(0);
  });

  it('throws when following non-existent agent', () => {
    const { service } = setup();
    expect(() =>
      service.followAgent('follower1', 'ghost', { copyRatio: 0.5, maxNotionalUsd: 500 }),
    ).toThrow("Target agent 'ghost' not found");
  });

  it('throws when follower agent does not exist', () => {
    const { service } = setup();
    expect(() =>
      service.followAgent('ghost', 'leader', { copyRatio: 0.5, maxNotionalUsd: 500 }),
    ).toThrow("Follower agent 'ghost' not found");
  });

  it('prevents an agent from following itself', () => {
    const { service } = setup();
    expect(() =>
      service.followAgent('leader', 'leader', { copyRatio: 0.5, maxNotionalUsd: 500 }),
    ).toThrow('cannot follow itself');
  });

  it('prevents duplicate follow relations', () => {
    const { service } = setup();
    service.followAgent('follower1', 'leader', { copyRatio: 0.5, maxNotionalUsd: 500 });
    expect(() =>
      service.followAgent('follower1', 'leader', { copyRatio: 0.8, maxNotionalUsd: 1000 }),
    ).toThrow('already following');
  });

  it('validates copyRatio range', () => {
    const { service } = setup();
    expect(() =>
      service.followAgent('follower1', 'leader', { copyRatio: 0.05, maxNotionalUsd: 500 }),
    ).toThrow('copyRatio must be between 0.1 and 1.0');

    expect(() =>
      service.followAgent('follower1', 'leader', { copyRatio: 1.5, maxNotionalUsd: 500 }),
    ).toThrow('copyRatio must be between 0.1 and 1.0');
  });

  it('validates maxNotionalUsd is positive', () => {
    const { service } = setup();
    expect(() =>
      service.followAgent('follower1', 'leader', { copyRatio: 0.5, maxNotionalUsd: 0 }),
    ).toThrow('maxNotionalUsd must be positive');
  });

  it('throws when unfollowing a non-existent relation', () => {
    const { service } = setup();
    expect(() => service.unfollowAgent('follower1', 'leader')).toThrow('Follow relation not found');
  });

  it('processes copy trades scaled by copyRatio', () => {
    const { state, store, service } = setup();

    // Setup follow relation
    service.followAgent('follower1', 'leader', { copyRatio: 0.5, maxNotionalUsd: 2000 });

    // Add an executed intent + execution
    state.tradeIntents['intent-1'] = {
      id: 'intent-1',
      agentId: 'leader',
      symbol: 'SOL',
      side: 'buy',
      notionalUsd: 1000,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'executed',
    } as TradeIntent;

    state.executions['exec-1'] = makeExecution({
      id: 'exec-1',
      intentId: 'intent-1',
      agentId: 'leader',
      grossNotionalUsd: 1000,
    });

    // Re-create store with updated state
    (store as any).snapshot = () => structuredClone(state);

    const results = service.processCopyTrades('intent-1');
    expect(results.length).toBe(1);
    expect(results[0].followerId).toBe('follower1');
    expect(results[0].targetId).toBe('leader');
    expect(results[0].notionalUsd).toBe(500); // 1000 * 0.5
    expect(results[0].symbol).toBe('SOL');
    expect(results[0].side).toBe('buy');
  });

  it('caps copy trades by maxNotionalUsd', () => {
    const { state, store, service } = setup();

    // Setup follow with low max notional
    service.followAgent('follower1', 'leader', { copyRatio: 1.0, maxNotionalUsd: 200 });

    state.tradeIntents['intent-1'] = {
      id: 'intent-1',
      agentId: 'leader',
      symbol: 'SOL',
      side: 'buy',
      notionalUsd: 1000,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'executed',
    } as TradeIntent;

    state.executions['exec-1'] = makeExecution({
      id: 'exec-1',
      intentId: 'intent-1',
      agentId: 'leader',
      grossNotionalUsd: 1000,
    });

    (store as any).snapshot = () => structuredClone(state);

    const results = service.processCopyTrades('intent-1');
    expect(results.length).toBe(1);
    expect(results[0].notionalUsd).toBe(200); // capped at maxNotionalUsd
  });

  it('emits copytrade.executed event', () => {
    const { state, store, service } = setup();
    const events: unknown[] = [];
    eventBus.on('copytrade.executed', (_event, data) => events.push(data));

    service.followAgent('follower1', 'leader', { copyRatio: 0.5, maxNotionalUsd: 2000 });

    state.tradeIntents['intent-1'] = {
      id: 'intent-1',
      agentId: 'leader',
      symbol: 'SOL',
      side: 'buy',
      notionalUsd: 1000,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'executed',
    } as TradeIntent;

    state.executions['exec-1'] = makeExecution({
      id: 'exec-1',
      intentId: 'intent-1',
      agentId: 'leader',
      grossNotionalUsd: 1000,
    });

    (store as any).snapshot = () => structuredClone(state);

    service.processCopyTrades('intent-1');
    expect(events.length).toBe(1);
    expect((events[0] as any).followerId).toBe('follower1');
    expect((events[0] as any).notionalUsd).toBe(500);
  });

  it('processes copy trades for multiple followers', () => {
    const { state, store, service } = setup();

    service.followAgent('follower1', 'leader', { copyRatio: 0.5, maxNotionalUsd: 2000 });
    service.followAgent('follower2', 'leader', { copyRatio: 0.3, maxNotionalUsd: 2000 });

    state.tradeIntents['intent-1'] = {
      id: 'intent-1',
      agentId: 'leader',
      symbol: 'SOL',
      side: 'buy',
      notionalUsd: 1000,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'executed',
    } as TradeIntent;

    state.executions['exec-1'] = makeExecution({
      id: 'exec-1',
      intentId: 'intent-1',
      agentId: 'leader',
      grossNotionalUsd: 1000,
    });

    (store as any).snapshot = () => structuredClone(state);

    const results = service.processCopyTrades('intent-1');
    expect(results.length).toBe(2);

    const f1 = results.find((r) => r.followerId === 'follower1');
    const f2 = results.find((r) => r.followerId === 'follower2');
    expect(f1!.notionalUsd).toBe(500);  // 1000 * 0.5
    expect(f2!.notionalUsd).toBe(300);  // 1000 * 0.3
  });

  it('returns empty array for unknown intent in processCopyTrades', () => {
    const { service } = setup();
    const results = service.processCopyTrades('nonexistent');
    expect(results).toEqual([]);
  });

  it('returns empty followers/following for agents with no relations', () => {
    const { service } = setup();
    expect(service.getFollowers('leader')).toEqual([]);
    expect(service.getFollowing('follower1')).toEqual([]);
  });
});
