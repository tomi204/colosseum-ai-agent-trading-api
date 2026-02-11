/**
 * Portfolio analytics service.
 *
 * Provides performance metrics for individual agents:
 * - Sharpe ratio
 * - Sortino ratio
 * - Win rate & avg win/loss ratio
 * - Max drawdown duration
 * - Daily/weekly P&L summaries
 */

import { StateStore } from '../infra/storage/stateStore.js';
import { ExecutionRecord } from '../types.js';

export interface PnLSummary {
  period: string;
  pnlUsd: number;
  tradeCount: number;
}

export interface PortfolioAnalytics {
  agentId: string;
  asOf: string;
  totalTrades: number;
  winCount: number;
  lossCount: number;
  winRate: number;
  avgWinUsd: number;
  avgLossUsd: number;
  winLossRatio: number;
  sharpeRatio: number | null;
  sortinoRatio: number | null;
  maxDrawdownPct: number;
  maxDrawdownDurationMs: number;
  totalRealizedPnlUsd: number;
  dailyPnl: PnLSummary[];
  weeklyPnl: PnLSummary[];
}

/**
 * Annualization factor: assume 252 trading days.
 */
const ANNUALIZATION_FACTOR = Math.sqrt(252);

function computeSharpeRatio(dailyReturns: number[]): number | null {
  if (dailyReturns.length < 2) return null;

  const mean = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
  const variance = dailyReturns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (dailyReturns.length - 1);
  const stdDev = Math.sqrt(variance);

  if (stdDev === 0) return null;

  return Number(((mean / stdDev) * ANNUALIZATION_FACTOR).toFixed(4));
}

function computeSortinoRatio(dailyReturns: number[]): number | null {
  if (dailyReturns.length < 2) return null;

  const mean = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
  const negativeReturns = dailyReturns.filter((r) => r < 0);

  if (negativeReturns.length === 0) return null;

  const downsideVariance = negativeReturns.reduce((sum, r) => sum + r ** 2, 0) / negativeReturns.length;
  const downsideDev = Math.sqrt(downsideVariance);

  if (downsideDev === 0) return null;

  return Number(((mean / downsideDev) * ANNUALIZATION_FACTOR).toFixed(4));
}

function isoWeekKey(date: Date): string {
  // Get the ISO week start (Monday).
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  return d.toISOString().slice(0, 10);
}

export class AnalyticsService {
  constructor(private readonly store: StateStore) {}

