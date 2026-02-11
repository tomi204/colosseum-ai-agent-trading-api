import { describe, expect, it } from 'vitest';
import { arbitrageStrategy } from '../src/domain/strategy/arbitrageStrategy.js';
import { StrategyRegistry } from '../src/domain/strategy/strategyRegistry.js';

describe('arbitrageStrategy', () => {
  it('holds when fewer than 2 venue prices are provided', () => {
    const signal = arbitrageStrategy.evaluate({
      symbol: 'SOL',
      currentPriceUsd: 0, // invalid current price
      priceHistoryUsd: [150], // only one valid venue price, current invalid → < 2
    });

    expect(signal.action).toBe('hold');
    expect(signal.rationale).toContain('insufficient_venue_prices');
  });

  it('holds when spread is below threshold', () => {
    // 3 venues with near-identical prices → spread < 30 bps
    const signal = arbitrageStrategy.evaluate({
      symbol: 'SOL',
      currentPriceUsd: 150.0,
      priceHistoryUsd: [150.0, 150.01, 150.02],
    });

    expect(signal.action).toBe('hold');
    expect(signal.rationale).toContain('spread_below_threshold');
  });

  it('signals buy when current price is below mid and spread exceeds threshold', () => {
    // Jupiter=148, Raydium=149, Orca=150, current=148 (cheapest)
    const signal = arbitrageStrategy.evaluate({
      symbol: 'SOL',
      currentPriceUsd: 148,
      priceHistoryUsd: [148, 149, 151],
    });

    expect(signal.action).toBe('buy');
    expect(signal.confidence).toBeGreaterThan(0);
    expect(signal.rationale).toContain('cross_venue_spread');
  });

  it('signals sell when current price is above mid and spread exceeds threshold', () => {
    // Jupiter=148, Raydium=149, Orca=150, current=152 (above mid)
    const signal = arbitrageStrategy.evaluate({
      symbol: 'SOL',
      currentPriceUsd: 152,
      priceHistoryUsd: [148, 149, 150],
    });

    expect(signal.action).toBe('sell');
    expect(signal.confidence).toBeGreaterThan(0);
  });

  it('uses historical reliability to modulate confidence', () => {
    // Stable history → higher reliability weight
    const stableSignal = arbitrageStrategy.evaluate({
      symbol: 'SOL',
      currentPriceUsd: 148,
      priceHistoryUsd: [148, 149, 152, 150, 150.1, 150.2, 150.0],
    });

    // Volatile history → lower reliability weight
    const volatileSignal = arbitrageStrategy.evaluate({
      symbol: 'SOL',
      currentPriceUsd: 148,
      priceHistoryUsd: [148, 149, 152, 100, 200, 80, 250],
    });

    // Both should signal, but stable should have higher confidence
    expect(stableSignal.confidence).toBeGreaterThan(volatileSignal.confidence);
  });

  it('is registered in the strategy registry as arbitrage-v1', () => {
    const registry = new StrategyRegistry();
    const plugin = registry.get('arbitrage-v1');
    expect(plugin).toBeDefined();
    expect(plugin!.id).toBe('arbitrage-v1');
  });
});
