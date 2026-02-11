/**
 * Agent reputation types.
 *
 * Reputation scores range 0–1000 and are composed of weighted factors:
 * trade success rate, risk discipline, consistency (Sharpe contribution),
 * uptime, and receipt verification rate.
 */

export interface ReputationBreakdown {
  /** Win rate component (0–1000 scale, weight 30%) */
  tradeSuccessRate: number;
  /** Low risk-rejection rate = good discipline (0–1000, weight 20%) */
  riskDiscipline: number;
  /** Sharpe-ratio contribution (0–1000, weight 20%) */
  consistency: number;
  /** Time since agent registration relative to 30-day benchmark (0–1000, weight 15%) */
  uptime: number;
  /** Receipt verification pass rate (0–1000, weight 15%) */
  receiptVerification: number;
}

export interface ReputationScore {
  agentId: string;
  score: number;
  breakdown: ReputationBreakdown;
  calculatedAt: string;
}

export interface ReputationLeaderboardEntry {
  rank: number;
  agentId: string;
  agentName: string;
  score: number;
}

export interface ReputationLeaderboard {
  asOf: string;
  entries: ReputationLeaderboardEntry[];
}
