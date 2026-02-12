import { describe, expect, it, vi } from 'vitest';
import { MarketMakingService } from '../src/services/marketMakingService.js';
import { AppState } from '../src/types.js';
import { createDefaultState } from '../src/infra/storage/defaultState.js';

function createMockStore(state?: Partial<AppState>) {
  const base = createDefaultState();
  const merged = { ...base, ...state };
  return {
    snapshot: () => structuredClone(merged),
    transaction: vi.fn(),
    init: vi.fn(),
    flush: vi.fn(),
  } as any;
}

function makeService(solPrice = 100): MarketMakingService {
  const state = createDefaultState();
  state.marketPricesUsd['SOL'] = solPrice;
  return new MarketMakingService(createMockStore(state));
}

function startWithPrice(svc: MarketMakingService, pair = 'SOL/USDC', price = 100, agentId = 'agent-1') {
  svc.feedPrice(pair, price);
  return svc.startSession({ agentId, pair });
}

// ─── Session Management ──────────────────────────────────────────────

describe('MarketMakingService — Session Management', () => {
  it('starts a new market making session', () => {
    const svc = makeService();
    const session = startWithPrice(svc);

    expect(session.id).toBeDefined();
    expect(session.agentId).toBe('agent-1');
    expect(session.pair).toBe('SOL/USDC');
    expect(session.status).toBe('active');
    expect(session.config.baseSpreadBps).toBe(30);
    expect(session.config.depth).toBe(5);
    expect(session.createdAt).toBeDefined();
  });

  it('prevents duplicate active sessions for same agent and pair', () => {
    const svc = makeService();
    startWithPrice(svc);

    expect(() => {
      svc.startSession({ agentId: 'agent-1', pair: 'SOL/USDC' });
    }).toThrow('already has an active session');
  });

  it('stops a session and clears quotes', () => {
    const svc = makeService();
    const session = startWithPrice(svc);
    const stopped = svc.stopSession(session.id);

    expect(stopped.status).toBe('stopped');
    expect(stopped.quotes.bids).toHaveLength(0);
    expect(stopped.quotes.asks).toHaveLength(0);
  });

  it('lists active sessions filtered by agentId', () => {
    const svc = makeService();
    svc.feedPrice('SOL/USDC', 100);
    svc.feedPrice('BTC/USDC', 50000);
    svc.startSession({ agentId: 'agent-1', pair: 'SOL/USDC' });
    svc.startSession({ agentId: 'agent-2', pair: 'BTC/USDC' });

    const all = svc.getActiveSessions();
    expect(all).toHaveLength(2);

    const agent1 = svc.getActiveSessions('agent-1');
    expect(agent1).toHaveLength(1);
    expect(agent1[0].agentId).toBe('agent-1');
  });
});

// ─── Spread Calculation ──────────────────────────────────────────────

describe('MarketMakingService — Spread Calculation', () => {
  it('calculates base spread correctly', () => {
    const svc = makeService();
    const session = startWithPrice(svc);
    const spread = svc.calculateSpread(session.id);

    expect(spread.baseSpreadBps).toBe(30);
    expect(spread.midPrice).toBe(100);
    expect(spread.bidPrice).toBeLessThan(100);
    expect(spread.askPrice).toBeGreaterThan(100);
    // Bid and ask should be roughly symmetric around mid
    expect(spread.finalBidSpreadBps).toBeGreaterThan(0);
    expect(spread.finalAskSpreadBps).toBeGreaterThan(0);
  });

  it('widens spread with higher volatility', () => {
    const svc = makeService();
    const session = startWithPrice(svc, 'SOL/USDC', 100);

    const calmSpread = svc.calculateSpread(session.id);

    // Feed volatile prices
    for (let i = 0; i < 20; i++) {
      svc.feedPrice('SOL/USDC', 100 + (i % 2 === 0 ? 5 : -5));
    }

    const volatileSpread = svc.calculateSpread(session.id);
    expect(volatileSpread.volatilityComponentBps).toBeGreaterThan(calmSpread.volatilityComponentBps);
  });

  it('skews spread based on inventory', () => {
    const svc = makeService();
    const session = startWithPrice(svc, 'SOL/USDC', 100);

    // Record buys to build positive inventory
    svc.recordFill({ sessionId: session.id, side: 'buy', price: 100, quantity: 500, feeType: 'maker' });

    const spread = svc.calculateSpread(session.id);
    // With positive inventory, bid should widen (discourage more buying)
    // and ask should narrow (encourage selling)
    expect(spread.inventorySkewBps).toBeGreaterThan(0);
    expect(spread.finalBidSpreadBps).toBeGreaterThan(spread.finalAskSpreadBps);
  });
});

// ─── Quote Generation ────────────────────────────────────────────────

