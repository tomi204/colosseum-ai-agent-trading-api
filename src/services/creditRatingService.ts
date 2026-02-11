/**
 * Agent Credit Rating / Risk Scoring service.
 *
 * Computes a 0–100 credit/risk score for each agent based on trading history.
 * Factors:
 *   - Win rate (25%)
 *   - Max drawdown (25%)
 *   - Trade frequency (15%)
 *   - Avg hold time (15%)
 *   - Risk rejection rate (20%)
 *
 * Score 0-100 with letter grades:
 *   A+ (90+), A (80+), B (70+), C (60+), D (50+), F (<50)
 */

import { StateStore } from '../infra/storage/stateStore.js';
import { isoNow } from '../utils/time.js';

export type LetterGrade = 'A+' | 'A' | 'B' | 'C' | 'D' | 'F';

export interface RatingFactor {
  name: string;
  weight: number;
  rawValue: number;
  normalizedScore: number;    // 0-100
  weightedScore: number;      // normalizedScore * weight
  description: string;
}

export interface CreditRating {
  agentId: string;
  score: number;              // 0-100
  grade: LetterGrade;
  calculatedAt: string;
}

export interface CreditRatingBreakdown extends CreditRating {
  factors: RatingFactor[];
}

export interface CreditRatingLeaderboardEntry {
  rank: number;
  agentId: string;
  agentName: string;
  score: number;
  grade: LetterGrade;
}

export interface CreditRatingLeaderboard {
  asOf: string;
  entries: CreditRatingLeaderboardEntry[];
}

/** Benchmark: an agent trading 5+ times/day for 30 days = 150 trades is full score. */
const TRADE_FREQUENCY_BENCHMARK = 150;

/** Benchmark: average hold time of 1 hour (in ms) is optimal; longer = less score. */
const HOLD_TIME_BENCHMARK_MS = 60 * 60 * 1000;

/** Max hold time considered: 7 days. Beyond this → score 0 for hold time. */
const MAX_HOLD_TIME_MS = 7 * 24 * 60 * 60 * 1000;

function scoreToGrade(score: number): LetterGrade {
  if (score >= 90) return 'A+';
  if (score >= 80) return 'A';
  if (score >= 70) return 'B';
  if (score >= 60) return 'C';
  if (score >= 50) return 'D';
  return 'F';
}

export class CreditRatingService {
  /** Cached ratings: agentId → CreditRatingBreakdown */
  private cache: Map<string, CreditRatingBreakdown> = new Map();

  constructor(private readonly store: StateStore) {}

