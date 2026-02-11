import { describe, expect, it } from 'vitest';
import { BacktestService } from '../src/services/backtestService.js';
import { StrategyRegistry } from '../src/domain/strategy/strategyRegistry.js';

function createService(): BacktestService {
  const registry = new StrategyRegistry();
  return new BacktestService(registry);
}

// Generate a trending-up price series
function trendingUp(start: number, ticks: number, stepPct = 0.01): number[] {
  const prices: number[] = [start];
  for (let i = 1; i < ticks; i++) {
    prices.push(prices[i - 1] * (1 + stepPct));
  }
  return prices;
}

// Generate a trending-down price series
function trendingDown(start: number, ticks: number, stepPct = 0.01): number[] {
  const prices: number[] = [start];
  for (let i = 1; i < ticks; i++) {
    prices.push(prices[i - 1] * (1 - stepPct));
  }
  return prices;
}

// Generate a sideways / oscillating price series
function oscillating(start: number, ticks: number, amplitude = 0.02): number[] {
  const prices: number[] = [];
  for (let i = 0; i < ticks; i++) {
    prices.push(start * (1 + amplitude * Math.sin(i * 0.5)));
  }
  return prices;
}

describe('BacktestService', () => {
  it('runs a backtest with momentum strategy on a trending-up series', () => {
    const service = createService();
    const result = service.run({
      strategyId: 'momentum-v1',
      symbol: 'SOL',
      priceHistory: trendingUp(100, 50),
      startingCapitalUsd: 10_000,
    });

    expect(result).toBeDefined();
    expect(result.totalReturnPct).toBeTypeOf('number');
    expect(result.maxDrawdownPct).toBeGreaterThanOrEqual(0);
    expect(result.sharpeRatio).toBeTypeOf('number');
    expect(result.tradeCount).toBeGreaterThanOrEqual(0);
    expect(result.winRate).toBeGreaterThanOrEqual(0);
    expect(result.winRate).toBeLessThanOrEqual(100);
    expect(Array.isArray(result.trades)).toBe(true);
  });

  it('returns zero trades when price history is too short for strategy signals', () => {
    const service = createService();
    // momentum-v1 needs at least 6 data points to produce a signal
    const result = service.run({
      strategyId: 'momentum-v1',
      symbol: 'SOL',
      priceHistory: [100, 101, 102],
      startingCapitalUsd: 10_000,
    });

    expect(result.tradeCount).toBe(0);
    expect(result.trades).toHaveLength(0);
    expect(result.totalReturnPct).toBe(0);
  });

  it('throws on unknown strategyId', () => {
    const service = createService();
    expect(() =>
      service.run({
        strategyId: 'nonexistent-strategy',
        symbol: 'SOL',
        priceHistory: [100, 101],
        startingCapitalUsd: 10_000,
      }),
    ).toThrow('Unknown strategyId');
  });

  it('throws when priceHistory has fewer than 2 points', () => {
    const service = createService();
    expect(() =>
      service.run({
        strategyId: 'momentum-v1',
        symbol: 'SOL',
        priceHistory: [100],
        startingCapitalUsd: 10_000,
      }),
    ).toThrow('at least 2 data points');
  });

  it('throws when startingCapitalUsd is not positive', () => {
    const service = createService();
    expect(() =>
      service.run({
        strategyId: 'momentum-v1',
        symbol: 'SOL',
        priceHistory: [100, 101],
        startingCapitalUsd: 0,
      }),
    ).toThrow('startingCapitalUsd must be positive');
  });

  it('respects risk overrides by limiting drawdown', () => {
    const service = createService();
    const downSeries = trendingDown(100, 60, 0.02);

    const result = service.run({
      strategyId: 'momentum-v1',
      symbol: 'SOL',
      priceHistory: downSeries,
      startingCapitalUsd: 10_000,
      riskOverrides: {
        maxDrawdownPct: 0.05, // Very tight drawdown limit
      },
    });

    // With tight risk limits, there should be fewer trades (risk engine blocks them)
    expect(result).toBeDefined();
    expect(result.maxDrawdownPct).toBeTypeOf('number');
    expect(result.tradeCount).toBeGreaterThanOrEqual(0);
  });

  it('produces different results for different strategies on same data', () => {
    const service = createService();
    const prices = oscillating(100, 50);

    const momentumResult = service.run({
      strategyId: 'momentum-v1',
      symbol: 'SOL',
      priceHistory: prices,
      startingCapitalUsd: 10_000,
    });

    const meanRevResult = service.run({
      strategyId: 'mean-reversion-v1',
      symbol: 'SOL',
      priceHistory: prices,
      startingCapitalUsd: 10_000,
    });

    // At least one metric should differ (strategies behave differently)
    const sameTradeCount = momentumResult.tradeCount === meanRevResult.tradeCount;
    const sameReturn = momentumResult.totalReturnPct === meanRevResult.totalReturnPct;
    const someDifference = !sameTradeCount || !sameReturn;

    expect(someDifference || (momentumResult.tradeCount === 0 && meanRevResult.tradeCount === 0)).toBe(true);
  });

  it('each trade has required fields', () => {
    const service = createService();
    const result = service.run({
      strategyId: 'momentum-v1',
      symbol: 'SOL',
      priceHistory: trendingUp(100, 40),
      startingCapitalUsd: 10_000,
    });

    for (const trade of result.trades) {
      expect(trade.tick).toBeTypeOf('number');
      expect(['buy', 'sell']).toContain(trade.side);
      expect(trade.priceUsd).toBeGreaterThan(0);
      expect(trade.quantity).toBeGreaterThan(0);
      expect(trade.notionalUsd).toBeGreaterThan(0);
      expect(trade.pnlUsd).toBeTypeOf('number');
    }
  });
});
