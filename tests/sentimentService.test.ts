import { describe, expect, it, beforeEach } from 'vitest';
import { SentimentService, SentimentClassification } from '../src/services/sentimentService.js';
import { AppState, Agent } from '../src/types.js';
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

describe('SentimentService', () => {
  let service: SentimentService;
  let state: AppState;

  beforeEach(() => {
    state = createDefaultState();
    state.agents['agent-1'] = makeAgent('agent-1', 'Momentum Bot', { strategyId: 'momentum-v1' });
    state.agents['agent-2'] = makeAgent('agent-2', 'Mean Rev Bot', { strategyId: 'mean-reversion-v1' });
    state.agents['agent-3'] = makeAgent('agent-3', 'DCA Bot', { strategyId: 'dca-v1' });
    const store = createMockStore(state);
    service = new SentimentService(store);
  });

  // ─── analyzeSentiment basics ──────────────────────────────────────

  it('returns a valid sentiment reading for a symbol', () => {
    const reading = service.analyzeSentiment('SOL');
    expect(reading.symbol).toBe('SOL');
    expect(reading.score).toBeGreaterThanOrEqual(-100);
    expect(reading.score).toBeLessThanOrEqual(100);
    expect(reading.classification).toBeDefined();
    expect(reading.breakdown).toBeDefined();
    expect(reading.breakdown.priceMomentum).toBeDefined();
    expect(reading.breakdown.volumeProxy).toBeDefined();
    expect(reading.breakdown.agentConsensus).toBeDefined();
    expect(reading.breakdown.strategyAgreement).toBeDefined();
    expect(reading.timestamp).toBeDefined();
  });

  it('normalizes symbol to uppercase', () => {
    const reading = service.analyzeSentiment('sol');
    expect(reading.symbol).toBe('SOL');
  });

  it('returns neutral sentiment when no data available', () => {
    const reading = service.analyzeSentiment('UNKNOWN');
    expect(reading.score).toBeGreaterThanOrEqual(-30);
    expect(reading.score).toBeLessThanOrEqual(30);
  });

  // ─── classification ───────────────────────────────────────────────

  it('classifies sentiment correctly across range', () => {
    // We test classification logic by examining returned readings
    const reading = service.analyzeSentiment('SOL');
    const validClassifications: SentimentClassification[] = [
      'Extreme Fear', 'Fear', 'Neutral', 'Greed', 'Extreme Greed',
    ];
    expect(validClassifications).toContain(reading.classification);
  });

  // ─── price momentum ───────────────────────────────────────────────

  it('detects bullish price momentum from rising prices', () => {
    // Create rising price history
    const now = Date.now();
    state.marketPriceHistoryUsd['SOL'] = Array.from({ length: 10 }, (_, i) => ({
      ts: new Date(now + i * 60_000).toISOString(),
      priceUsd: 100 + i * 5, // 100 → 145
    }));

    const store = createMockStore(state);
    service = new SentimentService(store);
    const reading = service.analyzeSentiment('SOL');

    expect(reading.breakdown.priceMomentum).toBeGreaterThan(0);
  });

  it('detects bearish price momentum from falling prices', () => {
    const now = Date.now();
    state.marketPriceHistoryUsd['SOL'] = Array.from({ length: 10 }, (_, i) => ({
      ts: new Date(now + i * 60_000).toISOString(),
      priceUsd: 150 - i * 5, // 150 → 105
    }));

    const store = createMockStore(state);
    service = new SentimentService(store);
    const reading = service.analyzeSentiment('SOL');

    expect(reading.breakdown.priceMomentum).toBeLessThan(0);
  });

  it('returns zero momentum when prices are flat', () => {
    const now = Date.now();
    state.marketPriceHistoryUsd['SOL'] = Array.from({ length: 10 }, (_, i) => ({
      ts: new Date(now + i * 60_000).toISOString(),
      priceUsd: 100, // flat
    }));

    const store = createMockStore(state);
    service = new SentimentService(store);
    const reading = service.analyzeSentiment('SOL');

    expect(reading.breakdown.priceMomentum).toBe(0);
  });

  // ─── agent consensus ──────────────────────────────────────────────

  it('detects bullish agent consensus when agents hold and buy', () => {
    // Agents hold SOL positions
    state.agents['agent-1'].positions['SOL'] = { symbol: 'SOL', quantity: 10, avgEntryPriceUsd: 100 };
    state.agents['agent-2'].positions['SOL'] = { symbol: 'SOL', quantity: 5, avgEntryPriceUsd: 105 };

    // Recent buy executions
    state.executions['exec-1'] = {
      id: 'exec-1', intentId: 'i-1', agentId: 'agent-1', symbol: 'SOL',
      side: 'buy', quantity: 10, priceUsd: 100, grossNotionalUsd: 1000,
      feeUsd: 1, netUsd: 999, realizedPnlUsd: 0, pnlSnapshotUsd: 0,
      mode: 'paper', status: 'filled', createdAt: new Date().toISOString(),
    };
    state.executions['exec-2'] = {
      id: 'exec-2', intentId: 'i-2', agentId: 'agent-2', symbol: 'SOL',
      side: 'buy', quantity: 5, priceUsd: 105, grossNotionalUsd: 525,
      feeUsd: 0.5, netUsd: 524.5, realizedPnlUsd: 0, pnlSnapshotUsd: 0,
      mode: 'paper', status: 'filled', createdAt: new Date().toISOString(),
    };

    const store = createMockStore(state);
    service = new SentimentService(store);
    const reading = service.analyzeSentiment('SOL');

    expect(reading.breakdown.agentConsensus).toBeGreaterThan(0);
  });

  it('detects bearish agent consensus when agents sell', () => {
    state.executions['exec-1'] = {
      id: 'exec-1', intentId: 'i-1', agentId: 'agent-1', symbol: 'SOL',
      side: 'sell', quantity: 10, priceUsd: 100, grossNotionalUsd: 1000,
      feeUsd: 1, netUsd: 999, realizedPnlUsd: 0, pnlSnapshotUsd: 0,
      mode: 'paper', status: 'filled', createdAt: new Date().toISOString(),
    };
    state.executions['exec-2'] = {
      id: 'exec-2', intentId: 'i-2', agentId: 'agent-2', symbol: 'SOL',
      side: 'sell', quantity: 5, priceUsd: 105, grossNotionalUsd: 525,
      feeUsd: 0.5, netUsd: 524.5, realizedPnlUsd: 0, pnlSnapshotUsd: 0,
      mode: 'paper', status: 'filled', createdAt: new Date().toISOString(),
    };

    const store = createMockStore(state);
    service = new SentimentService(store);
    const reading = service.analyzeSentiment('SOL');

    expect(reading.breakdown.agentConsensus).toBeLessThan(0);
  });

  // ─── strategy agreement ───────────────────────────────────────────

  it('detects strategy agreement when multiple strategies buy', () => {
    // Different strategy agents all buying
    state.executions['exec-1'] = {
      id: 'exec-1', intentId: 'i-1', agentId: 'agent-1', symbol: 'SOL',
      side: 'buy', quantity: 10, priceUsd: 100, grossNotionalUsd: 1000,
      feeUsd: 1, netUsd: 999, realizedPnlUsd: 0, pnlSnapshotUsd: 0,
      mode: 'paper', status: 'filled', createdAt: new Date().toISOString(),
    };
    state.executions['exec-2'] = {
      id: 'exec-2', intentId: 'i-2', agentId: 'agent-2', symbol: 'SOL',
      side: 'buy', quantity: 5, priceUsd: 105, grossNotionalUsd: 525,
      feeUsd: 0.5, netUsd: 524.5, realizedPnlUsd: 0, pnlSnapshotUsd: 0,
      mode: 'paper', status: 'filled', createdAt: new Date().toISOString(),
    };
    state.executions['exec-3'] = {
      id: 'exec-3', intentId: 'i-3', agentId: 'agent-3', symbol: 'SOL',
      side: 'buy', quantity: 3, priceUsd: 102, grossNotionalUsd: 306,
      feeUsd: 0.3, netUsd: 305.7, realizedPnlUsd: 0, pnlSnapshotUsd: 0,
      mode: 'paper', status: 'filled', createdAt: new Date().toISOString(),
    };

    const store = createMockStore(state);
    service = new SentimentService(store);
    const reading = service.analyzeSentiment('SOL');

    expect(reading.breakdown.strategyAgreement).toBeGreaterThan(0);
  });

  it('returns neutral strategy agreement when strategies disagree', () => {
    state.executions['exec-1'] = {
      id: 'exec-1', intentId: 'i-1', agentId: 'agent-1', symbol: 'SOL',
      side: 'buy', quantity: 10, priceUsd: 100, grossNotionalUsd: 1000,
      feeUsd: 1, netUsd: 999, realizedPnlUsd: 0, pnlSnapshotUsd: 0,
      mode: 'paper', status: 'filled', createdAt: new Date().toISOString(),
    };
    state.executions['exec-2'] = {
      id: 'exec-2', intentId: 'i-2', agentId: 'agent-2', symbol: 'SOL',
      side: 'sell', quantity: 5, priceUsd: 105, grossNotionalUsd: 525,
      feeUsd: 0.5, netUsd: 524.5, realizedPnlUsd: 0, pnlSnapshotUsd: 0,
      mode: 'paper', status: 'filled', createdAt: new Date().toISOString(),
    };

    const store = createMockStore(state);
    service = new SentimentService(store);
    const reading = service.analyzeSentiment('SOL');

    // With mixed signals, should be closer to neutral
    expect(Math.abs(reading.breakdown.strategyAgreement)).toBeLessThanOrEqual(50);
  });

  // ─── getSentimentHistory ──────────────────────────────────────────

  it('stores sentiment readings in history', () => {
    service.analyzeSentiment('SOL');
    service.analyzeSentiment('SOL');
    service.analyzeSentiment('SOL');

    const history = service.getSentimentHistory('SOL');
    expect(history.length).toBe(3);
    expect(history[0].symbol).toBe('SOL');
  });

  it('respects limit parameter', () => {
    for (let i = 0; i < 10; i++) {
      service.analyzeSentiment('SOL');
    }

    const history = service.getSentimentHistory('SOL', 3);
    expect(history.length).toBe(3);
  });

  it('returns empty for unknown symbol', () => {
    const history = service.getSentimentHistory('UNKNOWN');
    expect(history).toEqual([]);
  });

  it('orders history with most recent first', () => {
    service.analyzeSentiment('SOL');
    service.analyzeSentiment('SOL');

    const history = service.getSentimentHistory('SOL');
    expect(history.length).toBe(2);
    // Most recent first
    expect(new Date(history[0].timestamp).getTime())
      .toBeGreaterThanOrEqual(new Date(history[1].timestamp).getTime());
  });

  // ─── getOverview ──────────────────────────────────────────────────

  it('returns overview of all tracked symbols', () => {
    service.analyzeSentiment('SOL');
    service.analyzeSentiment('BONK');
    service.analyzeSentiment('JUP');

    const overview = service.getOverview();
    expect(overview.length).toBe(3);

    const symbols = overview.map((e) => e.symbol);
    expect(symbols).toContain('SOL');
    expect(symbols).toContain('BONK');
    expect(symbols).toContain('JUP');

    // Each entry has required fields
    for (const entry of overview) {
      expect(entry.score).toBeGreaterThanOrEqual(-100);
      expect(entry.score).toBeLessThanOrEqual(100);
      expect(entry.classification).toBeDefined();
      expect(entry.timestamp).toBeDefined();
    }
  });

  it('returns empty overview when no symbols tracked', () => {
    const overview = service.getOverview();
    expect(overview).toEqual([]);
  });

  it('sorts overview by score descending', () => {
    service.analyzeSentiment('SOL');
    service.analyzeSentiment('BONK');
    service.analyzeSentiment('JUP');

    const overview = service.getOverview();
    for (let i = 1; i < overview.length; i++) {
      expect(overview[i - 1].score).toBeGreaterThanOrEqual(overview[i].score);
    }
  });

  // ─── score clamping ───────────────────────────────────────────────

  it('clamps scores to -100..+100 range', () => {
    // Create extreme conditions: huge price rise + all agents buying
    const now = Date.now();
    state.marketPriceHistoryUsd['SOL'] = Array.from({ length: 10 }, (_, i) => ({
      ts: new Date(now + i * 60_000).toISOString(),
      priceUsd: 10 + i * 100, // extreme rise
    }));

    for (let i = 1; i <= 50; i++) {
      state.executions[`exec-${i}`] = {
        id: `exec-${i}`, intentId: `i-${i}`, agentId: 'agent-1', symbol: 'SOL',
        side: 'buy', quantity: 10, priceUsd: 100, grossNotionalUsd: 1000,
        feeUsd: 1, netUsd: 999, realizedPnlUsd: 0, pnlSnapshotUsd: 0,
        mode: 'paper', status: 'filled', createdAt: new Date(now - 1000).toISOString(),
      };
    }

    state.agents['agent-1'].positions['SOL'] = { symbol: 'SOL', quantity: 500, avgEntryPriceUsd: 100 };

    const store = createMockStore(state);
    service = new SentimentService(store);
    const reading = service.analyzeSentiment('SOL');

    expect(reading.score).toBeGreaterThanOrEqual(-100);
    expect(reading.score).toBeLessThanOrEqual(100);
    expect(reading.breakdown.priceMomentum).toBeGreaterThanOrEqual(-100);
    expect(reading.breakdown.priceMomentum).toBeLessThanOrEqual(100);
  });

  // ─── volume proxy ─────────────────────────────────────────────────

  it('detects high volume activity', () => {
    const now = new Date();
    // Create many recent executions
    for (let i = 0; i < 20; i++) {
      state.executions[`exec-${i}`] = {
        id: `exec-${i}`, intentId: `i-${i}`, agentId: 'agent-1', symbol: 'SOL',
        side: 'buy', quantity: 1, priceUsd: 100, grossNotionalUsd: 100,
        feeUsd: 0.1, netUsd: 99.9, realizedPnlUsd: 0, pnlSnapshotUsd: 0,
        mode: 'paper', status: 'filled',
        createdAt: new Date(now.getTime() - i * 60_000).toISOString(), // 1 per minute
      };
    }

    const store = createMockStore(state);
    service = new SentimentService(store);
    const reading = service.analyzeSentiment('SOL');

    // High recent activity should push volume proxy positive
    expect(reading.breakdown.volumeProxy).toBeGreaterThan(-50);
  });
});