  /**
   * Compute a fresh credit rating for an agent.
   */
  calculateRating(agentId: string): CreditRatingBreakdown | null {
    const state = this.store.snapshot();
    const agent = state.agents[agentId];
    if (!agent) return null;

    const executions = Object.values(state.executions)
      .filter((ex) => ex.agentId === agentId && ex.status === 'filled')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    const intents = Object.values(state.tradeIntents)
      .filter((i) => i.agentId === agentId);

    // ── Factor 1: Win Rate (25%) ──────────────────────────────────────
    const closingTrades = executions.filter((ex) => ex.side === 'sell');
    const wins = closingTrades.filter((ex) => ex.realizedPnlUsd > 0).length;
    const winRate = closingTrades.length > 0 ? wins / closingTrades.length : 0;
    const winRateScore = winRate * 100;

    // ── Factor 2: Max Drawdown (25%) ──────────────────────────────────
    // Lower drawdown = higher score. 0% drawdown = 100, 100% drawdown = 0.
    let maxDrawdownPct = 0;
    if (executions.length > 0) {
      let cumulativePnl = 0;
      let peakEquity = agent.startingCapitalUsd;

      for (const ex of executions) {
        cumulativePnl += ex.realizedPnlUsd;
        const equity = agent.startingCapitalUsd + cumulativePnl;
        if (equity > peakEquity) peakEquity = equity;
        const dd = peakEquity > 0 ? (peakEquity - equity) / peakEquity : 0;
        if (dd > maxDrawdownPct) maxDrawdownPct = dd;
      }
    }
    const drawdownScore = Math.max(0, (1 - maxDrawdownPct) * 100);

    // ── Factor 3: Trade Frequency (15%) ──────────────────────────────
    const totalTrades = executions.length;
    const frequencyRatio = Math.min(totalTrades / TRADE_FREQUENCY_BENCHMARK, 1);
    const frequencyScore = frequencyRatio * 100;

    // ── Factor 4: Avg Hold Time (15%) ────────────────────────────────
    // Pair buys and sells chronologically to estimate hold times.
    const holdTimes: number[] = [];
    const buyTimestamps: Map<string, number[]> = new Map();

    for (const ex of executions) {
      if (ex.side === 'buy') {
        if (!buyTimestamps.has(ex.symbol)) {
          buyTimestamps.set(ex.symbol, []);
        }
        buyTimestamps.get(ex.symbol)!.push(new Date(ex.createdAt).getTime());
      } else if (ex.side === 'sell') {
        const buys = buyTimestamps.get(ex.symbol);
        if (buys && buys.length > 0) {
          const buyTime = buys.shift()!;
          const sellTime = new Date(ex.createdAt).getTime();
          holdTimes.push(sellTime - buyTime);
        }
      }
    }

    let holdTimeScore: number;
    if (holdTimes.length === 0) {
      holdTimeScore = 50; // neutral if no data
    } else {
      const avgHoldMs = holdTimes.reduce((a, b) => a + b, 0) / holdTimes.length;
      if (avgHoldMs <= HOLD_TIME_BENCHMARK_MS) {
        holdTimeScore = 100;
      } else if (avgHoldMs >= MAX_HOLD_TIME_MS) {
        holdTimeScore = 0;
      } else {
        // Linear interpolation between benchmark and max
        holdTimeScore = Math.max(0, (1 - (avgHoldMs - HOLD_TIME_BENCHMARK_MS) / (MAX_HOLD_TIME_MS - HOLD_TIME_BENCHMARK_MS)) * 100);
      }
    }

    // ── Factor 5: Risk Rejection Rate (20%) ──────────────────────────
    // Lower rejection rate = higher score.
    const totalRejections = Object.values(agent.riskRejectionsByReason)
      .reduce((sum, count) => sum + count, 0);
    const totalIntents = intents.length;
    const rejectionRate = totalIntents > 0 ? totalRejections / totalIntents : 0;
    const rejectionScore = Math.max(0, (1 - rejectionRate) * 100);

    // ── Build factors ────────────────────────────────────────────────
    const factors: RatingFactor[] = [
      {
        name: 'winRate',
        weight: 0.25,
        rawValue: Number((winRate * 100).toFixed(2)),
        normalizedScore: Number(winRateScore.toFixed(2)),
        weightedScore: Number((winRateScore * 0.25).toFixed(2)),
        description: `Win rate: ${(winRate * 100).toFixed(1)}% (${wins}/${closingTrades.length} closing trades)`,
      },
      {
        name: 'maxDrawdown',
        weight: 0.25,
        rawValue: Number((maxDrawdownPct * 100).toFixed(2)),
        normalizedScore: Number(drawdownScore.toFixed(2)),
        weightedScore: Number((drawdownScore * 0.25).toFixed(2)),
        description: `Max drawdown: ${(maxDrawdownPct * 100).toFixed(1)}%`,
      },
      {
        name: 'tradeFrequency',
        weight: 0.15,
        rawValue: totalTrades,
        normalizedScore: Number(frequencyScore.toFixed(2)),
        weightedScore: Number((frequencyScore * 0.15).toFixed(2)),
        description: `Total trades: ${totalTrades} (benchmark: ${TRADE_FREQUENCY_BENCHMARK})`,
      },
      {
        name: 'avgHoldTime',
        weight: 0.15,
        rawValue: holdTimes.length > 0
          ? Number((holdTimes.reduce((a, b) => a + b, 0) / holdTimes.length / 1000).toFixed(2))
          : 0,
        normalizedScore: Number(holdTimeScore.toFixed(2)),
        weightedScore: Number((holdTimeScore * 0.15).toFixed(2)),
        description: holdTimes.length > 0
          ? `Avg hold time: ${(holdTimes.reduce((a, b) => a + b, 0) / holdTimes.length / 1000).toFixed(0)}s`
          : 'No hold time data',
      },
      {
        name: 'riskRejectionRate',
        weight: 0.20,
        rawValue: Number((rejectionRate * 100).toFixed(2)),
        normalizedScore: Number(rejectionScore.toFixed(2)),
        weightedScore: Number((rejectionScore * 0.20).toFixed(2)),
        description: `Risk rejection rate: ${(rejectionRate * 100).toFixed(1)}% (${totalRejections}/${totalIntents} intents)`,
      },
    ];

    const totalScore = factors.reduce((sum, f) => sum + f.weightedScore, 0);
    const score = Number(Math.max(0, Math.min(100, totalScore)).toFixed(2));

    const breakdown: CreditRatingBreakdown = {
      agentId,
      score,
      grade: scoreToGrade(score),
      calculatedAt: isoNow(),
      factors,
    };

    // Cache the result
    this.cache.set(agentId, breakdown);

    return breakdown;
  }

  /**
   * Get a cached rating or compute fresh if not cached.
   */
  getRating(agentId: string): CreditRating | null {
    const cached = this.cache.get(agentId);
    if (cached) {
      return {
        agentId: cached.agentId,
        score: cached.score,
        grade: cached.grade,
        calculatedAt: cached.calculatedAt,
      };
    }

    const result = this.calculateRating(agentId);
    if (!result) return null;

    return {
      agentId: result.agentId,
      score: result.score,
      grade: result.grade,
      calculatedAt: result.calculatedAt,
    };
  }

  /**
   * Get detailed factor-by-factor breakdown.
   */
  getRatingBreakdown(agentId: string): CreditRatingBreakdown | null {
    const cached = this.cache.get(agentId);
    if (cached) return cached;
    return this.calculateRating(agentId);
  }

  /**
   * Get all ratings leaderboard sorted by score.
   */
  getAllRatings(): CreditRatingLeaderboard {
    const state = this.store.snapshot();
    const agents = Object.values(state.agents);

    const scored: Array<{ agentId: string; agentName: string; score: number; grade: LetterGrade }> = [];

    for (const agent of agents) {
      const rating = this.calculateRating(agent.id);
      if (rating) {
        scored.push({
          agentId: agent.id,
          agentName: agent.name,
          score: rating.score,
          grade: rating.grade,
        });
      }
    }

    scored.sort((a, b) => b.score - a.score);

    return {
      asOf: isoNow(),
      entries: scored.map((entry, index) => ({
        rank: index + 1,
        agentId: entry.agentId,
        agentName: entry.agentName,
        score: entry.score,
        grade: entry.grade,
      })),
    };
  }
}
