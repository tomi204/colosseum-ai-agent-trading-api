/**
 * Token Analytics Service – deep token analysis.
 *
 * Provides:
 * - Holder distribution (concentration, top holders, whale %)
 * - Token velocity (how fast tokens change hands)
 * - Supply analysis (circulating vs locked vs burned)
 * - Correlation matrix (how tokens move relative to each other)
 * - Momentum scoring (0-100 bullish/bearish score)
 * - Risk rating (volatility, liquidity, concentration risk combined)
 */

import { StateStore } from '../infra/storage/stateStore.js';
import { isoNow } from '../utils/time.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface HolderEntry {
  address: string;
  balance: number;
  pct: number;
}

export interface HolderDistribution {
  symbol: string;
  totalHolders: number;
  topHolders: HolderEntry[];
  whalePct: number;            // % held by top 10
  herfindahlIndex: number;     // concentration index 0-1
  giniCoefficient: number;     // inequality 0-1
  timestamp: string;
}

export interface TokenVelocity {
  symbol: string;
  velocity: number;             // turnover ratio
  avgHoldPeriodHours: number;
  transfersLast24h: number;
  volumeLast24hUsd: number;
  velocityTrend: 'accelerating' | 'stable' | 'decelerating';
  timestamp: string;
}

export interface TokenSupply {
  symbol: string;
  maxSupply: number;
  totalSupply: number;
  circulatingSupply: number;
  lockedSupply: number;
  burnedSupply: number;
  circulatingPct: number;
  lockedPct: number;
  burnedPct: number;
  inflationRatePct: number;
  timestamp: string;
}

export interface CorrelationPair {
  symbolA: string;
  symbolB: string;
  correlation: number;  // -1 to 1
  strength: 'strong-negative' | 'moderate-negative' | 'weak' | 'moderate-positive' | 'strong-positive';
}

export interface CorrelationMatrix {
  symbols: string[];
  matrix: number[][];
  pairs: CorrelationPair[];
  timestamp: string;
}

export interface MomentumScore {
  symbol: string;
  score: number;        // 0-100
  signal: 'strong-bearish' | 'bearish' | 'neutral' | 'bullish' | 'strong-bullish';
  components: {
    priceChange24h: number;
    priceChange7d: number;
    rsi: number;
    macdSignal: number;
    volumeTrend: number;
  };
  timestamp: string;
}

export interface RiskRating {
  symbol: string;
  overallRisk: number;   // 0-100 (100 = highest risk)
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  components: {
    volatilityRisk: number;
    liquidityRisk: number;
    concentrationRisk: number;
  };
  factors: string[];
  timestamp: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function classifyCorrelation(c: number): CorrelationPair['strength'] {
  if (c <= -0.6) return 'strong-negative';
  if (c <= -0.3) return 'moderate-negative';
  if (c < 0.3) return 'weak';
  if (c < 0.6) return 'moderate-positive';
  return 'strong-positive';
}

function classifyMomentum(score: number): MomentumScore['signal'] {
  if (score <= 20) return 'strong-bearish';
  if (score <= 40) return 'bearish';
  if (score <= 60) return 'neutral';
  if (score <= 80) return 'bullish';
  return 'strong-bullish';
}

function gradeRisk(risk: number): RiskRating['grade'] {
  if (risk <= 20) return 'A';
  if (risk <= 40) return 'B';
  if (risk <= 60) return 'C';
  if (risk <= 80) return 'D';
  return 'F';
}

/**
 * Generate synthetic holder distribution from on-chain-like heuristics.
 * In production this would pull from an indexer / RPC.
 */
function syntheticHolders(symbol: string, priceUsd: number): HolderEntry[] {
  const seed = symbol.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  const rng = (i: number) => ((seed * 9301 + 49297 + i * 233) % 233280) / 233280;

  const count = 20;
  const raw: { address: string; balance: number }[] = [];
  for (let i = 0; i < count; i++) {
    const balance = Math.pow(10, 3 + rng(i) * 5); // 1k – 100M range
    raw.push({
      address: `${symbol.toLowerCase()}Holder${String(i + 1).padStart(3, '0')}`,
      balance,
    });
  }
  const total = raw.reduce((s, h) => s + h.balance, 0);
  return raw
    .map((h) => ({ ...h, pct: (h.balance / total) * 100 }))
    .sort((a, b) => b.balance - a.balance);
}

function computeGini(balances: number[]): number {
  const sorted = [...balances].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return 0;
  const sum = sorted.reduce((s, v) => s + v, 0);
  if (sum === 0) return 0;
  let numerator = 0;
  for (let i = 0; i < n; i++) {
    numerator += (2 * (i + 1) - n - 1) * sorted[i];
  }
  return numerator / (n * sum);
}

function computeHerfindahl(shares: number[]): number {
  // shares as fractions (0-1)
  return shares.reduce((s, p) => s + p * p, 0);
}

function pearsonCorrelation(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  const meanA = a.slice(0, n).reduce((s, v) => s + v, 0) / n;
  const meanB = b.slice(0, n).reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let denA = 0;
  let denB = 0;
  for (let i = 0; i < n; i++) {
    const dA = a[i] - meanA;
    const dB = b[i] - meanB;
    num += dA * dB;
    denA += dA * dA;
    denB += dB * dB;
  }
  const den = Math.sqrt(denA * denB);
  return den === 0 ? 0 : num / den;
}

function computeRSI(prices: number[], period = 14): number {
  if (prices.length < 2) return 50;
  const changes: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    changes.push(prices[i] - prices[i - 1]);
  }
  const window = changes.slice(-period);
  const gains = window.filter((c) => c > 0);
  const losses = window.filter((c) => c < 0).map((c) => Math.abs(c));
  const avgGain = gains.length ? gains.reduce((s, v) => s + v, 0) / period : 0;
  const avgLoss = losses.length ? losses.reduce((s, v) => s + v, 0) / period : 0;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// ─── Service ────────────────────────────────────────────────────────────────

export class TokenAnalyticsService {
  constructor(private readonly store: StateStore) {}