describe('MarketMakingService — Quote Generation', () => {
  it('generates quotes with configured depth', () => {
    const svc = makeService();
    const session = startWithPrice(svc, 'SOL/USDC', 100);
    const quotes = svc.refreshQuotes(session.id);

    expect(quotes.pair).toBe('SOL/USDC');
    expect(quotes.midPrice).toBe(100);
    expect(quotes.bids).toHaveLength(5);
    expect(quotes.asks).toHaveLength(5);
    expect(quotes.spreadBps).toBeGreaterThan(0);
    expect(quotes.timestamp).toBeDefined();
  });

  it('bids are descending and asks are ascending in price', () => {
    const svc = makeService();
    const session = startWithPrice(svc, 'SOL/USDC', 100);
    const quotes = svc.refreshQuotes(session.id);

    for (let i = 1; i < quotes.bids.length; i++) {
      expect(quotes.bids[i].price).toBeLessThan(quotes.bids[i - 1].price);
    }
    for (let i = 1; i < quotes.asks.length; i++) {
      expect(quotes.asks[i].price).toBeGreaterThan(quotes.asks[i - 1].price);
    }
  });

  it('getQuotesForPair returns quotes across sessions', () => {
    const svc = makeService();
    svc.feedPrice('SOL/USDC', 100);
    svc.startSession({ agentId: 'agent-1', pair: 'SOL/USDC' });
    svc.startSession({ agentId: 'agent-2', pair: 'SOL/USDC' });

    const quotes = svc.getQuotesForPair('SOL/USDC');
    expect(quotes).toHaveLength(2);
  });

  it('price feed triggers automatic quote refresh', () => {
    const svc = makeService();
    const session = startWithPrice(svc, 'SOL/USDC', 100);

    svc.feedPrice('SOL/USDC', 105);

    const updated = svc.getSession(session.id)!;
    expect(updated.quotes.midPrice).toBe(105);
    expect(updated.quoteRefreshCount).toBeGreaterThan(0);
  });
});

// ─── Inventory Management ────────────────────────────────────────────

describe('MarketMakingService — Inventory Management', () => {
  it('tracks inventory after buy fill', () => {
    const svc = makeService();
    const session = startWithPrice(svc, 'SOL/USDC', 100);

    const trade = svc.recordFill({
      sessionId: session.id,
      side: 'buy',
      price: 99.5,
      quantity: 10,
      feeType: 'maker',
    });

    expect(trade.side).toBe('buy');
    expect(trade.notionalUsd).toBeCloseTo(995, 0);

    const updated = svc.getSession(session.id)!;
    expect(updated.inventory.baseBalance).toBe(10);
    expect(updated.inventory.inventoryRatio).toBeGreaterThan(0);
  });

  it('rebalances inventory when skewed', () => {
    const svc = makeService();
    const session = startWithPrice(svc, 'SOL/USDC', 100);

    // Build large inventory
    svc.recordFill({ sessionId: session.id, side: 'buy', price: 100, quantity: 600, feeType: 'maker' });

    const result = svc.rebalanceInventory(session.id);
    expect(result.rebalanced).toBe(true);
    expect(result.trade).toBeDefined();
    expect(result.trade!.side).toBe('sell');

    const updated = svc.getSession(session.id)!;
    expect(Math.abs(updated.inventory.baseBalance)).toBeLessThan(600);
    expect(updated.inventory.rebalanceCount).toBe(1);
  });

  it('skips rebalance when inventory is within range', () => {
    const svc = makeService();
    const session = startWithPrice(svc, 'SOL/USDC', 100);

    // Small inventory
    svc.recordFill({ sessionId: session.id, side: 'buy', price: 100, quantity: 10, feeType: 'maker' });

    const result = svc.rebalanceInventory(session.id);
    expect(result.rebalanced).toBe(false);
    expect(result.reason).toContain('acceptable range');
  });
});

// ─── PnL Tracking ────────────────────────────────────────────────────

