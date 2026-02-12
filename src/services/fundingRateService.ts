/**
 * Funding Rate Arbitrage Service
 *
 * Provides perpetuals funding rate analysis for AI agents:
 *
 *   - Funding rate monitoring across protocols (Drift, Mango)
 *   - Funding rate arbitrage opportunity detection (long spot + short perp when funding positive)
 *   - Historical funding rate analytics
 *   - Predicted funding rate (based on open interest + mark/index spread)
 *   - Carry trade calculator (annualized funding yield)
 *   - Basis tracking (perp vs spot price difference)
 */

import { isoNow } from '../utils/time.js';

// ─── Types ──────────────────────────────────────────────────────────────

export type Protocol = 'drift' | 'mango';

export interface FundingRateSnapshot {
  protocol: Protocol;
  symbol: string;
  fundingRate: number;          // per-period rate (e.g. 0.01 = 1%)
  fundingRateAnnualized: number; // annualized rate
  markPrice: number;
  indexPrice: number;
  openInterest: number;         // USD notional
  nextFundingAt: string;
  period: 'hourly' | '8h';
  timestamp: string;
}

export interface FundingRateHistory {
  protocol: Protocol;
  symbol: string;
  entries: FundingRateHistoryEntry[];
  avgRate: number;
  medianRate: number;
  maxRate: number;
  minRate: number;
  stdDev: number;
  totalEntries: number;
}

export interface FundingRateHistoryEntry {
  timestamp: string;
  fundingRate: number;
  markPrice: number;
  indexPrice: number;
  openInterest: number;
}

export interface ArbitrageOpportunity {
  id: string;
  symbol: string;
  direction: 'long-spot-short-perp' | 'short-spot-long-perp';
  protocol: Protocol;
  fundingRate: number;
  fundingRateAnnualized: number;
  basisPct: number;
  estimatedAnnualYieldPct: number;
  markPrice: number;
  spotPrice: number;
  riskLevel: 'low' | 'medium' | 'high';
  capitalRequiredUsd: number;
  detectedAt: string;
  expiresAt: string;
  viable: boolean;
}

export interface PredictedFundingRate {
  protocol: Protocol;
  symbol: string;
  currentRate: number;
  predictedRate: number;
  confidence: number;             // 0-1
  factors: {
    openInterestBias: number;     // positive = longs dominant
    markIndexSpread: number;
    recentTrend: number;          // slope of recent rates
    volatilityImpact: number;
  };
  predictedAt: string;
}

export interface CarryTradeResult {
  symbol: string;
  protocol: Protocol;
  positionSizeUsd: number;
  fundingRate: number;
  fundingPeriod: 'hourly' | '8h';
  periodsPerYear: number;
  annualizedYieldPct: number;
  dailyYieldUsd: number;
  weeklyYieldUsd: number;
  monthlyYieldUsd: number;
  yearlyYieldUsd: number;
  breakEvenSlippagePct: number;   // how much slippage can erode before unprofitable
  riskAdjustedYieldPct: number;
  calculatedAt: string;
}

export interface BasisInfo {
  symbol: string;
  protocols: BasisProtocolEntry[];
  avgBasisPct: number;
  basisTrend: 'contango' | 'backwardation' | 'flat';
  timestamp: string;
}

export interface BasisProtocolEntry {
  protocol: Protocol;
  spotPrice: number;
  perpPrice: number;
  basisAbsolute: number;        // perp - spot
  basisPct: number;             // (perp - spot) / spot × 100
  fundingRate: number;
  annualizedBasisPct: number;
}

// ─── Seed Data ──────────────────────────────────────────────────────────

const PROTOCOLS_META: Record<Protocol, { period: 'hourly' | '8h'; periodsPerYear: number }> = {
  drift: { period: 'hourly', periodsPerYear: 8760 },
  mango: { period: '8h', periodsPerYear: 1095 },
};

interface SeedMarket {
  symbol: string;
  spotPrice: number;
  drift: { markPrice: number; fundingRate: number; openInterest: number };
  mango: { markPrice: number; fundingRate: number; openInterest: number };
}

