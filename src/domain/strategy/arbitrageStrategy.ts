import { StrategyPlugin } from './types.js';

/**
 * Arbitrage v1 — detects price discrepancies across venues (Jupiter, Raydium, Orca).
 *
 * The strategy expects `priceHistoryUsd` to carry per-venue prices in the most
 * recent slots:
 *   [0] = Jupiter price
 *   [1] = Raydium price
 *   [2] = Orca price
 *   (remaining entries are historical prices used for reliability weighting)
 *
 * When the spread between the best ask and best bid across venues exceeds the
 * configurable threshold (default 30 bps) a buy or sell signal is emitted.
 */

const DEFAULT_MIN_SPREAD_BPS = 30;

export const arbitrageStrategy: StrategyPlugin = {
  id: 'arbitrage-v1',
  name: 'Arbitrage v1',
  description:
    'Detects cross-venue price discrepancies (Jupiter / Raydium / Orca) and signals when the spread exceeds a configurable threshold.',

  evaluate(input) {
    const venuePrices = input.priceHistoryUsd
      .slice(0, 3)
      .filter((v) => Number.isFinite(v) && v > 0);

    // Also include the current price as one of the venue readings.
    if (Number.isFinite(input.currentPriceUsd) && input.currentPriceUsd > 0) {
      venuePrices.push(input.currentPriceUsd);
    }

    if (venuePrices.length < 2) {
      return {
        action: 'hold',
        confidence: 0,
        rationale: 'insufficient_venue_prices',
      };
    }

    const minPrice = Math.min(...venuePrices);
    const maxPrice = Math.max(...venuePrices);
    const midPrice = (minPrice + maxPrice) / 2;
    const spreadBps = ((maxPrice - minPrice) / midPrice) * 10_000;

    // Use the remaining history entries (index 3+) to gauge reliability.
    const reliabilityHistory = input.priceHistoryUsd
      .slice(3)
      .filter((v) => Number.isFinite(v) && v > 0);

    let reliabilityWeight = 1;
    if (reliabilityHistory.length >= 3) {
      const avg = reliabilityHistory.reduce((s, v) => s + v, 0) / reliabilityHistory.length;
      const variance =
        reliabilityHistory.reduce((s, v) => s + (v - avg) ** 2, 0) / reliabilityHistory.length;
      const cv = Math.sqrt(variance) / avg; // coefficient of variation
      // Lower historical variance ⇒ higher reliability
      reliabilityWeight = Math.max(0.3, 1 - cv * 10);
    }

    const minSpreadBps = DEFAULT_MIN_SPREAD_BPS;

    if (spreadBps < minSpreadBps) {
      return {
        action: 'hold',
        confidence: 0,
        rationale: `spread_below_threshold:${spreadBps.toFixed(1)}bps<${minSpreadBps}bps`,
      };
    }

    // Confidence: scales from 0 at threshold up to 1 at 200 bps, modulated by reliability.
    const rawConfidence = Math.min(1, (spreadBps - minSpreadBps) / 170);
    const confidence = Number((rawConfidence * reliabilityWeight).toFixed(4));

    // Buy at the cheapest venue (price is low relative to others).
    const action: 'buy' | 'sell' =
      input.currentPriceUsd <= midPrice ? 'buy' : 'sell';

    return {
      action,
      confidence,
      rationale: `cross_venue_spread:${spreadBps.toFixed(1)}bps,venues:${venuePrices.length},reliability:${reliabilityWeight.toFixed(2)}`,
    };
  },
};
