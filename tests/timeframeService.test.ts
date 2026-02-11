import { describe, expect, it, vi, beforeEach } from 'vitest';
import { TimeframeService } from '../src/services/timeframeService.js';
import { AppState } from '../src/types.js';
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

/** Generate synthetic uptrend price history. */
function generateUptrend(length: number, start: number = 100, stepPct: number = 0.002): number[] {
  const prices: number[] = [];
  let price = start;
  for (let i = 0; i < length; i++) {
    price *= (1 + stepPct + (Math.sin(i * 0.1) * 0.001));
    prices.push(Number(price.toFixed(4)));
  }
  return prices;
}

/** Generate synthetic downtrend price history. */
function generateDowntrend(length: number, start: number = 100, stepPct: number = 0.002): number[] {
  const prices: number[] = [];
  let price = start;
  for (let i = 0; i < length; i++) {
    price *= (1 - stepPct + (Math.sin(i * 0.1) * 0.001));
    prices.push(Number(price.toFixed(4)));
  }
  return prices;
}

/** Generate sideways/choppy price history. */
function generateSideways(length: number, center: number = 100, amplitude: number = 0.5): number[] {
  const prices: number[] = [];
  for (let i = 0; i < length; i++) {
    prices.push(Number((center + Math.sin(i * 0.3) * amplitude).toFixed(4)));
  }
  return prices;
}

