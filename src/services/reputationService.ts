/**
 * Agent reputation scoring service.
 *
 * Calculates a 0–1000 reputation score per agent based on five weighted
 * factors: trade success rate, risk discipline, consistency (Sharpe),
 * uptime, and receipt verification rate.
 *
 * Reputation decays if the agent has been inactive for extended periods.
 */

import { StateStore } from '../infra/storage/stateStore.js';
import {
  ReputationBreakdown,
  ReputationLeaderboard,
  ReputationScore,
} from '../domain/reputation/reputationTypes.js';
import { isoNow } from '../utils/time.js';

/** Weights for each reputation factor (must sum to 1). */
const WEIGHTS = {
  tradeSuccessRate: 0.30,
  riskDiscipline: 0.20,
  consistency: 0.20,
  uptime: 0.15,
  receiptVerification: 0.15,
} as const;

/** Maximum score. */
const MAX_SCORE = 1000;

/** Uptime benchmark: 30 days in ms. Full score if agent has been active this long. */
const UPTIME_BENCHMARK_MS = 30 * 24 * 60 * 60 * 1000;

/** Inactivity decay: after this many ms without a trade, score begins to decay. */
const DECAY_START_MS = 7 * 24 * 60 * 60 * 1000;

/** Full decay after this many ms of inactivity (score → 0). */
const DECAY_FULL_MS = 30 * 24 * 60 * 60 * 1000;

/** Sharpe ratio benchmark: a Sharpe of 2.0 or above earns full score. */
const SHARPE_BENCHMARK = 2.0;

export class ReputationService {
  constructor(private readonly store: StateStore) {}

  /**
   * Calculate reputation score for a single agent.
   */
  calculate(agentId: string): ReputationScore | null {
    const state = this.store.snapshot();
    const agent = state.agents[agentId];
    if (!agent) return null;

    const now = Date.now();

    // ── 1. Trade success rate ───────────────────────────────────────────
    const executions = Object.values(state.executions)
      .filter((ex) => ex.agentId === agentId && ex.status === 'filled');

    const closingTrades = executions.filter((ex) => ex.side === 'sell');
    const wins = closingTrades.filter((ex) => ex.realizedPnlUsd > 0).length;
    const winRate = closingTrades.length > 0 ? wins / closingTrades.length : 0;
    const tradeSuccessRate = Math.round(winRate * MAX_SCORE);

    // ── 2. Risk discipline ──────────────────────────────────────────────
    const totalRejections = Object.values(agent.riskRejectionsByReason)
      .reduce((sum, count) => sum + count, 0);
    const totalIntents = Object.values(state.tradeIntents)
      .filter((intent) => intent.agentId === agentId).length;
    const rejectionRate = totalIntents > 0 ? totalRejections / totalIntents : 0;
    // Low rejection = good discipline (invert)
    const riskDiscipline = Math.round((1 - Math.min(rejectionRate, 1)) * MAX_SCORE);

    // ── 3. Consistency (Sharpe ratio) ───────────────────────────────────
    const dailyPnlMap = new Map<string, number>();
    for (const ex of executions) {
      const day = ex.createdAt.slice(0, 10);
      dailyPnlMap.set(day, (dailyPnlMap.get(day) ?? 0) + ex.realizedPnlUsd);
    }
    const dailyReturns = Array.from(dailyPnlMap.values());
    const sharpe = this.computeSharpe(dailyReturns);
    // Normalize: sharpe of SHARPE_BENCHMARK → 1000, negative → 0
    const normalizedSharpe = sharpe !== null
      ? Math.max(0, Math.min(1, sharpe / SHARPE_BENCHMARK))
      : 0;
    const consistency = Math.round(normalizedSharpe * MAX_SCORE);

    // ── 4. Uptime ───────────────────────────────────────────────────────
    const agentAgeMs = now - new Date(agent.createdAt).getTime();
    const uptimeRatio = Math.min(agentAgeMs / UPTIME_BENCHMARK_MS, 1);
    const uptime = Math.round(uptimeRatio * MAX_SCORE);

    // ── 5. Receipt verification rate ────────────────────────────────────
    const agentReceipts = Object.values(state.executionReceipts)
      .filter((r) => r.payload.agentId === agentId);
    const verifiedCount = agentReceipts.length; // All receipts in store are valid by design
    const receiptTotal = executions.length;
    const receiptRate = receiptTotal > 0 ? Math.min(verifiedCount / receiptTotal, 1) : 1;
    const receiptVerification = Math.round(receiptRate * MAX_SCORE);

    // ── Weighted total ──────────────────────────────────────────────────
    const breakdown: ReputationBreakdown = {
      tradeSuccessRate,
      riskDiscipline,
      consistency,
      uptime,
      receiptVerification,
    };

    let rawScore = Math.round(
      breakdown.tradeSuccessRate * WEIGHTS.tradeSuccessRate
      + breakdown.riskDiscipline * WEIGHTS.riskDiscipline
      + breakdown.consistency * WEIGHTS.consistency
      + breakdown.uptime * WEIGHTS.uptime
      + breakdown.receiptVerification * WEIGHTS.receiptVerification,
    );

    // Apply inactivity decay
    const lastTradeMs = agent.lastTradeAt
      ? new Date(agent.lastTradeAt).getTime()
      : new Date(agent.createdAt).getTime();
    const inactiveMs = now - lastTradeMs;

    if (inactiveMs > DECAY_START_MS) {
      const decayProgress = Math.min(
        (inactiveMs - DECAY_START_MS) / (DECAY_FULL_MS - DECAY_START_MS),
        1,
      );
      rawScore = Math.round(rawScore * (1 - decayProgress));
    }

    const score = Math.max(0, Math.min(MAX_SCORE, rawScore));

    return {
      agentId,
      score,
      breakdown,
      calculatedAt: isoNow(),
    };
  }

  /**
   * Build a leaderboard of all agents ranked by reputation score.
   */
  leaderboard(limit = 50): ReputationLeaderboard {
    const state = this.store.snapshot();
    const agents = Object.values(state.agents);

    const scored: Array<{ agentId: string; agentName: string; score: number }> = [];

    for (const agent of agents) {
      const rep = this.calculate(agent.id);
      if (rep) {
        scored.push({
          agentId: agent.id,
          agentName: agent.name,
          score: rep.score,
        });
      }
    }

    scored.sort((a, b) => b.score - a.score);

    return {
      asOf: isoNow(),
      entries: scored.slice(0, limit).map((entry, index) => ({
        rank: index + 1,
        agentId: entry.agentId,
        agentName: entry.agentName,
        score: entry.score,
      })),
    };
  }

  private computeSharpe(dailyReturns: number[]): number | null {
    if (dailyReturns.length < 2) return null;

    const mean = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
    const variance = dailyReturns.reduce((sum, r) => sum + (r - mean) ** 2, 0)
      / (dailyReturns.length - 1);
    const stdDev = Math.sqrt(variance);

    if (stdDev === 0) return null;

    return (mean / stdDev) * Math.sqrt(252);
  }
}