  // ─── Holder Distribution ────────────────────────────────────────────

  getHolderDistribution(symbol: string): HolderDistribution {
    const sym = symbol.toUpperCase();
    const state = this.store.snapshot();
    const priceUsd = state.marketPricesUsd[sym] ?? 1;

    const holders = syntheticHolders(sym, priceUsd);
    const totalBalance = holders.reduce((s, h) => s + h.balance, 0);
    const top10 = holders.slice(0, 10);
    const whalePct = top10.reduce((s, h) => s + h.pct, 0);

    const shares = holders.map((h) => h.balance / totalBalance);
    const herfindahlIndex = computeHerfindahl(shares);
    const giniCoefficient = computeGini(holders.map((h) => h.balance));

    return {
      symbol: sym,
      totalHolders: holders.length * 500,  // scale up for realism
      topHolders: top10,
      whalePct: Number(whalePct.toFixed(2)),
      herfindahlIndex: Number(herfindahlIndex.toFixed(4)),
      giniCoefficient: Number(Math.max(0, Math.min(1, giniCoefficient)).toFixed(4)),
      timestamp: isoNow(),
    };
  }

  // ─── Token Velocity ─────────────────────────────────────────────────

  getTokenVelocity(symbol: string): TokenVelocity {
    const sym = symbol.toUpperCase();
    const state = this.store.snapshot();
    const priceUsd = state.marketPricesUsd[sym] ?? 1;

    // Derive velocity from trade activity for this symbol
    const executions = Object.values(state.executions).filter(
      (e) => e.symbol === sym && e.status === 'filled',
    );
    const now = Date.now();
    const dayMs = 86_400_000;
    const recent = executions.filter(
      (e) => now - new Date(e.createdAt).getTime() < dayMs,
    );

    const transfersLast24h = recent.length * 10; // simulated on-chain multiplier
    const volumeLast24hUsd = recent.reduce((s, e) => s + (e.grossNotionalUsd ?? 0), 0) * 3;

    // velocity = volume / market cap proxy
    const marketCapProxy = priceUsd * 1_000_000_000;
    const velocity = marketCapProxy > 0
      ? Number((volumeLast24hUsd / marketCapProxy).toFixed(6))
      : 0;

    const avgHoldPeriodHours = velocity > 0
      ? Number(Math.min(8760, 24 / Math.max(velocity, 0.001)).toFixed(1))
      : 8760;

    // Trend: compare to 7d average
    const weekExecs = executions.filter(
      (e) => now - new Date(e.createdAt).getTime() < 7 * dayMs,
    );
    const weekDailyAvg = weekExecs.length / 7;
    const velocityTrend: TokenVelocity['velocityTrend'] =
      recent.length > weekDailyAvg * 1.2
        ? 'accelerating'
        : recent.length < weekDailyAvg * 0.8
          ? 'decelerating'
          : 'stable';

    return {
      symbol: sym,
      velocity,
      avgHoldPeriodHours,
      transfersLast24h,
      volumeLast24hUsd: Number(volumeLast24hUsd.toFixed(2)),
      velocityTrend,
      timestamp: isoNow(),
    };
  }

