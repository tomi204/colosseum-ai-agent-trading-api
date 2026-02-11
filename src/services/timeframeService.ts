/**
 * Multi-Timeframe Analysis Service.
 *
 * Analyzes price data across multiple timeframes (1m, 5m, 15m, 1h, 4h)
 * to produce aggregated signals and timeframe alignment checks.
 *
 * Timeframe alignment: when all timeframes agree on direction, the signal is strong.
 * Diverging timeframes indicate uncertainty and weaker signals.
 */

import { StateStore } from '../infra/storage/stateStore.js';
import { eventBus } from '../infra/eventBus.js';
import { isoNow } from '../utils/time.js';

// ─── Types ──────────────────────────────────────────────────────────────

export type Timeframe = '1m' | '5m' | '15m' | '1h' | '4h';
export type SignalDirection = 'bullish' | 'bearish' | 'neutral';
export type SignalStrength = 'strong' | 'moderate' | 'weak';

export interface TimeframeCandle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface TimeframeIndicators {
  sma: number;
  ema: number;
  rsi: number;
  momentum: number;
  volatility: number;
}

export interface TimeframeSignal {
  timeframe: Timeframe;
  direction: SignalDirection;
  strength: SignalStrength;
  confidence: number;
  indicators: TimeframeIndicators;
  candleCount: number;
}

export interface TimeframeAnalysis {
  symbol: string;
  signals: TimeframeSignal[];
  aggregateDirection: SignalDirection;
  aggregateConfidence: number;
  analyzedAt: string;
}

export interface TimeframeAlignment {
  symbol: string;
  aligned: boolean;
  alignmentScore: number;
  dominantDirection: SignalDirection;
  agreeing: Timeframe[];
  diverging: Timeframe[];
  recommendation: string;
  analyzedAt: string;
}

export interface PricePoint {
  timestamp: number;
  price: number;
}

// ─── Constants ──────────────────────────────────────────────────────────

const TIMEFRAMES: Timeframe[] = ['1m', '5m', '15m', '1h', '4h'];

const TIMEFRAME_MINUTES: Record<Timeframe, number> = {
  '1m': 1,
  '5m': 5,
  '15m': 15,
  '1h': 60,
  '4h': 240,
};

const TIMEFRAME_WEIGHTS: Record<Timeframe, number> = {
  '1m': 0.1,
  '5m': 0.15,
  '15m': 0.2,
  '1h': 0.25,
  '4h': 0.3,
};

// ─── Indicator helpers ──────────────────────────────────────────────────

function computeSMA(prices: number[], period: number): number {
  if (prices.length === 0) return 0;
  const slice = prices.slice(-period);
  return slice.reduce((s, v) => s + v, 0) / slice.length;
}

function computeEMA(prices: number[], period: number): number {
  if (prices.length === 0) return 0;
  const k = 2 / (period + 1);
  let ema = prices[0];
  for (let i = 1; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
}

function computeRSI(prices: number[], period: number = 14): number {
  if (prices.length < 2) return 50;

  let gains = 0;
  let losses = 0;
  const lookback = Math.min(period, prices.length - 1);

  for (let i = prices.length - lookback; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }

  if (losses === 0) return 100;
  if (gains === 0) return 0;

  const rs = (gains / lookback) / (losses / lookback);
  return 100 - (100 / (1 + rs));
}

function computeMomentum(prices: number[], period: number = 10): number {
  if (prices.length < period + 1) return 0;
  const current = prices[prices.length - 1];
  const past = prices[prices.length - 1 - period];
  if (past === 0) return 0;
  return ((current - past) / past) * 100;
}

function computeVolatility(prices: number[]): number {
  if (prices.length < 2) return 0;
  const returns: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i - 1] !== 0) {
      returns.push((prices[i] - prices[i - 1]) / prices[i - 1]);
    }
  }
  if (returns.length === 0) return 0;
  const mean = returns.reduce((s, v) => s + v, 0) / returns.length;
  const variance = returns.reduce((s, v) => s + (v - mean) ** 2, 0) / returns.length;
  return Math.sqrt(variance);
}

function aggregatePricesToCandles(prices: number[], candleSize: number): number[][] {
  const candles: number[][] = [];
  for (let i = 0; i < prices.length; i += candleSize) {
    const slice = prices.slice(i, i + candleSize);
    if (slice.length > 0) candles.push(slice);
  }
  return candles;
}

