import { describe, expect, it, vi } from 'vitest';
import { MarketplaceService } from '../src/services/marketplaceService.js';
import { AppState, Agent } from '../src/types.js';
import { createDefaultState } from '../src/infra/storage/defaultState.js';

function createMockStore(state: AppState) {
  return {
    snapshot: () => structuredClone(state),
    transaction: vi.fn(),
    init: vi.fn(),
    flush: vi.fn(),
  } as any;
}

function makeAgent(id: string, name: string): Agent {
  return {
    id,
    name,
    apiKey: `key-${id}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    startingCapitalUsd: 10_000,
    cashUsd: 10_000,
    realizedPnlUsd: 0,
    peakEquityUsd: 10_000,
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
  };
}

const defaultPerformanceStats = {
  totalReturnPct: 12.5,
  maxDrawdownPct: 3.2,
  sharpeRatio: 1.8,
  tradeCount: 45,
  winRate: 62,
};

describe('MarketplaceService', () => {
  function setup(agentCount = 3) {
    const state = createDefaultState();
    for (let i = 1; i <= agentCount; i++) {
      state.agents[`agent-${i}`] = makeAgent(`agent-${i}`, `Agent ${i}`);
    }
    const store = createMockStore(state);
    const service = new MarketplaceService(store);
    return { state, store, service };
  }

  it('creates a listing for a registered agent', () => {
    const { service } = setup();
    const listing = service.createListing({
      agentId: 'agent-1',
      strategyId: 'momentum-v1',
      description: 'My awesome momentum strategy',
      performanceStats: defaultPerformanceStats,
      fee: 5,
    });

    expect(listing.id).toBeDefined();
    expect(listing.agentId).toBe('agent-1');
    expect(listing.strategyId).toBe('momentum-v1');
    expect(listing.description).toBe('My awesome momentum strategy');
    expect(listing.fee).toBe(5);
    expect(listing.subscribers).toEqual([]);
    expect(listing.reputationScore).toBeTypeOf('number');
    expect(listing.createdAt).toBeDefined();
  });

  it('rejects listing from unknown agent', () => {
    const { service } = setup();
    expect(() =>
      service.createListing({
        agentId: 'ghost',
        strategyId: 'momentum-v1',
        description: 'Ghost strategy',
        performanceStats: defaultPerformanceStats,
        fee: 5,
      }),
    ).toThrow('Agent not found');
  });

  it('allows subscription and prevents duplicates', () => {
    const { service } = setup();
    const listing = service.createListing({
      agentId: 'agent-1',
      strategyId: 'momentum-v1',
      description: 'My strategy',
      performanceStats: defaultPerformanceStats,
      fee: 5,
    });

    // Agent-2 subscribes
    const sub = service.subscribe(listing.id, 'agent-2');
    expect(sub.subscriberId).toBe('agent-2');
    expect(sub.listingId).toBe(listing.id);
    expect(sub.subscribedAt).toBeDefined();

    // Check listing is updated
    const updated = service.getById(listing.id);
    expect(updated?.subscribers).toContain('agent-2');

    // Duplicate subscription should throw
    expect(() => service.subscribe(listing.id, 'agent-2')).toThrow('already subscribed');
  });

  it('prevents self-subscription', () => {
    const { service } = setup();
    const listing = service.createListing({
      agentId: 'agent-1',
      strategyId: 'momentum-v1',
      description: 'My strategy',
      performanceStats: defaultPerformanceStats,
      fee: 5,
    });

    expect(() => service.subscribe(listing.id, 'agent-1')).toThrow('Cannot subscribe to your own listing');
  });

  it('lists all listings sorted by reputation', () => {
    const { service } = setup();

    service.createListing({
      agentId: 'agent-1',
      strategyId: 'momentum-v1',
      description: 'Strategy A',
      performanceStats: defaultPerformanceStats,
      fee: 5,
    });

    service.createListing({
      agentId: 'agent-2',
      strategyId: 'mean-reversion-v1',
      description: 'Strategy B',
      performanceStats: { ...defaultPerformanceStats, totalReturnPct: 20 },
      fee: 10,
    });

    const all = service.listAll();
    expect(all.length).toBe(2);
    // Both agents have default 50 reputation (no executions), so order is stable
    expect(all[0].reputationScore).toBeGreaterThanOrEqual(all[1].reputationScore);
  });

  it('returns listing with stats including subscription count', () => {
    const { service } = setup();
    const listing = service.createListing({
      agentId: 'agent-1',
      strategyId: 'momentum-v1',
      description: 'My strategy',
      performanceStats: defaultPerformanceStats,
      fee: 5,
    });

    service.subscribe(listing.id, 'agent-2');
    service.subscribe(listing.id, 'agent-3');

    const withStats = service.getListingWithStats(listing.id);
    expect(withStats).toBeDefined();
    expect(withStats!.subscriptionCount).toBe(2);
    expect(withStats!.subscribers).toHaveLength(2);
  });

  it('returns undefined for non-existent listing', () => {
    const { service } = setup();
    expect(service.getById('nonexistent')).toBeUndefined();
    expect(service.getListingWithStats('nonexistent')).toBeUndefined();
  });

  it('throws when subscribing to non-existent listing', () => {
    const { service } = setup();
    expect(() => service.subscribe('nonexistent', 'agent-1')).toThrow('Listing not found');
  });
});
