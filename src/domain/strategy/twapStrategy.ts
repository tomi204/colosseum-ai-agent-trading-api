import { StrategyPlugin } from './types.js';

/**
 * TWAP v1 — Time-Weighted Average Price.
 *
 * Splits a large order into smaller, evenly-spaced chunks over time to
 * minimise market impact. Execution progress is tracked via the length of
 * `priceHistoryUsd` (each entry = one chunk window).
 *
 * Configuration via price-history conventions:
 *   - Total chunks to execute are encoded as the target (default 10).
 *   - Each observation tick triggers one chunk execution until target is met.
 */

const DEFAULT_TOTAL_CHUNKS = 10;

export const twapStrategy: StrategyPlugin = {
  id: 'twap-v1',
  name: 'TWAP v1',
  description:
    'Time-weighted average price — splits large orders into smaller chunks over time to minimise market impact.',

  evaluate(input) {
    const history = input.priceHistoryUsd.filter((v) => Number.isFinite(v) && v > 0);
    const executedChunks = history.length;
    const totalChunks = DEFAULT_TOTAL_CHUNKS;
    const remaining = Math.max(0, totalChunks - executedChunks);

    if (remaining === 0) {
      return {
        action: 'hold',
        confidence: 0,
        rationale: `twap_complete:${executedChunks}/${totalChunks}_chunks_executed`,
      };
    }

    // Detect trend direction from recent history to decide buy vs sell.
    // Default to buy (accumulation) if insufficient history.
    let action: 'buy' | 'sell' = 'buy';
    if (history.length >= 2) {
      const recentAvg = history.slice(-3).reduce((s, v) => s + v, 0) / Math.min(3, history.length);
      if (input.currentPriceUsd > recentAvg * 1.001) {
        // Price drifting up — could be selling into strength.
        action = 'sell';
      }
    }

    // Confidence ramps up as we approach the end of the schedule (urgency).
    const progress = executedChunks / totalChunks;
    const baseConfidence = 0.4 + progress * 0.4; // 0.4 → 0.8

    // Slight penalty if current price deviates significantly from TWAP so far.
    let priceDeviation = 0;
    if (history.length > 0) {
      const twapSoFar = history.reduce((s, v) => s + v, 0) / history.length;
      priceDeviation = Math.abs(input.currentPriceUsd - twapSoFar) / twapSoFar;
    }

    const confidence = Number(
      Math.min(1, Math.max(0.1, baseConfidence - priceDeviation * 2)).toFixed(4),
    );

    return {
      action,
      confidence,
      rationale: `twap_chunk:${executedChunks + 1}/${totalChunks},remaining:${remaining},price_dev:${priceDeviation.toFixed(4)}`,
    };
  },
};
