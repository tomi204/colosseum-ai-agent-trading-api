import { describe, expect, it } from 'vitest';
import { dcaStrategy } from '../src/domain/strategy/dcaStrategy.js';
import { StrategyRegistry } from '../src/domain/strategy/strategyRegistry.js';

describe('dcaStrategy', () => {
  it('signals buy on first observation (initial buy)', () => {
    const signal = dcaStrategy.evaluate({
      symbol: 'SOL',
      currentPriceUsd: 150,
      priceHistoryUsd: [],
    });

    expect(signal.action).toBe('buy');
    expect(signal.rationale).toContain('dca_initial_buy');
  });

  it('holds between scheduled buy intervals', () => {
    // Observations = history.length + 1 = 2 → 2 % 4 ≠ 0 → hold
    const signal = dcaStrategy.evaluate({
      symbol: 'SOL',
      currentPriceUsd: 150,
      priceHistoryUsd: [149],
    });

    expect(signal.action).toBe('hold');
    expect(signal.rationale).toContain('dca_waiting');
  });

  it('signals buy on the 4th tick (buy interval)', () => {
    // Observations = 3 entries + 1 = 4 → 4 % 4 === 0 → buy
    const signal = dcaStrategy.evaluate({
      symbol: 'SOL',
      currentPriceUsd: 150,
      priceHistoryUsd: [149, 150, 151],
    });

    expect(signal.action).toBe('buy');
    expect(signal.rationale).toContain('dca_scheduled_buy');
  });

  it('signals buy on the 8th tick', () => {
    // Observations = 7 entries + 1 = 8 → 8 % 4 === 0 → buy
    const signal = dcaStrategy.evaluate({
      symbol: 'SOL',
      currentPriceUsd: 148,
      priceHistoryUsd: [149, 150, 151, 150, 149, 148, 147],
    });

    expect(signal.action).toBe('buy');
    expect(signal.rationale).toContain('dca_scheduled_buy');
  });

  it('boosts confidence when price is below average', () => {
    // Price well below recent average → higher confidence
    const signal = dcaStrategy.evaluate({
      symbol: 'SOL',
      currentPriceUsd: 140,
      priceHistoryUsd: [150, 151, 152],
    });

    expect(signal.action).toBe('buy');
    expect(signal.confidence).toBeGreaterThan(0.6);
  });

  it('is registered in the strategy registry as dca-v1', () => {
    const registry = new StrategyRegistry();
    const plugin = registry.get('dca-v1');
    expect(plugin).toBeDefined();
    expect(plugin!.id).toBe('dca-v1');
  });
});