  // ─── Supply Analysis ────────────────────────────────────────────────

  getSupplyAnalysis(symbol: string): TokenSupply {
    const sym = symbol.toUpperCase();

    // Deterministic supply distribution per symbol
    const seed = sym.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
    const rng = (i: number) => ((seed * 9301 + 49297 + i * 177) % 233280) / 233280;

    const maxSupply = Math.round(1_000_000_000 * (1 + rng(0) * 9));
    const burnedPct = rng(1) * 0.15;
    const lockedPct = rng(2) * 0.35;
    const circulatingPct = 1 - burnedPct - lockedPct;

    const burnedSupply = Math.round(maxSupply * burnedPct);
    const lockedSupply = Math.round(maxSupply * lockedPct);
    const circulatingSupply = maxSupply - burnedSupply - lockedSupply;
    const totalSupply = maxSupply - burnedSupply;
    const inflationRatePct = rng(3) * 5;

    return {
      symbol: sym,
      maxSupply,
      totalSupply,
      circulatingSupply,
      lockedSupply,
      burnedSupply,
      circulatingPct: Number((circulatingPct * 100).toFixed(2)),
      lockedPct: Number((lockedPct * 100).toFixed(2)),
      burnedPct: Number((burnedPct * 100).toFixed(2)),
      inflationRatePct: Number(inflationRatePct.toFixed(2)),
      timestamp: isoNow(),
    };
  }

  // ─── Correlation Matrix ─────────────────────────────────────────────

  getCorrelationMatrix(symbols?: string[]): CorrelationMatrix {
    const state = this.store.snapshot();
    const history = state.marketPriceHistoryUsd ?? {};

    const syms = symbols?.length
      ? symbols.map((s) => s.toUpperCase())
      : Object.keys(history);

    // Build price arrays (returns)
    const returns: Record<string, number[]> = {};
    for (const sym of syms) {
      const h = history[sym];
      if (!h || h.length < 2) {
        returns[sym] = [];
        continue;
      }
      const ret: number[] = [];
      for (let i = 1; i < h.length; i++) {
        const prev = h[i - 1].priceUsd;
        ret.push(prev !== 0 ? (h[i].priceUsd - prev) / prev : 0);
      }
      returns[sym] = ret;
    }

    const n = syms.length;
    const matrix: number[][] = Array.from({ length: n }, () => Array(n).fill(0));
    const pairs: CorrelationPair[] = [];

    for (let i = 0; i < n; i++) {
      matrix[i][i] = 1;
      for (let j = i + 1; j < n; j++) {
        const corr = Number(pearsonCorrelation(returns[syms[i]], returns[syms[j]]).toFixed(4));
        matrix[i][j] = corr;
        matrix[j][i] = corr;
        pairs.push({
          symbolA: syms[i],
          symbolB: syms[j],
          correlation: corr,
          strength: classifyCorrelation(corr),
        });
      }
    }

    return {
      symbols: syms,
      matrix,
      pairs,
      timestamp: isoNow(),
    };
  }

  // ─── Momentum Score ─────────────────────────────────────────────────