function deriveSignalDirection(indicators: TimeframeIndicators): SignalDirection {
  let bullishScore = 0;
  let bearishScore = 0;

  // EMA vs SMA crossover
  if (indicators.ema > indicators.sma) bullishScore += 1;
  else if (indicators.ema < indicators.sma) bearishScore += 1;

  // RSI
  if (indicators.rsi > 60) bullishScore += 1;
  else if (indicators.rsi < 40) bearishScore += 1;

  // Momentum
  if (indicators.momentum > 0) bullishScore += 1;
  else if (indicators.momentum < 0) bearishScore += 1;

  if (bullishScore > bearishScore) return 'bullish';
  if (bearishScore > bullishScore) return 'bearish';
  return 'neutral';
}

function deriveStrength(indicators: TimeframeIndicators): SignalStrength {
  const rsiExtreme = indicators.rsi > 70 || indicators.rsi < 30;
  const momentumStrong = Math.abs(indicators.momentum) > 2;

  if (rsiExtreme && momentumStrong) return 'strong';
  if (rsiExtreme || momentumStrong) return 'moderate';
  return 'weak';
}

function deriveConfidence(indicators: TimeframeIndicators, candleCount: number): number {
  let confidence = 0.5;

  // More data = more confidence
  if (candleCount > 20) confidence += 0.1;
  if (candleCount > 50) confidence += 0.1;

  // Strong momentum increases confidence
  if (Math.abs(indicators.momentum) > 1) confidence += 0.1;
  if (Math.abs(indicators.momentum) > 3) confidence += 0.1;

  // RSI extremes increase directional confidence
  if (indicators.rsi > 65 || indicators.rsi < 35) confidence += 0.1;

  return Math.min(Number(confidence.toFixed(2)), 1);
}

// ─── Service ────────────────────────────────────────────────────────────

export class TimeframeService {
  /** Cached analysis results per symbol */
  private analysisCache: Map<string, TimeframeAnalysis> = new Map();

  constructor(private readonly store: StateStore) {}

  /**
   * Analyze price data across multiple timeframes.
   * @param symbol Token symbol
   * @param priceHistory Array of raw price numbers (assumed 1-minute granularity)
   */
  analyzeTimeframes(symbol: string, priceHistory: number[]): TimeframeAnalysis {
    const normalizedSymbol = symbol.toUpperCase();
    const signals: TimeframeSignal[] = [];

    for (const tf of TIMEFRAMES) {
      const candleMinutes = TIMEFRAME_MINUTES[tf];
      const candleGroups = aggregatePricesToCandles(priceHistory, candleMinutes);

      // Need at least 2 candles for meaningful analysis
      if (candleGroups.length < 2) {
        signals.push({
          timeframe: tf,
          direction: 'neutral',
          strength: 'weak',
          confidence: 0,
          indicators: { sma: 0, ema: 0, rsi: 50, momentum: 0, volatility: 0 },
          candleCount: candleGroups.length,
        });
        continue;
      }

      // Use candle close prices
      const closePrices = candleGroups.map((group) => group[group.length - 1]);

      const indicators: TimeframeIndicators = {
        sma: Number(computeSMA(closePrices, Math.min(20, closePrices.length)).toFixed(6)),
        ema: Number(computeEMA(closePrices, Math.min(20, closePrices.length)).toFixed(6)),
        rsi: Number(computeRSI(closePrices).toFixed(2)),
        momentum: Number(computeMomentum(closePrices).toFixed(4)),
        volatility: Number(computeVolatility(closePrices).toFixed(6)),
      };

      const direction = deriveSignalDirection(indicators);
      const strength = deriveStrength(indicators);
      const confidence = deriveConfidence(indicators, closePrices.length);

      signals.push({
        timeframe: tf,
        direction,
        strength,
        confidence,
        indicators,
        candleCount: closePrices.length,
      });
    }

    // Aggregate direction using weighted confidence
    const { aggregateDirection, aggregateConfidence } = this.computeAggregateSignal(signals);

    const analysis: TimeframeAnalysis = {
      symbol: normalizedSymbol,
      signals,
      aggregateDirection,
      aggregateConfidence: Number(aggregateConfidence.toFixed(2)),
      analyzedAt: isoNow(),
    };

    this.analysisCache.set(normalizedSymbol, analysis);

    eventBus.emit('price.updated' as any, {
      type: 'timeframe-analysis',
      symbol: normalizedSymbol,
      aggregateDirection,
      aggregateConfidence,
    });

    return analysis;
  }