describe('MarketMakingService — PnL Tracking', () => {
  it('tracks PnL across fills', () => {
    const svc = makeService();
    const session = startWithPrice(svc, 'SOL/USDC', 100);

    svc.recordFill({ sessionId: session.id, side: 'buy', price: 99, quantity: 10, feeType: 'maker' });
    svc.recordFill({ sessionId: session.id, side: 'sell', price: 101, quantity: 10, feeType: 'maker' });

    const updated = svc.getSession(session.id)!;
    expect(updated.pnl.tradeCount).toBe(2);
    expect(updated.pnl.makerTradeCount).toBe(2);
    expect(updated.pnl.realizedPnlUsd).toBeDefined();
    expect(updated.pnl.avgSpreadCapturedBps).toBeGreaterThan(0);
  });

  it('aggregates PnL across agent sessions', () => {
    const svc = makeService();
    svc.feedPrice('SOL/USDC', 100);
    svc.feedPrice('BTC/USDC', 50000);
    const s1 = svc.startSession({ agentId: 'agent-1', pair: 'SOL/USDC' });
    const s2 = svc.startSession({ agentId: 'agent-1', pair: 'BTC/USDC' });

    svc.recordFill({ sessionId: s1.id, side: 'buy', price: 99, quantity: 5, feeType: 'maker' });
    svc.recordFill({ sessionId: s2.id, side: 'sell', price: 50100, quantity: 0.01, feeType: 'taker' });

    const pnl = svc.getAgentPnl('agent-1');
    expect(pnl.agentId).toBe('agent-1');
    expect(pnl.sessions).toHaveLength(2);
    expect(pnl.aggregated.totalTrades).toBe(2);
    expect(pnl.aggregated.totalMakerTrades).toBe(1);
    expect(pnl.aggregated.totalTakerTrades).toBe(1);
    expect(pnl.aggregated.makerRatio).toBe(0.5);
  });
});

// ─── Risk Limits ─────────────────────────────────────────────────────

describe('MarketMakingService — Risk Limits', () => {
  it('halts session when max inventory is breached', () => {
    const svc = makeService();
    const session = startWithPrice(svc, 'SOL/USDC', 100);

    // Max inventory is 1000 by default; breach it
    svc.recordFill({ sessionId: session.id, side: 'buy', price: 100, quantity: 1100, feeType: 'maker' });

    const updated = svc.getSession(session.id)!;
    expect(updated.status).toBe('halted');
    expect(updated.haltReason).toContain('Max inventory breached');
  });

  it('halts session when max loss is breached', () => {
    const svc = makeService();
    const session = svc.startSession({
      agentId: 'agent-1',
      pair: 'SOL/USDC',
      config: { maxLossUsd: -10 },
    });
    svc.feedPrice('SOL/USDC', 100);

    // Execute a trade that generates a large loss
    // Buy high, price drops
    svc.recordFill({ sessionId: session.id, side: 'buy', price: 100, quantity: 50, feeType: 'taker' });
    // Feed lower price
    svc.feedPrice('SOL/USDC', 90);
    // Sell low
    svc.recordFill({ sessionId: session.id, side: 'sell', price: 90, quantity: 50, feeType: 'taker' });

    const updated = svc.getSession(session.id)!;
    expect(updated.status).toBe('halted');
    expect(updated.haltReason).toContain('Max loss breached');
  });
});

// ─── Configuration ───────────────────────────────────────────────────

describe('MarketMakingService — Configuration', () => {
  it('updates config and refreshes quotes', () => {
    const svc = makeService();
    const session = startWithPrice(svc, 'SOL/USDC', 100);

    const updated = svc.updateConfig(session.id, { baseSpreadBps: 50, depth: 3 });
    expect(updated.config.baseSpreadBps).toBe(50);
    expect(updated.config.depth).toBe(3);
    expect(updated.quotes.bids).toHaveLength(3);
    expect(updated.quotes.asks).toHaveLength(3);
  });

  it('returns default config', () => {
    const svc = makeService();
    const config = svc.getDefaultConfig();

    expect(config.baseSpreadBps).toBe(30);
    expect(config.depth).toBe(5);
    expect(config.makerFeeRate).toBe(0.0002);
    expect(config.takerFeeRate).toBe(0.0005);
    expect(config.maxInventory).toBe(1000);
    expect(config.maxLossUsd).toBe(-500);
  });
});

// ─── Fee Optimization ────────────────────────────────────────────────

describe('MarketMakingService — Fee Optimization', () => {
  it('computes fee optimization stats', () => {
    const svc = makeService();
    const session = startWithPrice(svc, 'SOL/USDC', 100);

    svc.recordFill({ sessionId: session.id, side: 'buy', price: 99, quantity: 5, feeType: 'maker' });
    svc.recordFill({ sessionId: session.id, side: 'sell', price: 101, quantity: 5, feeType: 'maker' });
    svc.recordFill({ sessionId: session.id, side: 'buy', price: 100, quantity: 3, feeType: 'taker' });

    const opt = svc.getFeeOptimization(session.id);
    expect(opt.sessionId).toBe(session.id);
    expect(opt.makerTradeCount).toBe(2);
    expect(opt.takerTradeCount).toBe(1);
    expect(opt.makerRatio).toBeCloseTo(0.6667, 2);
    expect(opt.recommendedAction).toBeDefined();
    expect(opt.makerFeeRate).toBe(0.0002);
    expect(opt.takerFeeRate).toBe(0.0005);
  });
});