  computeAnalytics(agentId: string): PortfolioAnalytics | null {
    const state = this.store.snapshot();
    const agent = state.agents[agentId];
    if (!agent) return null;

    // Gather filled executions for this agent, sorted by time.
    const executions = Object.values(state.executions)
      .filter((ex) => ex.agentId === agentId && ex.status === 'filled')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    const totalTrades = executions.length;

    // Win/loss analysis: a "trade" is a sell with realizedPnl.
    const closingTrades = executions.filter((ex) => ex.side === 'sell' && ex.realizedPnlUsd !== 0);
    const wins = closingTrades.filter((ex) => ex.realizedPnlUsd > 0);
    const losses = closingTrades.filter((ex) => ex.realizedPnlUsd < 0);

    const winCount = wins.length;
    const lossCount = losses.length;
    const winRate = closingTrades.length > 0
      ? Number((winCount / closingTrades.length).toFixed(4))
      : 0;

    const avgWinUsd = winCount > 0
      ? Number((wins.reduce((s, e) => s + e.realizedPnlUsd, 0) / winCount).toFixed(4))
      : 0;

    const avgLossUsd = lossCount > 0
      ? Number((Math.abs(losses.reduce((s, e) => s + e.realizedPnlUsd, 0)) / lossCount).toFixed(4))
      : 0;

    const winLossRatio = avgLossUsd > 0
      ? Number((avgWinUsd / avgLossUsd).toFixed(4))
      : avgWinUsd > 0 ? Infinity : 0;

    // Daily P&L aggregation.
    const dailyMap = new Map<string, { pnlUsd: number; tradeCount: number }>();
    for (const ex of executions) {
      const day = ex.createdAt.slice(0, 10);
      const entry = dailyMap.get(day) ?? { pnlUsd: 0, tradeCount: 0 };
      entry.pnlUsd += ex.realizedPnlUsd;
      entry.tradeCount += 1;
      dailyMap.set(day, entry);
    }

    const dailyPnl: PnLSummary[] = Array.from(dailyMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([period, data]) => ({
        period,
        pnlUsd: Number(data.pnlUsd.toFixed(4)),
        tradeCount: data.tradeCount,
      }));

    // Weekly P&L aggregation.
    const weeklyMap = new Map<string, { pnlUsd: number; tradeCount: number }>();
    for (const ex of executions) {
      const week = isoWeekKey(new Date(ex.createdAt));
      const entry = weeklyMap.get(week) ?? { pnlUsd: 0, tradeCount: 0 };
      entry.pnlUsd += ex.realizedPnlUsd;
      entry.tradeCount += 1;
      weeklyMap.set(week, entry);
    }

    const weeklyPnl: PnLSummary[] = Array.from(weeklyMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([period, data]) => ({
        period,
        pnlUsd: Number(data.pnlUsd.toFixed(4)),
        tradeCount: data.tradeCount,
      }));

    // Daily returns for ratio calculations.
    const dailyReturns = dailyPnl.map((d) => d.pnlUsd);

    const sharpeRatio = computeSharpeRatio(dailyReturns);
    const sortinoRatio = computeSortinoRatio(dailyReturns);

    // Max drawdown and duration from equity curve.
    const { maxDrawdownPct, maxDrawdownDurationMs } = this.computeDrawdownMetrics(executions, agent.startingCapitalUsd);

    const totalRealizedPnlUsd = Number(agent.realizedPnlUsd.toFixed(4));

    return {
      agentId,
      asOf: new Date().toISOString(),
      totalTrades,
      winCount,
      lossCount,
      winRate,
      avgWinUsd,
      avgLossUsd,
      winLossRatio: winLossRatio === Infinity ? -1 : winLossRatio,  // JSON-safe
      sharpeRatio,
      sortinoRatio,
      maxDrawdownPct,
      maxDrawdownDurationMs,
      totalRealizedPnlUsd,
      dailyPnl,
      weeklyPnl,
    };
  }

  private computeDrawdownMetrics(
    executions: ExecutionRecord[],
    startingCapital: number,
  ): { maxDrawdownPct: number; maxDrawdownDurationMs: number } {
    if (executions.length === 0) {
      return { maxDrawdownPct: 0, maxDrawdownDurationMs: 0 };
    }

    // Build equity curve from cumulative P&L.
    let cumulativePnl = 0;
    const equityCurve: Array<{ ts: number; equity: number }> = [];

    for (const ex of executions) {
      cumulativePnl += ex.realizedPnlUsd;
      equityCurve.push({
        ts: new Date(ex.createdAt).getTime(),
        equity: startingCapital + cumulativePnl,
      });
    }

    let peak = startingCapital;
    let maxDrawdownPct = 0;
    let drawdownStartMs = 0;
    let maxDrawdownDurationMs = 0;
    let inDrawdown = false;

    for (const point of equityCurve) {
      if (point.equity >= peak) {
        if (inDrawdown) {
          const duration = point.ts - drawdownStartMs;
          maxDrawdownDurationMs = Math.max(maxDrawdownDurationMs, duration);
          inDrawdown = false;
        }
        peak = point.equity;
      } else {
        if (!inDrawdown) {
          drawdownStartMs = point.ts;
          inDrawdown = true;
        }
        const dd = (peak - point.equity) / peak;
        maxDrawdownPct = Math.max(maxDrawdownPct, dd);
      }
    }

    // If still in drawdown at the end.
    if (inDrawdown && equityCurve.length > 0) {
      const lastTs = equityCurve[equityCurve.length - 1].ts;
      maxDrawdownDurationMs = Math.max(maxDrawdownDurationMs, lastTs - drawdownStartMs);
    }

    return {
      maxDrawdownPct: Number(maxDrawdownPct.toFixed(6)),
      maxDrawdownDurationMs,
    };
  }
}