const SEED_MARKETS: SeedMarket[] = [
  {
    symbol: 'SOL-PERP',
    spotPrice: 105.20,
    drift: { markPrice: 105.45, fundingRate: 0.0032, openInterest: 285_000_000 },
    mango: { markPrice: 105.38, fundingRate: 0.0028, openInterest: 142_000_000 },
  },
  {
    symbol: 'BTC-PERP',
    spotPrice: 43_250.00,
    drift: { markPrice: 43_310.00, fundingRate: 0.0018, openInterest: 520_000_000 },
    mango: { markPrice: 43_295.00, fundingRate: 0.0015, openInterest: 310_000_000 },
  },
  {
    symbol: 'ETH-PERP',
    spotPrice: 2_285.00,
    drift: { markPrice: 2_290.50, fundingRate: 0.0025, openInterest: 380_000_000 },
    mango: { markPrice: 2_288.00, fundingRate: 0.0020, openInterest: 195_000_000 },
  },
  {
    symbol: 'JUP-PERP',
    spotPrice: 0.72,
    drift: { markPrice: 0.725, fundingRate: 0.0085, openInterest: 45_000_000 },
    mango: { markPrice: 0.722, fundingRate: 0.0072, openInterest: 22_000_000 },
  },
  {
    symbol: 'BONK-PERP',
    spotPrice: 0.0000125,
    drift: { markPrice: 0.0000128, fundingRate: -0.0045, openInterest: 18_000_000 },
    mango: { markPrice: 0.0000124, fundingRate: -0.0052, openInterest: 8_500_000 },
  },
  {
    symbol: 'WIF-PERP',
    spotPrice: 0.38,
    drift: { markPrice: 0.386, fundingRate: 0.012, openInterest: 32_000_000 },
    mango: { markPrice: 0.383, fundingRate: 0.0095, openInterest: 14_000_000 },
  },
];

// ─── Helpers ────────────────────────────────────────────────────────────

function round6(n: number): number {
  return Number(n.toFixed(6));
}

function round4(n: number): number {
  return Number(n.toFixed(4));
}