describe('TimeframeService', () => {
  beforeEach(() => {
    eventBus.clear();
  });

  function setup(customState?: Partial<AppState>) {
    const state = { ...createDefaultState(), ...customState };
    const store = createMockStore(state);
    const service = new TimeframeService(store);
    return { state, store, service };
  }

  describe('analyzeTimeframes', () => {
    it('returns analysis with 5 timeframe signals', () => {
      const { service } = setup();
      const prices = generateUptrend(500);
      const result = service.analyzeTimeframes('SOL', prices);

      expect(result.symbol).toBe('SOL');
      expect(result.signals.length).toBe(5);
      expect(result.analyzedAt).toBeDefined();

      const timeframes = result.signals.map((s) => s.timeframe);
      expect(timeframes).toContain('1m');
      expect(timeframes).toContain('5m');
      expect(timeframes).toContain('15m');
      expect(timeframes).toContain('1h');
      expect(timeframes).toContain('4h');
    });

    it('normalizes symbol to uppercase', () => {
      const { service } = setup();
      const prices = generateUptrend(100);
      const result = service.analyzeTimeframes('sol', prices);
      expect(result.symbol).toBe('SOL');
    });

    it('returns aggregate direction and confidence', () => {
      const { service } = setup();
      const prices = generateUptrend(500);
      const result = service.analyzeTimeframes('SOL', prices);

      expect(['bullish', 'bearish', 'neutral']).toContain(result.aggregateDirection);
      expect(result.aggregateConfidence).toBeGreaterThanOrEqual(0);
      expect(result.aggregateConfidence).toBeLessThanOrEqual(1);
    });

    it('detects bullish trend from uptrend data', () => {
      const { service } = setup();
      // Strong uptrend with enough data
      const prices = generateUptrend(500, 100, 0.005);
      const result = service.analyzeTimeframes('SOL', prices);

      // At least some signals should be bullish
      const bullishSignals = result.signals.filter((s) => s.direction === 'bullish');
      expect(bullishSignals.length).toBeGreaterThan(0);
    });

    it('detects bearish trend from downtrend data', () => {
      const { service } = setup();
      const prices = generateDowntrend(500, 100, 0.005);
      const result = service.analyzeTimeframes('SOL', prices);

      const bearishSignals = result.signals.filter((s) => s.direction === 'bearish');
      expect(bearishSignals.length).toBeGreaterThan(0);
    });

    it('each signal has valid indicators', () => {
      const { service } = setup();
      const prices = generateUptrend(500);
      const result = service.analyzeTimeframes('SOL', prices);

      for (const signal of result.signals) {
        expect(typeof signal.indicators.sma).toBe('number');
        expect(typeof signal.indicators.ema).toBe('number');
        expect(signal.indicators.rsi).toBeGreaterThanOrEqual(0);
        expect(signal.indicators.rsi).toBeLessThanOrEqual(100);
        expect(typeof signal.indicators.momentum).toBe('number');
        expect(typeof signal.indicators.volatility).toBe('number');
        expect(signal.candleCount).toBeGreaterThanOrEqual(0);
      }
    });

    it('handles very short price history gracefully', () => {
      const { service } = setup();
      const prices = [100, 101];
      const result = service.analyzeTimeframes('SOL', prices);

      expect(result.signals.length).toBe(5);
      // Most should be neutral/weak with little data
      for (const signal of result.signals) {
        expect(['bullish', 'bearish', 'neutral']).toContain(signal.direction);
      }
    });

    it('handles single price point', () => {
      const { service } = setup();
      const prices = [100];
      const result = service.analyzeTimeframes('SOL', prices);
      expect(result.signals.length).toBe(5);
    });

    it('emits event on analysis', () => {
      const { service } = setup();
      const events: unknown[] = [];
      eventBus.on('price.updated', (_type, data) => events.push(data));

      const prices = generateUptrend(100);
      service.analyzeTimeframes('SOL', prices);

      expect(events.length).toBe(1);
    });

    it('caches analysis result', () => {
      const { service } = setup();
      const prices = generateUptrend(500);

      service.analyzeTimeframes('SOL', prices);

      // Should return cached result
      const cached = service.getTimeframeSignals('SOL');
      expect(cached).not.toBeNull();
      expect(cached!.symbol).toBe('SOL');
    });
  });

  describe('getTimeframeSignals', () => {
    it('returns null for unknown symbol with no cache or state', () => {
      const { service } = setup();
      expect(service.getTimeframeSignals('UNKNOWN')).toBeNull();
    });

    it('returns cached analysis', () => {
      const { service } = setup();
      const prices = generateUptrend(500);
      service.analyzeTimeframes('SOL', prices);

      const result = service.getTimeframeSignals('SOL');
      expect(result).not.toBeNull();
      expect(result!.symbol).toBe('SOL');
      expect(result!.signals.length).toBe(5);
    });

    it('falls back to state price history', () => {
      const state = createDefaultState();
      // Add enough price history to SOL
      const baseTime = new Date('2025-01-01').getTime();
      state.marketPriceHistoryUsd['SOL'] = Array.from({ length: 100 }, (_, i) => ({
        ts: new Date(baseTime + i * 60000).toISOString(),
        priceUsd: 100 + i * 0.1,
      }));

      const { service } = setup(state);
      const result = service.getTimeframeSignals('SOL');

      expect(result).not.toBeNull();
      expect(result!.symbol).toBe('SOL');
    });

    it('normalizes symbol case', () => {
      const { service } = setup();
      const prices = generateUptrend(100);
      service.analyzeTimeframes('sol', prices);

      const result = service.getTimeframeSignals('sol');
      expect(result).not.toBeNull();
      expect(result!.symbol).toBe('SOL');
    });
  });

  describe('getTimeframeAlignment', () => {
    it('returns null for unknown symbol', () => {
      const { service } = setup();
      expect(service.getTimeframeAlignment('UNKNOWN')).toBeNull();
    });

    it('returns alignment data for analyzed symbol', () => {
      const { service } = setup();
      const prices = generateUptrend(500, 100, 0.005);
      service.analyzeTimeframes('SOL', prices);

      const alignment = service.getTimeframeAlignment('SOL');
      expect(alignment).not.toBeNull();
      expect(alignment!.symbol).toBe('SOL');
      expect(typeof alignment!.aligned).toBe('boolean');
      expect(alignment!.alignmentScore).toBeGreaterThanOrEqual(0);
      expect(alignment!.alignmentScore).toBeLessThanOrEqual(1);
      expect(['bullish', 'bearish', 'neutral']).toContain(alignment!.dominantDirection);
      expect(Array.isArray(alignment!.agreeing)).toBe(true);
      expect(Array.isArray(alignment!.diverging)).toBe(true);
      expect(typeof alignment!.recommendation).toBe('string');
      expect(alignment!.recommendation.length).toBeGreaterThan(0);
      expect(alignment!.analyzedAt).toBeDefined();
    });

    it('reports high alignment for strong uptrend', () => {
      const { service } = setup();
      // Very strong uptrend
      const prices = generateUptrend(1000, 100, 0.01);
      service.analyzeTimeframes('SOL', prices);

      const alignment = service.getTimeframeAlignment('SOL');
      expect(alignment).not.toBeNull();
      // Strong trend should have good alignment
      expect(alignment!.alignmentScore).toBeGreaterThan(0.5);
    });

    it('agreeing + diverging covers all 5 timeframes', () => {
      const { service } = setup();
      const prices = generateUptrend(500);
      service.analyzeTimeframes('SOL', prices);

      const alignment = service.getTimeframeAlignment('SOL');
      expect(alignment).not.toBeNull();
      expect(alignment!.agreeing.length + alignment!.diverging.length).toBe(5);
    });

    it('provides recommendation string', () => {
      const { service } = setup();
      const prices = generateSideways(500);
      service.analyzeTimeframes('SOL', prices);

      const alignment = service.getTimeframeAlignment('SOL');
      expect(alignment).not.toBeNull();
      expect(alignment!.recommendation.length).toBeGreaterThan(10);
    });
  });

  describe('signal strength and confidence', () => {
    it('assigns strength levels', () => {
      const { service } = setup();
      const prices = generateUptrend(500);
      const result = service.analyzeTimeframes('SOL', prices);

      for (const signal of result.signals) {
        expect(['strong', 'moderate', 'weak']).toContain(signal.strength);
      }
    });

    it('confidence is between 0 and 1', () => {
      const { service } = setup();
      const prices = generateUptrend(500);
      const result = service.analyzeTimeframes('SOL', prices);

      for (const signal of result.signals) {
        expect(signal.confidence).toBeGreaterThanOrEqual(0);
        expect(signal.confidence).toBeLessThanOrEqual(1);
      }
    });
  });
});
