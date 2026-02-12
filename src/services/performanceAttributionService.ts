/**
 * Performance Attribution Service
 *
 * Provides detailed breakdown of what drives agent returns:
 * - Return decomposition (alpha vs beta vs residual)
 * - Factor attribution (momentum, value, volatility, size factors)
 * - Timing analysis (entry/exit timing quality)
 * - Strategy contribution (which strategy produced which returns)
 * - Sector/token exposure analysis
 * - Performance persistence (is good performance repeatable?)
 */

import { StateStore } from '../infra/storage/stateStore.js';
import { ExecutionRecord, Agent } from '../types.js';

/* ------------------------------------------------------------------ */
/*  Public interfaces                                                  */
/* ------------------------------------------------------------------ */

export interface ReturnDecomposition {
  agentId: string;
  asOf: string;
  totalReturnPct: number;
  alpha: number;
  beta: number;
  residual: number;
  marketReturnPct: number;
  riskFreeRate: number;
  informationRatio: number | null;
  trackingError: number | null;
}

export interface FactorExposure {
  factor: string;
  exposure: number;
  contribution: number;
  tStat: number | null;
}

export interface FactorAttribution {
  agentId: string;
  asOf: string;
  factors: FactorExposure[];
  rSquared: number;
  unexplainedReturn: number;
}

export interface TimingEntry {
  symbol: string;
  side: 'buy' | 'sell';
  executionPrice: number;
  optimalPrice: number;
  timingScore: number;
  slippagePct: number;
  executedAt: string;
}

export interface TimingAnalysis {
  agentId: string;
  asOf: string;
  overallTimingScore: number;
  avgEntryTimingScore: number;
  avgExitTimingScore: number;
  bestTimedTrade: TimingEntry | null;
  worstTimedTrade: TimingEntry | null;
  entries: TimingEntry[];
}

export interface StrategyContribution {
  strategyId: string;
  tradeCount: number;
  returnUsd: number;
  returnPct: number;
  winRate: number;
  avgReturnPerTrade: number;
  sharpeContribution: number;
}

export interface StrategyAttribution {
  agentId: string;
  asOf: string;
  strategies: StrategyContribution[];
  totalReturnUsd: number;
  bestStrategy: string | null;
  worstStrategy: string | null;
}

export interface TokenExposure {
  symbol: string;
  exposureUsd: number;
  exposurePct: number;
  returnUsd: number;
  returnContributionPct: number;
  tradeCount: number;
}

export interface ExposureAnalysis {
  agentId: string;
  asOf: string;
  tokens: TokenExposure[];
  concentrationIndex: number;
  topTokenByExposure: string | null;
  topTokenByReturn: string | null;
}

export interface PersistenceWindow {
  period: string;
  returnPct: number;
  winRate: number;
  tradeCount: number;
}