function round2(n: number): number {
  return Number(n.toFixed(2));
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function stdDev(arr: number[]): number {
  if (arr.length < 2) return 0;
  const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
  const variance = arr.reduce((s, v) => s + (v - mean) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

function generateHistory(baseFundingRate: number, baseMarkPrice: number, baseIndexPrice: number, baseOI: number, count: number): FundingRateHistoryEntry[] {
  const entries: FundingRateHistoryEntry[] = [];
  const now = Date.now();
  for (let i = count - 1; i >= 0; i--) {
    const noise = (Math.sin(i * 0.7) * 0.4 + Math.cos(i * 1.3) * 0.3) * baseFundingRate;
    const oiNoise = Math.sin(i * 0.5) * baseOI * 0.1;
    const priceNoise = Math.sin(i * 0.9) * baseMarkPrice * 0.005;
    entries.push({
      timestamp: new Date(now - i * 3600_000).toISOString(),
      fundingRate: round6(baseFundingRate + noise),
      markPrice: round4(baseMarkPrice + priceNoise),
      indexPrice: round4(baseIndexPrice + priceNoise * 0.8),
      openInterest: round2(baseOI + oiNoise),
    });
  }
  return entries;
}

let opportunityCounter = 0;

// ─── Service ────────────────────────────────────────────────────────────

export class FundingRateService {
  private markets: Map<string, SeedMarket> = new Map();
  private historyCache: Map<string, FundingRateHistoryEntry[]> = new Map();

  constructor() {
    for (const m of SEED_MARKETS) {
      this.markets.set(m.symbol, m);
    }
  }

  // ─── Current Funding Rates ──────────────────────────────────────────

  /**
   * Get current funding rates for a symbol across all protocols.
   */
  getCurrentRates(symbol: string): FundingRateSnapshot[] {
    const market = this.markets.get(symbol);
    if (!market) return [];

    const now = isoNow();
    const results: FundingRateSnapshot[] = [];

    for (const proto of ['drift', 'mango'] as Protocol[]) {
      const data = market[proto];
      const meta = PROTOCOLS_META[proto];
      results.push({
        protocol: proto,
        symbol: market.symbol,
        fundingRate: data.fundingRate,
        fundingRateAnnualized: round4(data.fundingRate * meta.periodsPerYear * 100),
        markPrice: data.markPrice,
        indexPrice: market.spotPrice,
        openInterest: data.openInterest,
        nextFundingAt: new Date(Date.now() + 1800_000).toISOString(),
        period: meta.period,
        timestamp: now,
      });
    }

    return results;
  }

  /**
   * List all tracked symbols.
   */
  getSymbols(): string[] {
    return Array.from(this.markets.keys());
  }

  // ─── Historical Funding Rates ───────────────────────────────────────

  /**
   * Get historical funding rate data for a symbol+protocol.
   */
  getHistory(symbol: string, opts?: {
    protocol?: Protocol;
    limit?: number;
  }): FundingRateHistory[] {
    const market = this.markets.get(symbol);
    if (!market) return [];

    const protocols: Protocol[] = opts?.protocol ? [opts.protocol] : ['drift', 'mango'];
    const limit = Math.min(opts?.limit ?? 168, 720); // default 7 days of hourly

    const results: FundingRateHistory[] = [];

    for (const proto of protocols) {
      const data = market[proto];
      const cacheKey = `${symbol}:${proto}`;

      if (!this.historyCache.has(cacheKey)) {
        this.historyCache.set(cacheKey, generateHistory(
          data.fundingRate,
          data.markPrice,
          market.spotPrice,
          data.openInterest,
          720,
        ));
      }

      const full = this.historyCache.get(cacheKey)!;
      const entries = full.slice(-limit);
      const rates = entries.map((e) => e.fundingRate);

      results.push({
        protocol: proto,
        symbol,
        entries,
        avgRate: round6(rates.reduce((s, v) => s + v, 0) / rates.length),
        medianRate: round6(median(rates)),
        maxRate: round6(Math.max(...rates)),
        minRate: round6(Math.min(...rates)),
        stdDev: round6(stdDev(rates)),
        totalEntries: entries.length,
      });
    }

    return results;
  }

  // ─── Arbitrage Opportunity Detection ────────────────────────────────

  /**
   * Scan all markets for funding rate arbitrage opportunities.
   * Positive funding → long spot + short perp = collect funding.
   * Negative funding → short spot + long perp = collect funding.
   */
  getArbitrageOpportunities(opts?: {
    minAnnualizedYieldPct?: number;
    symbol?: string;
  }): ArbitrageOpportunity[] {
    const minYield = opts?.minAnnualizedYieldPct ?? 5;
    const opportunities: ArbitrageOpportunity[] = [];

    const markets = opts?.symbol
      ? [this.markets.get(opts.symbol)].filter(Boolean) as SeedMarket[]
      : Array.from(this.markets.values());

    for (const market of markets) {
      for (const proto of ['drift', 'mango'] as Protocol[]) {
        const data = market[proto];
        const meta = PROTOCOLS_META[proto];
        const annualized = data.fundingRate * meta.periodsPerYear * 100;
        const basisPct = ((data.markPrice - market.spotPrice) / market.spotPrice) * 100;

        // Only consider if absolute annualized rate exceeds threshold
        if (Math.abs(annualized) < minYield) continue;

        const direction: ArbitrageOpportunity['direction'] = data.fundingRate > 0
          ? 'long-spot-short-perp'
          : 'short-spot-long-perp';

        const absAnnualized = Math.abs(annualized);

        // Estimate risk based on volatility and open interest
        let riskLevel: 'low' | 'medium' | 'high' = 'low';
        if (absAnnualized > 50) riskLevel = 'high';
        else if (absAnnualized > 20) riskLevel = 'medium';

        // Capital required: recommended 2x for leverage buffer
        const capitalRequiredUsd = round2(Math.max(1000, data.openInterest * 0.001));

        opportunityCounter += 1;
        const id = `fra-${Date.now()}-${opportunityCounter}`;

        opportunities.push({
          id,
          symbol: market.symbol,
          direction,
          protocol: proto,
          fundingRate: data.fundingRate,
          fundingRateAnnualized: round4(annualized),
          basisPct: round4(basisPct),
          estimatedAnnualYieldPct: round4(absAnnualized - Math.abs(basisPct)),
          markPrice: data.markPrice,
          spotPrice: market.spotPrice,
          riskLevel,
          capitalRequiredUsd,
          detectedAt: isoNow(),
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          viable: absAnnualized > Math.abs(basisPct) * 2,
        });
      }
    }

    // Sort by estimated yield descending
    opportunities.sort((a, b) => b.estimatedAnnualYieldPct - a.estimatedAnnualYieldPct);
    return opportunities;
  }

  // ─── Predicted Funding Rate ─────────────────────────────────────────

  /**
   * Predict next funding rate based on open interest imbalance,
   * mark/index spread, and recent trend.
   */
  predictFundingRate(symbol: string, protocol?: Protocol): PredictedFundingRate[] {
    const market = this.markets.get(symbol);
    if (!market) return [];

    const protocols: Protocol[] = protocol ? [protocol] : ['drift', 'mango'];
    const results: PredictedFundingRate[] = [];

    for (const proto of protocols) {
      const data = market[proto];
      const cacheKey = `${symbol}:${proto}`;

      // Get recent history for trend calculation
      if (!this.historyCache.has(cacheKey)) {
        this.historyCache.set(cacheKey, generateHistory(
          data.fundingRate,
          data.markPrice,
          market.spotPrice,
          data.openInterest,
          720,
        ));
      }

      const history = this.historyCache.get(cacheKey)!;
      const recent = history.slice(-24); // last 24 entries

      // Factor 1: Open Interest Bias
      // Higher OI relative to baseline suggests more speculative longs
      const avgOI = recent.reduce((s, e) => s + e.openInterest, 0) / recent.length;
      const oiBias = round6((data.openInterest - avgOI) / avgOI);

      // Factor 2: Mark-Index Spread
      const markIndexSpread = round6((data.markPrice - market.spotPrice) / market.spotPrice);

      // Factor 3: Recent Trend (linear regression slope)
      const recentRates = recent.map((e) => e.fundingRate);
      let trend = 0;
      if (recentRates.length >= 2) {
        const n = recentRates.length;
        const xMean = (n - 1) / 2;
        const yMean = recentRates.reduce((s, v) => s + v, 0) / n;
        let num = 0;
        let den = 0;
        for (let i = 0; i < n; i++) {
          num += (i - xMean) * (recentRates[i] - yMean);
          den += (i - xMean) ** 2;
        }
        trend = den !== 0 ? num / den : 0;
      }

      // Factor 4: Volatility impact (higher vol = higher abs funding)
      const rateStdDev = stdDev(recentRates);
      const volatilityImpact = round6(rateStdDev * (data.fundingRate >= 0 ? 1 : -1));

      // Prediction: weighted combination
      // Base: current rate, adjusted by trend and spread
      const predicted = round6(
        data.fundingRate * 0.5 +             // mean reversion weight
        (data.fundingRate + trend * 3) * 0.25 + // trend extrapolation
        markIndexSpread * 0.15 +               // spread influence
        volatilityImpact * 0.10,               // vol adjustment
      );

      // Confidence: lower when high volatility or extreme divergence
      const divergence = Math.abs(predicted - data.fundingRate);
      const confidence = round4(Math.max(0.1, Math.min(0.95, 1 - divergence * 20 - rateStdDev * 5)));

      results.push({
        protocol: proto,
        symbol,
        currentRate: data.fundingRate,
        predictedRate: predicted,
        confidence,
        factors: {
          openInterestBias: oiBias,
          markIndexSpread,
          recentTrend: round6(trend),
          volatilityImpact,
        },
        predictedAt: isoNow(),
      });
    }

    return results;
  }

  // ─── Carry Trade Calculator ─────────────────────────────────────────

  /**
   * Calculate expected carry trade returns from funding rate collection.
   */
  calculateCarryTrade(symbol: string, positionSizeUsd: number, protocol?: Protocol): CarryTradeResult[] {
    const market = this.markets.get(symbol);
    if (!market) return [];

    const protocols: Protocol[] = protocol ? [protocol] : ['drift', 'mango'];
    const results: CarryTradeResult[] = [];

    for (const proto of protocols) {
      const data = market[proto];
      const meta = PROTOCOLS_META[proto];

      const absRate = Math.abs(data.fundingRate);
      const annualizedYieldPct = round4(absRate * meta.periodsPerYear * 100);

      // Per-period yield in USD
      const perPeriodYieldUsd = positionSizeUsd * absRate;
      const periodsPerDay = meta.period === 'hourly' ? 24 : 3;

      const dailyYieldUsd = round2(perPeriodYieldUsd * periodsPerDay);
      const weeklyYieldUsd = round2(dailyYieldUsd * 7);
      const monthlyYieldUsd = round2(dailyYieldUsd * 30);
      const yearlyYieldUsd = round2(dailyYieldUsd * 365);

      // Break-even slippage: entry + exit slippage that wipes out first period's gain
      // Assuming you enter and exit, total slippage must be less than the funding you collect
      const breakEvenSlippagePct = round4((absRate * periodsPerDay * 7) * 100); // 1 week of funding

      // Risk adjustment: discount yield by 30% for rate volatility risk
      const riskAdjustedYieldPct = round4(annualizedYieldPct * 0.7);

      results.push({
        symbol,
        protocol: proto,
        positionSizeUsd: round2(positionSizeUsd),
        fundingRate: data.fundingRate,
        fundingPeriod: meta.period,
        periodsPerYear: meta.periodsPerYear,
        annualizedYieldPct,
        dailyYieldUsd,
        weeklyYieldUsd,
        monthlyYieldUsd,
        yearlyYieldUsd,
        breakEvenSlippagePct,
        riskAdjustedYieldPct,
        calculatedAt: isoNow(),
      });
    }

    return results;
  }

  // ─── Basis Tracking ─────────────────────────────────────────────────

  /**
   * Track the basis (perp price - spot price) for a symbol across protocols.
   */
  getBasis(symbol: string): BasisInfo | null {
    const market = this.markets.get(symbol);
    if (!market) return null;

    const protocols: BasisProtocolEntry[] = [];

    for (const proto of ['drift', 'mango'] as Protocol[]) {
      const data = market[proto];
      const meta = PROTOCOLS_META[proto];

      const basisAbsolute = round6(data.markPrice - market.spotPrice);
      const basisPct = round4(((data.markPrice - market.spotPrice) / market.spotPrice) * 100);
      const annualizedBasisPct = round4(basisPct * (365 / (meta.period === 'hourly' ? (1 / 24) : (8 / 24))));

      protocols.push({
        protocol: proto,
        spotPrice: market.spotPrice,
        perpPrice: data.markPrice,
        basisAbsolute,
        basisPct,
        fundingRate: data.fundingRate,
        annualizedBasisPct,
      });
    }

    const avgBasis = round4(protocols.reduce((s, p) => s + p.basisPct, 0) / protocols.length);

    let basisTrend: 'contango' | 'backwardation' | 'flat' = 'flat';
    if (avgBasis > 0.01) basisTrend = 'contango';
    else if (avgBasis < -0.01) basisTrend = 'backwardation';

    return {
      symbol,
      protocols,
      avgBasisPct: avgBasis,
      basisTrend,
      timestamp: isoNow(),
    };
  }

  /**
   * Get basis overview across all tracked symbols.
   */
  getAllBasis(): BasisInfo[] {
    const results: BasisInfo[] = [];
    for (const symbol of this.markets.keys()) {
      const basis = this.getBasis(symbol);
      if (basis) results.push(basis);
    }
    return results;
  }
}
