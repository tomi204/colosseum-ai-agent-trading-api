import { StrategyPlugin } from './types.js';

/**
 * DCA v1 — Dollar Cost Averaging.
 *
 * Signals a buy on a time-weighted schedule regardless of market conditions.
 * The strategy encodes timing state via the price history length:
 *   - Each entry in `priceHistoryUsd` represents one observation interval.
 *   - A buy is signalled every N intervals (configurable, default 4).
 *
 * This is ideal for agents that want steady accumulation over time.
 */

const DEFAULT_BUY_EVERY_N = 4;

export const dcaStrategy: StrategyPlugin = {
  id: 'dca-v1',
  name: 'DCA v1',
  description:
    'Dollar-cost averaging — signals buy on a time-weighted schedule regardless of market conditions.',

  evaluate(input) {
    const history = input.priceHistoryUsd.filter((v) => Number.isFinite(v) && v > 0);
    const observations = history.length + 1; // +1 for current tick

    if (history.length < 1) {
      // First observation — start accumulating immediately.
      return {
        action: 'buy',
        confidence: 0.5,
        rationale: 'dca_initial_buy',
      };
    }

    const buyInterval = DEFAULT_BUY_EVERY_N;
    const isBuyTick = observations % buyInterval === 0;

    if (isBuyTick) {
      // Confidence is flat for DCA — the whole point is consistency.
      // Slight bump when price is below recent average (better value).
      const avg = history.reduce((s, v) => s + v, 0) / history.length;
      const deviation = (input.currentPriceUsd - avg) / avg;
      // Base confidence 0.6, up to 0.9 if price is 5 %+ below avg.
      const confidence = Number(Math.min(0.9, 0.6 + Math.max(0, -deviation) * 6).toFixed(4));

      return {
        action: 'buy',
        confidence,
        rationale: `dca_scheduled_buy:tick_${observations},interval_${buyInterval},deviation:${deviation.toFixed(4)}`,
      };
    }

    return {
      action: 'hold',
      confidence: 0,
      rationale: `dca_waiting:tick_${observations},next_buy_in_${buyInterval - (observations % buyInterval)}`,
    };
  },
};
