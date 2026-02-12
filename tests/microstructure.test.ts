import { describe, expect, it, beforeEach } from 'vitest';
import {
  MicrostructureService,
  Trade,
  SpreadSnapshot,
} from '../src/services/microstructureService.js';
import { AppState } from '../src/types.js';
import { createDefaultState } from '../src/infra/storage/defaultState.js';
import { vi } from 'vitest';

function createMockStore(state: AppState) {
  return {
    snapshot: () => structuredClone(state),
    transaction: vi.fn(),
    init: vi.fn(),
    flush: vi.fn(),
  } as any;
}

describe('MicrostructureService', () => {
  let service: MicrostructureService;
  let state: AppState;

  beforeEach(() => {
    state = createDefaultState();
    state.marketPricesUsd['SOL'] = 100;
    state.marketPricesUsd['BONK'] = 0.002;
    state.marketPricesUsd['JUP'] = 5;
    const store = createMockStore(state);
    service = new MicrostructureService(store);
  });

  // ─── Trade Recording ────────────────────────────────────────────────

  it('records trades and assigns ids', () => {
    const trade = service.recordTrade({
      symbol: 'SOL',
      side: 'buy',
      price: 100,
      quantity: 10,
      timestamp: new Date().toISOString(),
    });
    expect(trade.id).toBeDefined();
    expect(trade.symbol).toBe('SOL');
    expect(trade.side).toBe('buy');
    expect(trade.price).toBe(100);
    expect(trade.quantity).toBe(10);
  });

  it('normalises symbol to uppercase on trade recording', () => {
    const trade = service.recordTrade({
      symbol: 'sol',
      side: 'sell',
      price: 99,
      quantity: 5,
      timestamp: new Date().toISOString(),
    });
    expect(trade.symbol).toBe('SOL');
  });

  // ─── Order Flow Imbalance ───────────────────────────────────────────

  it('computes order flow imbalance from seeded data', () => {
    const flow = service.getFlowImbalance('SOL');
    expect(flow.symbol).toBe('SOL');
    expect(flow.totalVolume).toBeGreaterThan(0);
    expect(flow.buyVolume).toBeGreaterThanOrEqual(0);
    expect(flow.sellVolume).toBeGreaterThanOrEqual(0);
    expect(flow.imbalanceRatio).toBeGreaterThanOrEqual(-1);
    expect(flow.imbalanceRatio).toBeLessThanOrEqual(1);
    expect(['strong_buy', 'moderate_buy', 'neutral', 'moderate_sell', 'strong_sell']).toContain(flow.pressure);
    expect(flow.timestamp).toBeDefined();
  });

  it('returns neutral flow for a symbol with no trades', () => {
    const flow = service.getFlowImbalance('UNKNOWN_TOKEN');
    expect(flow.symbol).toBe('UNKNOWN_TOKEN');
    expect(flow.totalVolume).toBe(0);
    expect(flow.imbalanceRatio).toBe(0);
    expect(flow.dominantSide).toBe('neutral');
    expect(flow.pressure).toBe('neutral');
  });

  it('detects buy-heavy imbalance when all trades are buys', () => {
    // Create a fresh service with no seed data
    const freshStore = createMockStore(state);
    const freshService = new MicrostructureService(freshStore);

    // Add only buy trades to a new symbol
    const now = Date.now();
    for (let i = 0; i < 20; i++) {
      freshService.recordTrade({
        symbol: 'TESTBUY',
        side: 'buy',
        price: 50,
        quantity: 10,
        timestamp: new Date(now - i * 1000).toISOString(),
      });
    }

    const flow = freshService.getFlowImbalance('TESTBUY');
    expect(flow.imbalanceRatio).toBe(1);
    expect(flow.dominantSide).toBe('buy');
    expect(flow.pressure).toBe('strong_buy');
    expect(flow.buyCount).toBe(20);
    expect(flow.sellCount).toBe(0);
  });

  it('respects custom window size for flow analysis', () => {
    const freshStore = createMockStore(state);
    const freshService = new MicrostructureService(freshStore);

    const now = Date.now();
    // Old trade (outside window)
    freshService.recordTrade({
      symbol: 'WINTEST',
      side: 'sell',
      price: 10,
      quantity: 100,
      timestamp: new Date(now - 120_000).toISOString(), // 2 min ago
    });
    // Recent trade (inside window)
    freshService.recordTrade({
      symbol: 'WINTEST',
      side: 'buy',
      price: 10,
      quantity: 50,
      timestamp: new Date(now - 5_000).toISOString(), // 5 sec ago
    });

    // 60-second window should only include the buy
    const flow = freshService.getFlowImbalance('WINTEST', 60_000);
    expect(flow.buyCount).toBe(1);
    expect(flow.sellCount).toBe(0);
    expect(flow.imbalanceRatio).toBe(1);
  });

  // ─── Trade Flow Toxicity ────────────────────────────────────────────

  it('computes toxicity score with valid metrics', () => {
    const tox = service.getToxicityScore('SOL');
    expect(tox.symbol).toBe('SOL');
    expect(tox.vpin).toBeGreaterThanOrEqual(0);
    expect(tox.vpin).toBeLessThanOrEqual(1);
    expect(tox.overallScore).toBeGreaterThanOrEqual(0);
    expect(tox.overallScore).toBeLessThanOrEqual(100);
    expect(['low', 'moderate', 'high', 'extreme']).toContain(tox.level);
    expect(tox.tradeCount).toBeGreaterThan(0);
    expect(tox.timestamp).toBeDefined();
  });

  it('returns low toxicity for a symbol with no trades', () => {
    const tox = service.getToxicityScore('NONEXIST');
    expect(tox.overallScore).toBe(0);
    expect(tox.level).toBe('low');
    expect(tox.tradeCount).toBe(0);
    expect(tox.vpin).toBe(0);
    expect(tox.kyleLambda).toBe(0);
  });

  // ─── Bid-Ask Spread Analysis ────────────────────────────────────────

  it('computes spread analysis from seeded data', () => {
    const spread = service.getSpreadAnalysis('SOL');
    expect(spread.symbol).toBe('SOL');
    expect(spread.current.bid).toBeGreaterThan(0);
    expect(spread.current.ask).toBeGreaterThan(spread.current.bid);
    expect(spread.current.spreadBps).toBeGreaterThan(0);
    expect(spread.avgSpreadBps).toBeGreaterThan(0);
    expect(spread.minSpreadBps).toBeLessThanOrEqual(spread.maxSpreadBps);
    expect(spread.snapshots.length).toBeGreaterThan(0);
    expect(spread.timestamp).toBeDefined();
  });

  it('records new spread snapshots and includes them in analysis', () => {
    // Record a known spread
    service.recordSpread('NEWTOKEN', 10.0, 10.1);
    service.recordSpread('NEWTOKEN', 10.0, 10.2);

    const analysis = service.getSpreadAnalysis('NEWTOKEN');
    expect(analysis.snapshots.length).toBe(2);
    expect(analysis.current.bid).toBe(10.0);
    expect(analysis.current.ask).toBe(10.2);
    expect(analysis.avgSpreadBps).toBeGreaterThan(0);
  });

  it('detects spread widening trend', () => {
    const freshStore = createMockStore(state);
    const freshService = new MicrostructureService(freshStore);

    // Narrow spreads first
    for (let i = 0; i < 10; i++) {
      freshService.recordSpread('WIDEN', 100, 100.05);
    }
    // Then wider spreads
    for (let i = 0; i < 10; i++) {
      freshService.recordSpread('WIDEN', 100, 101);
    }

    const analysis = freshService.getSpreadAnalysis('WIDEN');
    expect(analysis.wideningTrend).toBe(true);
  });

  // ─── Volume Profile ─────────────────────────────────────────────────

  it('builds a volume profile with POC and value area', () => {
    const profile = service.getVolumeProfile('SOL');
    expect(profile.symbol).toBe('SOL');
    expect(profile.levels.length).toBeGreaterThan(0);
    expect(profile.pocPrice).toBeGreaterThan(0);
    expect(profile.pocVolume).toBeGreaterThan(0);
    expect(profile.valueAreaHigh).toBeGreaterThanOrEqual(profile.valueAreaLow);
    expect(profile.totalVolume).toBeGreaterThan(0);
    expect(profile.timestamp).toBeDefined();

    // Level percentages should sum to ~100%
    const totalPct = profile.levels.reduce((s, l) => s + l.pctOfTotal, 0);
    expect(totalPct).toBeCloseTo(100, 0);
  });

  it('returns empty volume profile for unknown symbol', () => {
    const profile = service.getVolumeProfile('NOTHING');
    expect(profile.levels.length).toBe(0);
    expect(profile.totalVolume).toBe(0);
    expect(profile.pocPrice).toBe(0);
  });

  it('each level tracks buy vs sell volume', () => {
    const profile = service.getVolumeProfile('SOL');
    for (const level of profile.levels) {
      // buy + sell should equal (approximately) total volume at that level
      const sumSides = level.buyVolume + level.sellVolume;
      expect(sumSides).toBeCloseTo(level.volume, 0);
    }
  });

  // ─── Market Depth Delta ─────────────────────────────────────────────

  it('computes depth delta between snapshots', () => {
    const delta = service.getDepthDelta('SOL');
    expect(delta.symbol).toBe('SOL');
    expect(delta.snapshotCount).toBeGreaterThanOrEqual(2);
    // We seeded with mult 1 → mult 1.2 for bids, mult 1 → 0.9 for asks
    // So bidDelta > 0, askDelta < 0
    expect(delta.bidDelta).toBeGreaterThan(0);
    expect(delta.askDelta).toBeLessThan(0);
    expect(delta.netDelta).toBeGreaterThan(0);
    expect(delta.timestamp).toBeDefined();
  });

  it('returns zero delta when fewer than two snapshots', () => {
    const delta = service.getDepthDelta('NO_DEPTH');
    expect(delta.snapshotCount).toBe(0);
    expect(delta.bidDelta).toBe(0);
    expect(delta.askDelta).toBe(0);
    expect(delta.netDelta).toBe(0);
  });

  it('detects significant level changes in depth', () => {
    const freshStore = createMockStore(state);
    const freshService = new MicrostructureService(freshStore);

    freshService.recordDepth({
      symbol: 'DTEST',
      bids: [{ price: 100, quantity: 100, total: 100 }],
      asks: [{ price: 101, quantity: 100, total: 100 }],
      timestamp: new Date().toISOString(),
    });
    freshService.recordDepth({
      symbol: 'DTEST',
      bids: [{ price: 100, quantity: 200, total: 200 }], // +100%
      asks: [{ price: 101, quantity: 50, total: 50 }],   // -50%
      timestamp: new Date().toISOString(),
    });

    const delta = freshService.getDepthDelta('DTEST');
    expect(delta.significantChanges.length).toBeGreaterThanOrEqual(2);
    const bidChange = delta.significantChanges.find((c) => c.side === 'bid');
    expect(bidChange).toBeDefined();
    expect(bidChange!.changePercent).toBe(100);
    const askChange = delta.significantChanges.find((c) => c.side === 'ask');
    expect(askChange).toBeDefined();
    expect(askChange!.changePercent).toBe(-50);
  });

  // ─── Whale Detection ────────────────────────────────────────────────

  it('detects whale activity from seeded data', () => {
    const whales = service.getWhaleActivity('SOL');
    expect(whales.symbol).toBe('SOL');
    expect(whales.whaleCount).toBeGreaterThan(0);
    expect(whales.totalWhaleVolume).toBeGreaterThan(0);
    expect(whales.largestOrder).not.toBeNull();
    expect(whales.largestOrder!.notionalUsd).toBeGreaterThan(0);
    expect(['none', 'notable', 'significant', 'extreme']).toContain(whales.alertLevel);
    expect(whales.timestamp).toBeDefined();
  });

  it('returns empty whale data for a quiet symbol', () => {
    const freshStore = createMockStore(state);
    const freshService = new MicrostructureService(freshStore);

    // Only small trades
    const now = Date.now();
    for (let i = 0; i < 10; i++) {
      freshService.recordTrade({
        symbol: 'QUIET',
        side: 'buy',
        price: 1,
        quantity: 1,
        timestamp: new Date(now - i * 1000).toISOString(),
      });
    }

    const whales = freshService.getWhaleActivity('QUIET');
    expect(whales.whaleCount).toBe(0);
    expect(whales.alertLevel).toBe('none');
    expect(whales.largestOrder).toBeNull();
  });

  it('auto-detects a whale when a large trade is recorded', () => {
    const freshStore = createMockStore(state);
    const freshService = new MicrostructureService(freshStore);

    const now = Date.now();
    // Small trades first to establish baseline
    for (let i = 0; i < 10; i++) {
      freshService.recordTrade({
        symbol: 'WTEST',
        side: 'buy',
        price: 10,
        quantity: 1,
        timestamp: new Date(now - (20 - i) * 1000).toISOString(),
      });
    }

    // Then one massive trade (50× the average)
    freshService.recordTrade({
      symbol: 'WTEST',
      side: 'sell',
      price: 10,
      quantity: 500,
      timestamp: new Date(now).toISOString(),
    });

    const whales = freshService.getWhaleActivity('WTEST');
    expect(whales.whaleCount).toBeGreaterThanOrEqual(1);
    expect(whales.largestOrder).not.toBeNull();
    expect(whales.largestOrder!.side).toBe('sell');
    expect(whales.largestOrder!.notionalUsd).toBeGreaterThanOrEqual(4000);
  });

  // ─── Cross-feature Integration ──────────────────────────────────────

  it('all analysis methods work for the same symbol consistently', () => {
    const symbol = 'SOL';
    const flow = service.getFlowImbalance(symbol);
    const tox = service.getToxicityScore(symbol);
    const spread = service.getSpreadAnalysis(symbol);
    const profile = service.getVolumeProfile(symbol);
    const delta = service.getDepthDelta(symbol);
    const whales = service.getWhaleActivity(symbol);

    // All return the same normalised symbol
    expect(flow.symbol).toBe('SOL');
    expect(tox.symbol).toBe('SOL');
    expect(spread.symbol).toBe('SOL');
    expect(profile.symbol).toBe('SOL');
    expect(delta.symbol).toBe('SOL');
    expect(whales.symbol).toBe('SOL');

    // All have timestamps
    expect(flow.timestamp).toBeDefined();
    expect(tox.timestamp).toBeDefined();
    expect(spread.timestamp).toBeDefined();
    expect(profile.timestamp).toBeDefined();
    expect(delta.timestamp).toBeDefined();
    expect(whales.timestamp).toBeDefined();
  });
});