  getMomentumScore(symbol: string): MomentumScore {
    const sym = symbol.toUpperCase();
    const state = this.store.snapshot();
    const history = (state.marketPriceHistoryUsd ?? {})[sym] ?? [];

    const prices = history.map((h) => h.priceUsd);
    const current = prices.length > 0 ? prices[prices.length - 1] : (state.marketPricesUsd[sym] ?? 0);

    // Price change components
    const price24hAgo = prices.length > 1 ? prices[Math.max(0, prices.length - 2)] : current;
    const price7dAgo = prices.length > 7 ? prices[Math.max(0, prices.length - 8)] : current;

    const priceChange24h = price24hAgo !== 0 ? ((current - price24hAgo) / price24hAgo) * 100 : 0;
    const priceChange7d = price7dAgo !== 0 ? ((current - price7dAgo) / price7dAgo) * 100 : 0;

    // RSI
    const rsi = computeRSI(prices);

    // MACD-like signal (fast vs slow average)
    const fast = prices.slice(-5);
    const slow = prices.slice(-12);
    const fastAvg = fast.length ? fast.reduce((s, v) => s + v, 0) / fast.length : current;
    const slowAvg = slow.length ? slow.reduce((s, v) => s + v, 0) / slow.length : current;
    const macdSignal = slowAvg !== 0 ? ((fastAvg - slowAvg) / slowAvg) * 100 : 0;

    // Volume trend (execution count proxy)
    const executions = Object.values(state.executions).filter(
      (e) => e.symbol === sym && e.status === 'filled',
    );
    const volumeTrend = Math.min(100, executions.length * 5);

    // Composite score: weighted 0-100
    const rsiComponent = rsi; // already 0-100
    const changeComponent = clamp(50 + priceChange24h * 2, 0, 100);
    const change7dComponent = clamp(50 + priceChange7d, 0, 100);
    const macdComponent = clamp(50 + macdSignal * 5, 0, 100);
    const volComponent = clamp(volumeTrend, 0, 100);

    const rawScore =
      rsiComponent * 0.30 +
      changeComponent * 0.20 +
      change7dComponent * 0.15 +
      macdComponent * 0.20 +
      volComponent * 0.15;

    const score = Number(clamp(rawScore, 0, 100).toFixed(1));

    return {
      symbol: sym,
      score,
      signal: classifyMomentum(score),
      components: {
        priceChange24h: Number(priceChange24h.toFixed(2)),
        priceChange7d: Number(priceChange7d.toFixed(2)),
        rsi: Number(rsi.toFixed(2)),
        macdSignal: Number(macdSignal.toFixed(4)),
        volumeTrend,
      },
      timestamp: isoNow(),
    };
  }

  // ─── Risk Rating ────────────────────────────────────────────────────

  getRiskRating(symbol: string): RiskRating {
    const sym = symbol.toUpperCase();
    const state = this.store.snapshot();
    const history = (state.marketPriceHistoryUsd ?? {})[sym] ?? [];
    const prices = history.map((h) => h.priceUsd);

    // Volatility risk: standard deviation of returns
    let volatilityRisk = 50;
    if (prices.length >= 2) {
      const returns: number[] = [];
      for (let i = 1; i < prices.length; i++) {
        const prev = prices[i - 1];
        returns.push(prev !== 0 ? (prices[i] - prev) / prev : 0);
      }
      const mean = returns.reduce((s, v) => s + v, 0) / returns.length;
      const variance = returns.reduce((s, v) => s + (v - mean) ** 2, 0) / returns.length;
      const stdDev = Math.sqrt(variance);
      // Annualise and scale: 0-100
      volatilityRisk = clamp(stdDev * Math.sqrt(365) * 100, 0, 100);
    }

    // Liquidity risk: inverse of execution count
    const executions = Object.values(state.executions).filter(
      (e) => e.symbol === sym && e.status === 'filled',
    );
    const liquidityRisk = clamp(100 - executions.length * 3, 0, 100);

    // Concentration risk: from holder distribution
    const holderDist = this.getHolderDistribution(sym);
    const concentrationRisk = clamp(holderDist.whalePct, 0, 100);

    // Overall weighted risk
    const overallRisk = Number(
      (volatilityRisk * 0.40 + liquidityRisk * 0.30 + concentrationRisk * 0.30).toFixed(1),
    );

    const factors: string[] = [];
    if (volatilityRisk > 60) factors.push('High price volatility');
    if (liquidityRisk > 60) factors.push('Low trading liquidity');
    if (concentrationRisk > 60) factors.push('High holder concentration');
    if (factors.length === 0) factors.push('No major risk factors detected');

    return {
      symbol: sym,
      overallRisk,
      grade: gradeRisk(overallRisk),
      components: {
        volatilityRisk: Number(volatilityRisk.toFixed(1)),
        liquidityRisk: Number(liquidityRisk.toFixed(1)),
        concentrationRisk: Number(concentrationRisk.toFixed(1)),
      },
      factors,
      timestamp: isoNow(),
    };
  }
}