  /**
   * Get aggregated signals for a symbol from cached analysis.
   * Falls back to price history from state if no cached analysis exists.
   */
  getTimeframeSignals(symbol: string): TimeframeAnalysis | null {
    const normalizedSymbol = symbol.toUpperCase();

    // Return cached analysis if available
    const cached = this.analysisCache.get(normalizedSymbol);
    if (cached) return cached;

    // Attempt to analyze from state price history
    const state = this.store.snapshot();
    const history = state.marketPriceHistoryUsd[normalizedSymbol];
    if (!history || history.length < 2) return null;

    const prices = history.map((p) => p.priceUsd);
    return this.analyzeTimeframes(normalizedSymbol, prices);
  }

  /**
   * Check if all timeframes agree (strong signal) or diverge (weak signal).
   */
  getTimeframeAlignment(symbol: string): TimeframeAlignment | null {
    const normalizedSymbol = symbol.toUpperCase();

    const analysis = this.analysisCache.get(normalizedSymbol);
    if (!analysis) {
      // Try from state
      const signals = this.getTimeframeSignals(normalizedSymbol);
      if (!signals) return null;
      return this.buildAlignment(normalizedSymbol, signals.signals);
    }

    return this.buildAlignment(normalizedSymbol, analysis.signals);
  }

  // ─── Private helpers ──────────────────────────────────────────────────

  private computeAggregateSignal(signals: TimeframeSignal[]): { aggregateDirection: SignalDirection; aggregateConfidence: number } {
    let bullishWeight = 0;
    let bearishWeight = 0;
    let totalWeight = 0;

    for (const signal of signals) {
      const weight = TIMEFRAME_WEIGHTS[signal.timeframe] * signal.confidence;
      totalWeight += weight;

      if (signal.direction === 'bullish') bullishWeight += weight;
      else if (signal.direction === 'bearish') bearishWeight += weight;
    }

    let aggregateDirection: SignalDirection;
    if (bullishWeight > bearishWeight * 1.2) aggregateDirection = 'bullish';
    else if (bearishWeight > bullishWeight * 1.2) aggregateDirection = 'bearish';
    else aggregateDirection = 'neutral';

    const aggregateConfidence = totalWeight > 0
      ? Math.max(bullishWeight, bearishWeight) / totalWeight
      : 0;

    return { aggregateDirection, aggregateConfidence };
  }

  private buildAlignment(symbol: string, signals: TimeframeSignal[]): TimeframeAlignment {
    const nonNeutral = signals.filter((s) => s.direction !== 'neutral' && s.confidence > 0);
    const bullish = nonNeutral.filter((s) => s.direction === 'bullish');
    const bearish = nonNeutral.filter((s) => s.direction === 'bearish');

    // Determine dominant direction
    let dominantDirection: SignalDirection;
    if (bullish.length > bearish.length) dominantDirection = 'bullish';
    else if (bearish.length > bullish.length) dominantDirection = 'bearish';
    else dominantDirection = 'neutral';

    const agreeing: Timeframe[] = [];
    const diverging: Timeframe[] = [];

    for (const signal of signals) {
      if (signal.direction === dominantDirection || signal.direction === 'neutral') {
        agreeing.push(signal.timeframe);
      } else {
        diverging.push(signal.timeframe);
      }
    }

    const alignmentScore = signals.length > 0
      ? Number((agreeing.length / signals.length).toFixed(2))
      : 0;

    const aligned = alignmentScore >= 0.8;

    let recommendation: string;
    if (aligned && dominantDirection === 'bullish') {
      recommendation = 'Strong bullish alignment across timeframes. Consider long entries.';
    } else if (aligned && dominantDirection === 'bearish') {
      recommendation = 'Strong bearish alignment across timeframes. Consider short entries or exits.';
    } else if (alignmentScore >= 0.6) {
      recommendation = `Moderate ${dominantDirection} tendency with some timeframe divergence. Use caution.`;
    } else {
      recommendation = 'Significant timeframe divergence. No clear directional edge — consider staying flat.';
    }

    return {
      symbol,
      aligned,
      alignmentScore,
      dominantDirection,
      agreeing,
      diverging,
      recommendation,
      analyzedAt: isoNow(),
    };
  }
}
