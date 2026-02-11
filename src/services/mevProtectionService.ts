/**
 * MEV Protection Service.
 *
 * Integrates MEV analysis into the trade pipeline.
 * Tracks risk scores across executions and provides aggregate statistics.
 */

import {
  analyzeSandwichRisk,
  MevReport,
  MevTradeIntent,
} from '../domain/mev/mevProtection.js';
import { StateStore } from '../infra/storage/stateStore.js';
import { eventBus } from '../infra/eventBus.js';

export interface MevStats {
  totalAnalyzed: number;
  averageRiskScore: number;
  highRiskCount: number;
  criticalRiskCount: number;
  totalEstimatedCostUsd: number;
  riskDistribution: {
    low: number;
    medium: number;
    high: number;
    critical: number;
  };
  topMitigations: Array<{ strategy: string; count: number }>;
}

export class MevProtectionService {
  private reports: MevReport[] = [];
  private mitigationCounts: Map<string, number> = new Map();

  constructor(private readonly store: StateStore) {}

  /**
   * Analyze a trade intent for MEV / sandwich risk.
   */
  analyze(intent: MevTradeIntent): MevReport {
    // Enrich with pool liquidity from market data if not provided
    const enrichedIntent = this.enrichIntent(intent);
    const report = analyzeSandwichRisk(enrichedIntent);

    this.reports.push(report);

    // Track mitigation counts
    for (const m of report.mitigations) {
      const count = this.mitigationCounts.get(m.strategy) ?? 0;
      this.mitigationCounts.set(m.strategy, count + 1);
    }

    // Keep bounded
    if (this.reports.length > 5000) {
      this.reports = this.reports.slice(-2500);
    }

    eventBus.emit('mev.analyzed', {
      symbol: intent.symbol,
      riskScore: report.riskScore,
      riskLevel: report.riskLevel,
      estimatedCostUsd: report.estimatedCostUsd,
    });

    return report;
  }

  /**
   * Get aggregate MEV protection statistics.
   */
  getMevStats(): MevStats {
    const total = this.reports.length;

    if (total === 0) {
      return {
        totalAnalyzed: 0,
        averageRiskScore: 0,
        highRiskCount: 0,
        criticalRiskCount: 0,
        totalEstimatedCostUsd: 0,
        riskDistribution: { low: 0, medium: 0, high: 0, critical: 0 },
        topMitigations: [],
      };
    }

    const avgScore = this.reports.reduce((sum, r) => sum + r.riskScore, 0) / total;
    const totalCost = this.reports.reduce((sum, r) => sum + r.estimatedCostUsd, 0);

    const distribution = { low: 0, medium: 0, high: 0, critical: 0 };
    for (const r of this.reports) {
      distribution[r.riskLevel] += 1;
    }

    const topMitigations = Array.from(this.mitigationCounts.entries())
      .map(([strategy, count]) => ({ strategy, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return {
      totalAnalyzed: total,
      averageRiskScore: Number(avgScore.toFixed(2)),
      highRiskCount: distribution.high,
      criticalRiskCount: distribution.critical,
      totalEstimatedCostUsd: Number(totalCost.toFixed(4)),
      riskDistribution: distribution,
      topMitigations,
    };
  }

  /**
   * Enrich intent with market data from the store when fields are missing.
   */
  private enrichIntent(intent: MevTradeIntent): MevTradeIntent {
    const enriched = { ...intent };
    const state = this.store.snapshot();

    // If pool liquidity not provided, estimate from market data
    // Use a heuristic: market price * 10,000 as rough pool liquidity
    if (enriched.poolLiquidityUsd === undefined) {
      const price = state.marketPricesUsd[intent.symbol.toUpperCase()];
      if (price) {
        enriched.poolLiquidityUsd = price * 10_000;
      }
    }

    return enriched;
  }
}