export interface PerformancePersistence {
  agentId: string;
  asOf: string;
  windows: PersistenceWindow[];
  autocorrelation: number | null;
  persistenceScore: number;
  isConsistent: boolean;
  streakCurrent: number;
  streakLongestWin: number;
  streakLongestLoss: number;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const RISK_FREE_RATE = 0.045; // 4.5% annualized
const ANNUALIZATION_FACTOR = Math.sqrt(252);

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function stdDev(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const variance = arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

function covariance(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  const ma = mean(a.slice(0, n));
  const mb = mean(b.slice(0, n));
  let cov = 0;
  for (let i = 0; i < n; i++) {
    cov += (a[i] - ma) * (b[i] - mb);
  }
  return cov / (n - 1);
}

function round(v: number, decimals = 6): number {
  return Number(v.toFixed(decimals));
}

function getFilledExecutions(store: StateStore, agentId: string): ExecutionRecord[] {
  const state = store.snapshot();
  return Object.values(state.executions)
    .filter((ex) => ex.agentId === agentId && ex.status === 'filled')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function getAgent(store: StateStore, agentId: string): Agent | null {
  const state = store.snapshot();
  return state.agents[agentId] ?? null;
}

function buildDailyReturns(executions: ExecutionRecord[], startingCapital: number): number[] {
  const dailyPnl = new Map<string, number>();
  for (const ex of executions) {
    const day = ex.createdAt.slice(0, 10);
    dailyPnl.set(day, (dailyPnl.get(day) ?? 0) + ex.realizedPnlUsd);
  }
  const days = Array.from(dailyPnl.entries()).sort(([a], [b]) => a.localeCompare(b));
  let equity = startingCapital;
  const returns: number[] = [];
  for (const [, pnl] of days) {
    if (equity > 0) {
      returns.push(pnl / equity);
    } else {
      returns.push(0);
    }
    equity += pnl;
  }
  return returns;
}

function buildMarketReturns(store: StateStore): number[] {
  const state = store.snapshot();
  // Use all price history to compute a daily market index return
  const allPriceHistory = state.marketPriceHistoryUsd ?? {};
  const dayPriceMap = new Map<string, number[]>();

  for (const [, points] of Object.entries(allPriceHistory)) {
    for (const pt of points) {
      const day = pt.ts.slice(0, 10);
      const arr = dayPriceMap.get(day) ?? [];
      arr.push(pt.priceUsd);
      dayPriceMap.set(day, arr);
    }
  }

  const days = Array.from(dayPriceMap.entries()).sort(([a], [b]) => a.localeCompare(b));
  const avgPrices = days.map(([, prices]) => mean(prices));

  const returns: number[] = [];
  for (let i = 1; i < avgPrices.length; i++) {
    if (avgPrices[i - 1] > 0) {
      returns.push((avgPrices[i] - avgPrices[i - 1]) / avgPrices[i - 1]);
    } else {
      returns.push(0);
    }
  }
  return returns;
}

/* ------------------------------------------------------------------ */
/*  Service                                                            */
/* ------------------------------------------------------------------ */

export class PerformanceAttributionService {
  constructor(private readonly store: StateStore) {}

  /* ── Return Decomposition ────────────────────────────────────────── */

  computeReturnDecomposition(agentId: string): ReturnDecomposition | null {
    const agent = getAgent(this.store, agentId);
    if (!agent) return null;

    const executions = getFilledExecutions(this.store, agentId);
    const dailyReturns = buildDailyReturns(executions, agent.startingCapitalUsd);
    const marketReturns = buildMarketReturns(this.store);

    const totalReturnPct = dailyReturns.length > 0
      ? round(dailyReturns.reduce((s, r) => s * (1 + r), 1) - 1, 6)
      : 0;

    const mktReturn = marketReturns.length > 0
      ? round(marketReturns.reduce((s, r) => s * (1 + r), 1) - 1, 6)
      : 0;

    // Compute beta via covariance(agent, market) / variance(market)
    const minLen = Math.min(dailyReturns.length, marketReturns.length);
    let beta = 0;
    if (minLen >= 2) {
      const agentSlice = dailyReturns.slice(0, minLen);
      const marketSlice = marketReturns.slice(0, minLen);
      const marketVar = covariance(marketSlice, marketSlice);
      if (marketVar > 0) {
        beta = round(covariance(agentSlice, marketSlice) / marketVar, 6);
      }
    }

    const dailyRiskFree = RISK_FREE_RATE / 252;
    const expectedReturn = dailyRiskFree * dailyReturns.length + beta * (mktReturn - dailyRiskFree * dailyReturns.length);
    const alpha = round(totalReturnPct - expectedReturn, 6);
    const residual = round(totalReturnPct - alpha - beta * mktReturn, 6);

    // Information ratio: alpha / tracking error
    let trackingError: number | null = null;
    let informationRatio: number | null = null;
    if (minLen >= 2) {
      const agentSlice = dailyReturns.slice(0, minLen);
      const marketSlice = marketReturns.slice(0, minLen);
      const activeReturns = agentSlice.map((r, i) => r - marketSlice[i]);
      const te = stdDev(activeReturns) * ANNUALIZATION_FACTOR;
      trackingError = round(te, 6);
      if (te > 0) {
        informationRatio = round((alpha / te), 6);
      }
    }

    return {
      agentId,
      asOf: new Date().toISOString(),
      totalReturnPct,
      alpha,
      beta,
      residual,
      marketReturnPct: mktReturn,
      riskFreeRate: RISK_FREE_RATE,
      informationRatio,
      trackingError,
    };
  }

  /* ── Factor Attribution ──────────────────────────────────────────── */

  computeFactorAttribution(agentId: string): FactorAttribution | null {
    const agent = getAgent(this.store, agentId);
    if (!agent) return null;

    const executions = getFilledExecutions(this.store, agentId);
    const dailyReturns = buildDailyReturns(executions, agent.startingCapitalUsd);

    // Synthetic factor construction from execution data
    const factors: FactorExposure[] = [];
    const n = dailyReturns.length;

    // Momentum factor: autocovariance of returns (lag-1)
    const momentumReturns: number[] = [];
    for (let i = 1; i < n; i++) {
      momentumReturns.push(dailyReturns[i - 1]);
    }
    const momentumExposure = n >= 2 ? covariance(dailyReturns.slice(1), momentumReturns) / Math.max(covariance(momentumReturns, momentumReturns), 1e-10) : 0;
    const momentumContribution = momentumExposure * mean(momentumReturns);

    factors.push({
      factor: 'momentum',
      exposure: round(momentumExposure),
      contribution: round(momentumContribution),
      tStat: n >= 3 ? round(momentumExposure / Math.max(stdDev(dailyReturns) / Math.sqrt(n), 1e-10)) : null,
    });

    // Volatility factor: exposure to abs-return scaled
    const volReturns = dailyReturns.map((r) => Math.abs(r));
    const volExposure = n >= 2 ? covariance(dailyReturns, volReturns) / Math.max(covariance(volReturns, volReturns), 1e-10) : 0;
    const volContribution = volExposure * mean(volReturns);

    factors.push({
      factor: 'volatility',
      exposure: round(volExposure),
      contribution: round(volContribution),
      tStat: n >= 3 ? round(volExposure / Math.max(stdDev(dailyReturns) / Math.sqrt(n), 1e-10)) : null,
    });

    // Size factor: larger trades as proxy
    const tradesByDay = new Map<string, number[]>();
    for (const ex of executions) {
      const day = ex.createdAt.slice(0, 10);
      const arr = tradesByDay.get(day) ?? [];
      arr.push(ex.grossNotionalUsd);
      tradesByDay.set(day, arr);
    }
    const sizeFactorValues = Array.from(tradesByDay.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, amounts]) => mean(amounts));

    const sizeLen = Math.min(dailyReturns.length, sizeFactorValues.length);
    const sizeExposure = sizeLen >= 2
      ? covariance(dailyReturns.slice(0, sizeLen), sizeFactorValues.slice(0, sizeLen)) / Math.max(covariance(sizeFactorValues.slice(0, sizeLen), sizeFactorValues.slice(0, sizeLen)), 1e-10)
      : 0;
    const sizeContribution = sizeExposure * mean(sizeFactorValues);

    factors.push({
      factor: 'size',
      exposure: round(sizeExposure),
      contribution: round(sizeContribution),
      tStat: sizeLen >= 3 ? round(sizeExposure / Math.max(stdDev(dailyReturns.slice(0, sizeLen)) / Math.sqrt(sizeLen), 1e-10)) : null,
    });

    // Value factor: mean-reversion tendency
    const valueReturns = dailyReturns.map((r) => -r); // contrarian
    const valueExposure = n >= 2 ? covariance(dailyReturns, valueReturns) / Math.max(covariance(valueReturns, valueReturns), 1e-10) : 0;
    const valueContribution = valueExposure * mean(valueReturns);

    factors.push({
      factor: 'value',
      exposure: round(valueExposure),
      contribution: round(valueContribution),
      tStat: n >= 3 ? round(valueExposure / Math.max(stdDev(dailyReturns) / Math.sqrt(n), 1e-10)) : null,
    });

    // R-squared: proportion of variance explained
    const totalVar = n >= 2 ? covariance(dailyReturns, dailyReturns) : 0;
    const explained = factors.reduce((s, f) => s + Math.abs(f.contribution), 0);
    const totalReturn = mean(dailyReturns) * n;
    const rSquared = totalReturn !== 0 ? round(Math.min(1, Math.abs(explained / totalReturn)), 4) : 0;
    const unexplainedReturn = round(totalReturn - explained, 6);

    return {
      agentId,
      asOf: new Date().toISOString(),
      factors,
      rSquared,
      unexplainedReturn,
    };
  }

  /* ── Timing Analysis ──────────────────────────────────────────────── */

  computeTimingAnalysis(agentId: string): TimingAnalysis | null {
    const agent = getAgent(this.store, agentId);
    if (!agent) return null;

    const executions = getFilledExecutions(this.store, agentId);
    const state = this.store.snapshot();
    const entries: TimingEntry[] = [];

    for (const ex of executions) {
      const priceHistory = state.marketPriceHistoryUsd[ex.symbol] ?? [];
      const exTs = new Date(ex.createdAt).getTime();

      // Look for prices in a window around execution time (±24h)
      const windowMs = 24 * 60 * 60 * 1000;
      const nearbyPrices = priceHistory
        .filter((p) => {
          const pTs = new Date(p.ts).getTime();
          return Math.abs(pTs - exTs) <= windowMs;
        })
        .map((p) => p.priceUsd);

      let optimalPrice: number;
      if (nearbyPrices.length > 0) {
        optimalPrice = ex.side === 'buy'
          ? Math.min(...nearbyPrices) // Best buy = lowest price
          : Math.max(...nearbyPrices); // Best sell = highest price
      } else {
        optimalPrice = ex.priceUsd;
      }

      const slippagePct = optimalPrice > 0
        ? round(Math.abs(ex.priceUsd - optimalPrice) / optimalPrice, 6)
        : 0;

      // Timing score: 1.0 = perfect, 0.0 = worst possible
      let timingScore: number;
      if (nearbyPrices.length < 2) {
        timingScore = 0.5; // neutral if no comparison data
      } else {
        const worst = ex.side === 'buy'
          ? Math.max(...nearbyPrices)
          : Math.min(...nearbyPrices);
        const range = Math.abs(worst - optimalPrice);
        if (range > 0) {
          const distFromOptimal = Math.abs(ex.priceUsd - optimalPrice);
          timingScore = round(1 - distFromOptimal / range, 4);
        } else {
          timingScore = 1;
        }
      }

      entries.push({
        symbol: ex.symbol,
        side: ex.side,
        executionPrice: ex.priceUsd,
        optimalPrice: round(optimalPrice),
        timingScore,
        slippagePct,
        executedAt: ex.createdAt,
      });
    }

    const buyEntries = entries.filter((e) => e.side === 'buy');
    const sellEntries = entries.filter((e) => e.side === 'sell');

    const avgEntryTimingScore = buyEntries.length > 0 ? round(mean(buyEntries.map((e) => e.timingScore)), 4) : 0;
    const avgExitTimingScore = sellEntries.length > 0 ? round(mean(sellEntries.map((e) => e.timingScore)), 4) : 0;
    const overallTimingScore = entries.length > 0 ? round(mean(entries.map((e) => e.timingScore)), 4) : 0;

    const sorted = [...entries].sort((a, b) => b.timingScore - a.timingScore);
    const bestTimedTrade = sorted.length > 0 ? sorted[0] : null;
    const worstTimedTrade = sorted.length > 0 ? sorted[sorted.length - 1] : null;

    return {
      agentId,
      asOf: new Date().toISOString(),
      overallTimingScore,
      avgEntryTimingScore,
      avgExitTimingScore,
      bestTimedTrade,
      worstTimedTrade,
      entries,
    };
  }

  /* ── Strategy Contribution ────────────────────────────────────────── */

  computeStrategyAttribution(agentId: string): StrategyAttribution | null {
    const agent = getAgent(this.store, agentId);
    if (!agent) return null;

    const executions = getFilledExecutions(this.store, agentId);
    const state = this.store.snapshot();

    // Group executions by strategy
    // We don't have per-execution strategy tags, so use agent's current strategy
    // and also check if executions span multiple strategy periods via agent updatedAt
    const strategyMap = new Map<string, ExecutionRecord[]>();
    for (const ex of executions) {
      // Check if there's meta with strategyId, otherwise use agent's current
      const sid = (ex as any).meta?.strategyId ?? agent.strategyId;
      const arr = strategyMap.get(sid) ?? [];
      arr.push(ex);
      strategyMap.set(sid, arr);
    }

    const strategies: StrategyContribution[] = [];
    let totalReturnUsd = 0;

    for (const [strategyId, execs] of strategyMap) {
      const returnUsd = round(execs.reduce((s, e) => s + e.realizedPnlUsd, 0), 4);
      const closingTrades = execs.filter((e) => e.side === 'sell' && e.realizedPnlUsd !== 0);
      const wins = closingTrades.filter((e) => e.realizedPnlUsd > 0).length;
      const winRate = closingTrades.length > 0 ? round(wins / closingTrades.length, 4) : 0;
      const avgReturnPerTrade = execs.length > 0 ? round(returnUsd / execs.length, 4) : 0;
      const returnPct = agent.startingCapitalUsd > 0 ? round(returnUsd / agent.startingCapitalUsd, 6) : 0;

      // Sharpe contribution: strategy's daily returns / std
      const dailyPnl = new Map<string, number>();
      for (const e of execs) {
        const day = e.createdAt.slice(0, 10);
        dailyPnl.set(day, (dailyPnl.get(day) ?? 0) + e.realizedPnlUsd);
      }
      const dailyValues = Array.from(dailyPnl.values());
      const m = mean(dailyValues);
      const sd = stdDev(dailyValues);
      const sharpeContribution = sd > 0 ? round((m / sd) * ANNUALIZATION_FACTOR, 4) : 0;

      strategies.push({
        strategyId,
        tradeCount: execs.length,
        returnUsd,
        returnPct,
        winRate,
        avgReturnPerTrade,
        sharpeContribution,
      });

      totalReturnUsd += returnUsd;
    }

    const sorted = [...strategies].sort((a, b) => b.returnUsd - a.returnUsd);

    return {
      agentId,
      asOf: new Date().toISOString(),
      strategies,
      totalReturnUsd: round(totalReturnUsd, 4),
      bestStrategy: sorted.length > 0 ? sorted[0].strategyId : null,
      worstStrategy: sorted.length > 0 ? sorted[sorted.length - 1].strategyId : null,
    };
  }

  /* ── Token/Sector Exposure ────────────────────────────────────────── */

  computeExposureAnalysis(agentId: string): ExposureAnalysis | null {
    const agent = getAgent(this.store, agentId);
    if (!agent) return null;

    const state = this.store.snapshot();
    const executions = getFilledExecutions(this.store, agentId);

    const tokenMap = new Map<string, { exposureUsd: number; returnUsd: number; tradeCount: number }>();

    for (const ex of executions) {
      const entry = tokenMap.get(ex.symbol) ?? { exposureUsd: 0, returnUsd: 0, tradeCount: 0 };
      entry.exposureUsd += ex.grossNotionalUsd;
      entry.returnUsd += ex.realizedPnlUsd;
      entry.tradeCount += 1;
      tokenMap.set(ex.symbol, entry);
    }

    // Also include current positions
    for (const [symbol, pos] of Object.entries(agent.positions)) {
      const px = state.marketPricesUsd[symbol] ?? pos.avgEntryPriceUsd;
      const currentExposure = pos.quantity * px;
      const entry = tokenMap.get(symbol) ?? { exposureUsd: 0, returnUsd: 0, tradeCount: 0 };
      entry.exposureUsd += currentExposure;
      tokenMap.set(symbol, entry);
    }

    const totalExposure = Array.from(tokenMap.values()).reduce((s, t) => s + t.exposureUsd, 0);
    const totalReturn = Array.from(tokenMap.values()).reduce((s, t) => s + t.returnUsd, 0);

    const tokens: TokenExposure[] = Array.from(tokenMap.entries())
      .map(([symbol, data]) => ({
        symbol,
        exposureUsd: round(data.exposureUsd, 4),
        exposurePct: totalExposure > 0 ? round(data.exposureUsd / totalExposure, 4) : 0,
        returnUsd: round(data.returnUsd, 4),
        returnContributionPct: totalReturn !== 0 ? round(data.returnUsd / Math.abs(totalReturn), 4) : 0,
        tradeCount: data.tradeCount,
      }))
      .sort((a, b) => b.exposureUsd - a.exposureUsd);

    // Herfindahl-Hirschman Index for concentration
    const concentrationIndex = tokens.length > 0
      ? round(tokens.reduce((s, t) => s + t.exposurePct ** 2, 0), 4)
      : 0;

    const topByExposure = tokens.length > 0 ? tokens[0].symbol : null;
    const sortedByReturn = [...tokens].sort((a, b) => b.returnUsd - a.returnUsd);
    const topByReturn = sortedByReturn.length > 0 ? sortedByReturn[0].symbol : null;

    return {
      agentId,
      asOf: new Date().toISOString(),
      tokens,
      concentrationIndex,
      topTokenByExposure: topByExposure,
      topTokenByReturn: topByReturn,
    };
  }

  /* ── Performance Persistence ──────────────────────────────────────── */

  computePersistence(agentId: string): PerformancePersistence | null {
    const agent = getAgent(this.store, agentId);
    if (!agent) return null;

    const executions = getFilledExecutions(this.store, agentId);

    // Build weekly windows
    const weeklyMap = new Map<string, { pnl: number; wins: number; total: number }>();
    for (const ex of executions) {
      const d = new Date(ex.createdAt);
      const day = d.getDay();
      const diff = d.getDate() - day + (day === 0 ? -6 : 1);
      d.setDate(diff);
      const weekKey = d.toISOString().slice(0, 10);

      const entry = weeklyMap.get(weekKey) ?? { pnl: 0, wins: 0, total: 0 };
      entry.pnl += ex.realizedPnlUsd;
      if (ex.realizedPnlUsd > 0) entry.wins += 1;
      entry.total += 1;
      weeklyMap.set(weekKey, entry);
    }

    const weeks = Array.from(weeklyMap.entries())
      .sort(([a], [b]) => a.localeCompare(b));

    const windows: PersistenceWindow[] = weeks.map(([period, data]) => ({
      period,
      returnPct: agent.startingCapitalUsd > 0 ? round(data.pnl / agent.startingCapitalUsd, 6) : 0,
      winRate: data.total > 0 ? round(data.wins / data.total, 4) : 0,
      tradeCount: data.total,
    }));

    // Autocorrelation of weekly returns
    const weeklyReturns = windows.map((w) => w.returnPct);
    let autocorrelation: number | null = null;
    if (weeklyReturns.length >= 3) {
      const r1 = weeklyReturns.slice(0, -1);
      const r2 = weeklyReturns.slice(1);
      const cov = covariance(r1, r2);
      const var1 = covariance(r1, r1);
      autocorrelation = var1 > 0 ? round(cov / var1, 4) : 0;
    }

    // Win/loss streak analysis
    let currentStreak = 0;
    let longestWin = 0;
    let longestLoss = 0;
    let currentType: 'win' | 'loss' | null = null;

    for (const w of windows) {
      if (w.returnPct > 0) {
        if (currentType === 'win') {
          currentStreak++;
        } else {
          currentStreak = 1;
          currentType = 'win';
        }
        longestWin = Math.max(longestWin, currentStreak);
      } else if (w.returnPct < 0) {
        if (currentType === 'loss') {
          currentStreak++;
        } else {
          currentStreak = 1;
          currentType = 'loss';
        }
        longestLoss = Math.max(longestLoss, currentStreak);
      } else {
        currentStreak = 0;
        currentType = null;
      }
    }

    // Persistence score: weighted combination of autocorrelation + win consistency
    const avgWinRate = windows.length > 0 ? mean(windows.map((w) => w.winRate)) : 0;
    const winRateStd = windows.length >= 2 ? stdDev(windows.map((w) => w.winRate)) : 1;
    const consistencyScore = winRateStd < 1 ? 1 - winRateStd : 0;
    const autoScore = autocorrelation !== null ? Math.max(0, autocorrelation) : 0;
    const persistenceScore = round(0.5 * consistencyScore + 0.5 * autoScore, 4);
    const isConsistent = persistenceScore >= 0.3 && windows.length >= 3;

    return {
      agentId,
      asOf: new Date().toISOString(),
      windows,
      autocorrelation,
      persistenceScore,
      isConsistent,
      streakCurrent: currentStreak,
      streakLongestWin: longestWin,
      streakLongestLoss: longestLoss,
    };
  }
}
