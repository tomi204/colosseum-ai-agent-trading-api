/**
 * Market Microstructure Service — deep order-flow analysis.
 *
 * Features:
 * - Order flow imbalance detection (buy vs sell pressure)
 * - Trade flow toxicity scoring (informed vs uninformed flow)
 * - Bid-ask spread analysis over time
 * - Volume profile (volume at price levels)
 * - Market depth changes (delta between order-book snapshots)
 * - Whale activity detection (large order detection + tracking)
 */

import { StateStore } from '../infra/storage/stateStore.js';
import { isoNow } from '../utils/time.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface Trade {
  id: string;
  symbol: string;
  side: 'buy' | 'sell';
  price: number;
  quantity: number;
  timestamp: string;
  makerOrderId?: string;
  takerOrderId?: string;
}

export interface OrderFlowImbalance {
  symbol: string;
  windowMs: number;
  buyVolume: number;
  sellVolume: number;
  totalVolume: number;
  imbalanceRatio: number;      // (buy - sell) / total, range [-1, 1]
  imbalancePct: number;        // absolute imbalance as percentage
  dominantSide: 'buy' | 'sell' | 'neutral';
  buyCount: number;
  sellCount: number;
  avgBuySize: number;
  avgSellSize: number;
  vwapBuy: number;
  vwapSell: number;
  pressure: 'strong_buy' | 'moderate_buy' | 'neutral' | 'moderate_sell' | 'strong_sell';
  timestamp: string;
}

export interface ToxicityScore {
  symbol: string;
  /** VPIN – Volume-synchronised Probability of Informed Trading (0–1) */
  vpin: number;
  /** Kyle's lambda – price impact per unit volume */
  kyleLambda: number;
  /** Adverse-selection component of spread (0–1) */
  adverseSelectionPct: number;
  /** Roll effective spread estimate */
  rollSpread: number;
  /** Amihud illiquidity ratio */
  amihudRatio: number;
  /** Overall toxicity score 0–100 */
  overallScore: number;
  level: 'low' | 'moderate' | 'high' | 'extreme';
  tradeCount: number;
  analysisWindowMs: number;
  timestamp: string;
}

export interface SpreadSnapshot {
  bid: number;
  ask: number;
  spreadAbsolute: number;
  spreadBps: number;
  midPrice: number;
  timestamp: string;
}

export interface SpreadAnalysis {
  symbol: string;
  current: SpreadSnapshot;
  avgSpreadBps: number;
  minSpreadBps: number;
  maxSpreadBps: number;
  medianSpreadBps: number;
  stdDevBps: number;
  wideningTrend: boolean;
  snapshots: SpreadSnapshot[];
  timestamp: string;
}

export interface VolumeLevel {
  priceLevel: number;
  volume: number;
  buyVolume: number;
  sellVolume: number;
  tradeCount: number;
  pctOfTotal: number;
}

export interface VolumeProfile {
  symbol: string;
  levels: VolumeLevel[];
  pocPrice: number;          // Point of Control – price with most volume
  pocVolume: number;
  valueAreaHigh: number;     // 70 % volume range – high
  valueAreaLow: number;      // 70 % volume range – low
  totalVolume: number;
  bucketSize: number;
  timestamp: string;
}

export interface DepthLevel {
  price: number;
  quantity: number;
  total: number;
}

export interface DepthSnapshot {
  symbol: string;
  bids: DepthLevel[];
  asks: DepthLevel[];
  bidTotal: number;
  askTotal: number;
  timestamp: string;
}

export interface DepthDelta {
  symbol: string;
  bidDelta: number;           // change in total bid depth
  askDelta: number;           // change in total ask depth
  netDelta: number;           // bid - ask delta
  bidLevelsAdded: number;
  bidLevelsRemoved: number;
  askLevelsAdded: number;
  askLevelsRemoved: number;
  significantChanges: Array<{
    side: 'bid' | 'ask';
    price: number;
    oldQuantity: number;
    newQuantity: number;
    changePercent: number;
  }>;
  snapshotCount: number;
  timestamp: string;
}

export interface WhaleOrder {
  id: string;
  symbol: string;
  side: 'buy' | 'sell';
  price: number;
  quantity: number;
  notionalUsd: number;
  detectedAt: string;
  type: 'single_trade' | 'accumulation' | 'distribution';
}

export interface WhaleActivity {
  symbol: string;
  whaleOrders: WhaleOrder[];
  totalWhaleVolume: number;
  whaleBuyVolume: number;
  whaleSellVolume: number;
  whaleImbalance: number;     // (buy - sell) / total, same semantics as flow
  whaleCount: number;
  avgWhaleSize: number;
  largestOrder: WhaleOrder | null;
  dominantSide: 'buy' | 'sell' | 'neutral';
  alertLevel: 'none' | 'notable' | 'significant' | 'extreme';
  timestamp: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_WINDOW_MS = 5 * 60 * 1000;  // 5 minutes
const MAX_TRADES_PER_SYMBOL = 5_000;
const MAX_SPREAD_SNAPSHOTS = 500;
const MAX_DEPTH_SNAPSHOTS = 100;
const MAX_WHALE_ORDERS = 200;
const VOLUME_PROFILE_BUCKETS = 20;
const WHALE_THRESHOLD_MULTIPLIER = 5;      // 5× average trade size ⇒ whale
const VALUE_AREA_PCT = 0.70;

// ─── Helpers ────────────────────────────────────────────────────────────────

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

function classifyPressure(ratio: number): OrderFlowImbalance['pressure'] {
  if (ratio > 0.6) return 'strong_buy';
  if (ratio > 0.2) return 'moderate_buy';
  if (ratio < -0.6) return 'strong_sell';
  if (ratio < -0.2) return 'moderate_sell';
  return 'neutral';
}

function classifyToxicity(score: number): ToxicityScore['level'] {
  if (score >= 75) return 'extreme';
  if (score >= 50) return 'high';
  if (score >= 25) return 'moderate';
  return 'low';
}

function classifyWhaleAlert(count: number, imbalance: number): WhaleActivity['alertLevel'] {
  if (count === 0) return 'none';
  if (count >= 5 || Math.abs(imbalance) > 0.7) return 'extreme';
  if (count >= 3 || Math.abs(imbalance) > 0.4) return 'significant';
  return 'notable';
}

let whaleIdCounter = 0;
function nextWhaleId(): string {
  whaleIdCounter += 1;
  return `whale-${Date.now()}-${whaleIdCounter}`;
}

// ─── Service ────────────────────────────────────────────────────────────────

export class MicrostructureService {
  /** symbol → trades */
  private trades: Map<string, Trade[]> = new Map();
  /** symbol → spread snapshots */
  private spreads: Map<string, SpreadSnapshot[]> = new Map();
  /** symbol → depth snapshots */
  private depthSnapshots: Map<string, DepthSnapshot[]> = new Map();
  /** symbol → whale detections */
  private whaleOrders: Map<string, WhaleOrder[]> = new Map();

  constructor(private readonly store: StateStore) {
    this.seedDemoData();
  }

  // ─── Trade Ingestion ────────────────────────────────────────────────

  /**
   * Record a trade for microstructure analysis.
   */
  recordTrade(trade: Omit<Trade, 'id'>): Trade {
    const symbol = trade.symbol.toUpperCase();
    const full: Trade = { ...trade, symbol, id: `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` };

    if (!this.trades.has(symbol)) this.trades.set(symbol, []);
    const list = this.trades.get(symbol)!;
    list.push(full);
    if (list.length > MAX_TRADES_PER_SYMBOL) list.splice(0, list.length - MAX_TRADES_PER_SYMBOL);

    // Auto-detect whale orders
    this.detectWhale(full);

    return structuredClone(full);
  }

  /**
   * Record a spread snapshot (bid / ask).
   */
  recordSpread(symbol: string, bid: number, ask: number): SpreadSnapshot {
    const upper = symbol.toUpperCase();
    const mid = (bid + ask) / 2;
    const spreadAbs = ask - bid;
    const spreadBps = mid > 0 ? (spreadAbs / mid) * 10_000 : 0;

    const snap: SpreadSnapshot = {
      bid,
      ask,
      spreadAbsolute: Math.round(spreadAbs * 1e8) / 1e8,
      spreadBps: Math.round(spreadBps * 100) / 100,
      midPrice: Math.round(mid * 1e8) / 1e8,
      timestamp: isoNow(),
    };

    if (!this.spreads.has(upper)) this.spreads.set(upper, []);
    const list = this.spreads.get(upper)!;
    list.push(snap);
    if (list.length > MAX_SPREAD_SNAPSHOTS) list.splice(0, list.length - MAX_SPREAD_SNAPSHOTS);

    return structuredClone(snap);
  }

  /**
   * Record an order-book depth snapshot.
   */
  recordDepth(snapshot: Omit<DepthSnapshot, 'bidTotal' | 'askTotal'>): DepthSnapshot {
    const symbol = snapshot.symbol.toUpperCase();
    const bidTotal = snapshot.bids.reduce((s, b) => s + b.quantity, 0);
    const askTotal = snapshot.asks.reduce((s, a) => s + a.quantity, 0);
    const full: DepthSnapshot = { ...snapshot, symbol, bidTotal, askTotal };

    if (!this.depthSnapshots.has(symbol)) this.depthSnapshots.set(symbol, []);
    const list = this.depthSnapshots.get(symbol)!;
    list.push(full);
    if (list.length > MAX_DEPTH_SNAPSHOTS) list.splice(0, list.length - MAX_DEPTH_SNAPSHOTS);

    return structuredClone(full);
  }

  // ─── Order Flow Imbalance ───────────────────────────────────────────

  /**
   * Compute order-flow imbalance for a symbol within a rolling window.
   */
  getFlowImbalance(symbol: string, windowMs?: number): OrderFlowImbalance {
    const upper = symbol.toUpperCase();
    const window = windowMs ?? DEFAULT_WINDOW_MS;
    const cutoff = Date.now() - window;
    const trades = (this.trades.get(upper) ?? []).filter((t) => new Date(t.timestamp).getTime() >= cutoff);

    const buys = trades.filter((t) => t.side === 'buy');
    const sells = trades.filter((t) => t.side === 'sell');

    const buyVol = buys.reduce((s, t) => s + t.quantity * t.price, 0);
    const sellVol = sells.reduce((s, t) => s + t.quantity * t.price, 0);
    const totalVol = buyVol + sellVol;

    const ratio = totalVol > 0 ? (buyVol - sellVol) / totalVol : 0;

    const vwapBuy = buys.length > 0
      ? buys.reduce((s, t) => s + t.price * t.quantity, 0) / buys.reduce((s, t) => s + t.quantity, 0)
      : 0;
    const vwapSell = sells.length > 0
      ? sells.reduce((s, t) => s + t.price * t.quantity, 0) / sells.reduce((s, t) => s + t.quantity, 0)
      : 0;

    return {
      symbol: upper,
      windowMs: window,
      buyVolume: Math.round(buyVol * 100) / 100,
      sellVolume: Math.round(sellVol * 100) / 100,
      totalVolume: Math.round(totalVol * 100) / 100,
      imbalanceRatio: Math.round(ratio * 10000) / 10000,
      imbalancePct: Math.round(Math.abs(ratio) * 10000) / 100,
      dominantSide: ratio > 0.05 ? 'buy' : ratio < -0.05 ? 'sell' : 'neutral',
      buyCount: buys.length,
      sellCount: sells.length,
      avgBuySize: buys.length > 0 ? Math.round((buyVol / buys.length) * 100) / 100 : 0,
      avgSellSize: sells.length > 0 ? Math.round((sellVol / sells.length) * 100) / 100 : 0,
      vwapBuy: Math.round(vwapBuy * 100) / 100,
      vwapSell: Math.round(vwapSell * 100) / 100,
      pressure: classifyPressure(ratio),
      timestamp: isoNow(),
    };
  }

  // ─── Trade Flow Toxicity ────────────────────────────────────────────

  /**
   * Compute trade-flow toxicity metrics for a symbol.
   *
   * Estimates VPIN, Kyle's lambda, adverse-selection component, the Roll
   * effective spread, and the Amihud illiquidity ratio.
   */
  getToxicityScore(symbol: string, windowMs?: number): ToxicityScore {
    const upper = symbol.toUpperCase();
    const window = windowMs ?? DEFAULT_WINDOW_MS;
    const cutoff = Date.now() - window;
    const trades = (this.trades.get(upper) ?? []).filter((t) => new Date(t.timestamp).getTime() >= cutoff);

    // ── VPIN (Volume-synchronised Probability of Informed Trading) ────
    // Bucket trades into N equal-volume buckets, compute |buyVol-sellVol|/bucketVol
    const bucketCount = Math.max(1, Math.min(50, Math.floor(trades.length / 5)));
    const totalVol = trades.reduce((s, t) => s + t.quantity * t.price, 0);
    const bucketSize = totalVol / bucketCount;

    let vpin = 0;
    if (bucketSize > 0 && trades.length > 0) {
      let currentBuyVol = 0;
      let currentSellVol = 0;
      let currentBucketVol = 0;
      let vpinSum = 0;
      let bucketsDone = 0;

      for (const t of trades) {
        const vol = t.quantity * t.price;
        if (t.side === 'buy') currentBuyVol += vol; else currentSellVol += vol;
        currentBucketVol += vol;

        if (currentBucketVol >= bucketSize) {
          vpinSum += Math.abs(currentBuyVol - currentSellVol) / currentBucketVol;
          bucketsDone += 1;
          currentBuyVol = 0;
          currentSellVol = 0;
          currentBucketVol = 0;
        }
      }
      vpin = bucketsDone > 0 ? vpinSum / bucketsDone : 0;
    }

    // ── Kyle's Lambda (price impact per unit volume) ─────────────────
    const prices = trades.map((t) => t.price);
    const volumes = trades.map((t) => t.quantity * t.price);
    let kyleLambda = 0;
    if (prices.length >= 2) {
      const returns = prices.slice(1).map((p, i) => (p - prices[i]) / prices[i]);
      const cumVol = volumes.slice(1);
      // Simple regression: lambda ≈ avg(|return|) / avg(volume)
      const avgAbsReturn = returns.reduce((s, r) => s + Math.abs(r), 0) / returns.length;
      const avgVol = cumVol.reduce((s, v) => s + v, 0) / cumVol.length;
      kyleLambda = avgVol > 0 ? avgAbsReturn / avgVol : 0;
    }

    // ── Adverse-selection component ──────────────────────────────────
    // Fraction of spread attributable to information: use VPIN as proxy
    const adverseSelectionPct = Math.min(1, vpin);

    // ── Roll Effective Spread ────────────────────────────────────────
    // Roll (1984): √(-cov(Δp_t, Δp_{t-1})) × 2
    let rollSpread = 0;
    if (prices.length >= 3) {
      const diffs = prices.slice(1).map((p, i) => p - prices[i]);
      const n = diffs.length - 1;
      if (n > 0) {
        const mean1 = diffs.slice(0, n).reduce((s, v) => s + v, 0) / n;
        const mean2 = diffs.slice(1).reduce((s, v) => s + v, 0) / n;
        let cov = 0;
        for (let i = 0; i < n; i++) {
          cov += (diffs[i] - mean1) * (diffs[i + 1] - mean2);
        }
        cov /= n;
        rollSpread = cov < 0 ? 2 * Math.sqrt(-cov) : 0;
      }
    }

    // ── Amihud Illiquidity Ratio ─────────────────────────────────────
    // Average |return| / volume
    let amihudRatio = 0;
    if (prices.length >= 2) {
      let amihudSum = 0;
      let count = 0;
      for (let i = 1; i < prices.length; i++) {
        const absReturn = Math.abs((prices[i] - prices[i - 1]) / prices[i - 1]);
        const vol = volumes[i];
        if (vol > 0) {
          amihudSum += absReturn / vol;
          count += 1;
        }
      }
      amihudRatio = count > 0 ? amihudSum / count : 0;
    }

    // ── Overall score (0-100) ────────────────────────────────────────
    // Weighted combination normalised to 0-100
    const vpinScore = Math.min(1, vpin) * 40;
    const lambdaScore = Math.min(1, kyleLambda * 1_000_000) * 20;
    const amihudScore = Math.min(1, amihudRatio * 100_000) * 20;
    const rollScore = Math.min(1, rollSpread / (prices.length > 0 ? prices[prices.length - 1] || 1 : 1)) * 20;
    const overallScore = Math.round(Math.min(100, vpinScore + lambdaScore + amihudScore + rollScore));

    return {
      symbol: upper,
      vpin: Math.round(vpin * 10000) / 10000,
      kyleLambda: Number(kyleLambda.toExponential(4)),
      adverseSelectionPct: Math.round(adverseSelectionPct * 10000) / 10000,
      rollSpread: Math.round(rollSpread * 1e8) / 1e8,
      amihudRatio: Number(amihudRatio.toExponential(4)),
      overallScore,
      level: classifyToxicity(overallScore),
      tradeCount: trades.length,
      analysisWindowMs: window,
      timestamp: isoNow(),
    };
  }

  // ─── Bid-Ask Spread Analysis ────────────────────────────────────────

  /**
   * Analyse recorded spread snapshots for a symbol.
   */
  getSpreadAnalysis(symbol: string, limit?: number): SpreadAnalysis {
    const upper = symbol.toUpperCase();
    const snapshots = (this.spreads.get(upper) ?? []).slice(-(limit ?? MAX_SPREAD_SNAPSHOTS));
    const bpsArr = snapshots.map((s) => s.spreadBps);

    const current = snapshots.length > 0
      ? snapshots[snapshots.length - 1]
      : { bid: 0, ask: 0, spreadAbsolute: 0, spreadBps: 0, midPrice: 0, timestamp: isoNow() };

    const avgBps = bpsArr.length > 0 ? bpsArr.reduce((s, v) => s + v, 0) / bpsArr.length : 0;
    const minBps = bpsArr.length > 0 ? Math.min(...bpsArr) : 0;
    const maxBps = bpsArr.length > 0 ? Math.max(...bpsArr) : 0;
    const medBps = median(bpsArr);
    const sdBps = stdDev(bpsArr);

    // widening trend: compare recent half to older half
    let wideningTrend = false;
    if (bpsArr.length >= 4) {
      const mid = Math.floor(bpsArr.length / 2);
      const olderAvg = bpsArr.slice(0, mid).reduce((s, v) => s + v, 0) / mid;
      const newerAvg = bpsArr.slice(mid).reduce((s, v) => s + v, 0) / (bpsArr.length - mid);
      wideningTrend = newerAvg > olderAvg * 1.1; // 10 % wider
    }

    return {
      symbol: upper,
      current: structuredClone(current),
      avgSpreadBps: Math.round(avgBps * 100) / 100,
      minSpreadBps: Math.round(minBps * 100) / 100,
      maxSpreadBps: Math.round(maxBps * 100) / 100,
      medianSpreadBps: Math.round(medBps * 100) / 100,
      stdDevBps: Math.round(sdBps * 100) / 100,
      wideningTrend,
      snapshots: snapshots.map((s) => structuredClone(s)),
      timestamp: isoNow(),
    };
  }

  // ─── Volume Profile ─────────────────────────────────────────────────

  /**
   * Build a volume-at-price profile for a symbol.
   */
  getVolumeProfile(symbol: string, buckets?: number): VolumeProfile {
    const upper = symbol.toUpperCase();
    const trades = this.trades.get(upper) ?? [];
    const numBuckets = buckets ?? VOLUME_PROFILE_BUCKETS;

    if (trades.length === 0) {
      return {
        symbol: upper, levels: [], pocPrice: 0, pocVolume: 0,
        valueAreaHigh: 0, valueAreaLow: 0, totalVolume: 0,
        bucketSize: 0, timestamp: isoNow(),
      };
    }

    const prices = trades.map((t) => t.price);
    const minP = Math.min(...prices);
    const maxP = Math.max(...prices);
    const range = maxP - minP || 1;
    const bucketSz = range / numBuckets;

    // Initialise buckets
    const levelsMap: Map<number, VolumeLevel> = new Map();
    for (let i = 0; i < numBuckets; i++) {
      const lvl = Math.round((minP + bucketSz * (i + 0.5)) * 100) / 100;
      levelsMap.set(i, {
        priceLevel: lvl,
        volume: 0,
        buyVolume: 0,
        sellVolume: 0,
        tradeCount: 0,
        pctOfTotal: 0,
      });
    }

    let totalVol = 0;
    for (const t of trades) {
      const idx = Math.min(Math.floor((t.price - minP) / bucketSz), numBuckets - 1);
      const lvl = levelsMap.get(idx)!;
      const vol = t.quantity * t.price;
      lvl.volume += vol;
      if (t.side === 'buy') lvl.buyVolume += vol; else lvl.sellVolume += vol;
      lvl.tradeCount += 1;
      totalVol += vol;
    }

    const levels = Array.from(levelsMap.values());

    // Round and compute percentages
    for (const l of levels) {
      l.volume = Math.round(l.volume * 100) / 100;
      l.buyVolume = Math.round(l.buyVolume * 100) / 100;
      l.sellVolume = Math.round(l.sellVolume * 100) / 100;
      l.pctOfTotal = totalVol > 0 ? Math.round((l.volume / totalVol) * 10000) / 100 : 0;
    }

    // POC
    const poc = levels.reduce((best, l) => l.volume > best.volume ? l : best, levels[0]);

    // Value Area (70 % volume around POC)
    const sortedByVol = [...levels].sort((a, b) => b.volume - a.volume);
    let vaVolume = 0;
    const vaLevels: number[] = [];
    for (const l of sortedByVol) {
      vaVolume += l.volume;
      vaLevels.push(l.priceLevel);
      if (vaVolume >= totalVol * VALUE_AREA_PCT) break;
    }
    vaLevels.sort((a, b) => a - b);

    return {
      symbol: upper,
      levels,
      pocPrice: poc.priceLevel,
      pocVolume: Math.round(poc.volume * 100) / 100,
      valueAreaHigh: vaLevels.length > 0 ? vaLevels[vaLevels.length - 1] : 0,
      valueAreaLow: vaLevels.length > 0 ? vaLevels[0] : 0,
      totalVolume: Math.round(totalVol * 100) / 100,
      bucketSize: Math.round(bucketSz * 100) / 100,
      timestamp: isoNow(),
    };
  }

  // ─── Market Depth Delta ─────────────────────────────────────────────

  /**
   * Compute the delta between the two most recent depth snapshots.
   */
  getDepthDelta(symbol: string): DepthDelta {
    const upper = symbol.toUpperCase();
    const snaps = this.depthSnapshots.get(upper) ?? [];

    if (snaps.length < 2) {
      return {
        symbol: upper,
        bidDelta: 0, askDelta: 0, netDelta: 0,
        bidLevelsAdded: 0, bidLevelsRemoved: 0,
        askLevelsAdded: 0, askLevelsRemoved: 0,
        significantChanges: [],
        snapshotCount: snaps.length,
        timestamp: isoNow(),
      };
    }

    const prev = snaps[snaps.length - 2];
    const curr = snaps[snaps.length - 1];

    const bidDelta = curr.bidTotal - prev.bidTotal;
    const askDelta = curr.askTotal - prev.askTotal;

    // Level diffs
    const prevBidPrices = new Set(prev.bids.map((b) => b.price));
    const currBidPrices = new Set(curr.bids.map((b) => b.price));
    const prevAskPrices = new Set(prev.asks.map((a) => a.price));
    const currAskPrices = new Set(curr.asks.map((a) => a.price));

    const bidLevelsAdded = [...currBidPrices].filter((p) => !prevBidPrices.has(p)).length;
    const bidLevelsRemoved = [...prevBidPrices].filter((p) => !currBidPrices.has(p)).length;
    const askLevelsAdded = [...currAskPrices].filter((p) => !prevAskPrices.has(p)).length;
    const askLevelsRemoved = [...prevAskPrices].filter((p) => !currAskPrices.has(p)).length;

    // Significant changes (> 20 % change on a level)
    const significantChanges: DepthDelta['significantChanges'] = [];
    const prevBidMap = new Map(prev.bids.map((b) => [b.price, b.quantity]));
    const prevAskMap = new Map(prev.asks.map((a) => [a.price, a.quantity]));

    for (const b of curr.bids) {
      const old = prevBidMap.get(b.price) ?? 0;
      if (old > 0) {
        const changePct = ((b.quantity - old) / old) * 100;
        if (Math.abs(changePct) >= 20) {
          significantChanges.push({
            side: 'bid', price: b.price, oldQuantity: old,
            newQuantity: b.quantity, changePercent: Math.round(changePct * 100) / 100,
          });
        }
      }
    }
    for (const a of curr.asks) {
      const old = prevAskMap.get(a.price) ?? 0;
      if (old > 0) {
        const changePct = ((a.quantity - old) / old) * 100;
        if (Math.abs(changePct) >= 20) {
          significantChanges.push({
            side: 'ask', price: a.price, oldQuantity: old,
            newQuantity: a.quantity, changePercent: Math.round(changePct * 100) / 100,
          });
        }
      }
    }

    return {
      symbol: upper,
      bidDelta: Math.round(bidDelta * 1e8) / 1e8,
      askDelta: Math.round(askDelta * 1e8) / 1e8,
      netDelta: Math.round((bidDelta - askDelta) * 1e8) / 1e8,
      bidLevelsAdded,
      bidLevelsRemoved,
      askLevelsAdded,
      askLevelsRemoved,
      significantChanges,
      snapshotCount: snaps.length,
      timestamp: isoNow(),
    };
  }

  // ─── Whale Detection ────────────────────────────────────────────────

  /**
   * Return detected whale activity for a symbol.
   */
  getWhaleActivity(symbol: string): WhaleActivity {
    const upper = symbol.toUpperCase();
    const orders = this.whaleOrders.get(upper) ?? [];

    const buyOrders = orders.filter((o) => o.side === 'buy');
    const sellOrders = orders.filter((o) => o.side === 'sell');
    const buyVol = buyOrders.reduce((s, o) => s + o.notionalUsd, 0);
    const sellVol = sellOrders.reduce((s, o) => s + o.notionalUsd, 0);
    const totalVol = buyVol + sellVol;
    const imbalance = totalVol > 0 ? (buyVol - sellVol) / totalVol : 0;

    const largest = orders.length > 0
      ? orders.reduce((best, o) => o.notionalUsd > best.notionalUsd ? o : best, orders[0])
      : null;

    return {
      symbol: upper,
      whaleOrders: orders.map((o) => structuredClone(o)),
      totalWhaleVolume: Math.round(totalVol * 100) / 100,
      whaleBuyVolume: Math.round(buyVol * 100) / 100,
      whaleSellVolume: Math.round(sellVol * 100) / 100,
      whaleImbalance: Math.round(imbalance * 10000) / 10000,
      whaleCount: orders.length,
      avgWhaleSize: orders.length > 0 ? Math.round((totalVol / orders.length) * 100) / 100 : 0,
      largestOrder: largest ? structuredClone(largest) : null,
      dominantSide: imbalance > 0.05 ? 'buy' : imbalance < -0.05 ? 'sell' : 'neutral',
      alertLevel: classifyWhaleAlert(orders.length, imbalance),
      timestamp: isoNow(),
    };
  }

  // ─── Private Helpers ────────────────────────────────────────────────

  private detectWhale(trade: Trade): void {
    const symbol = trade.symbol;
    const trades = this.trades.get(symbol) ?? [];
    if (trades.length < 3) return;

    const avgSize = trades.reduce((s, t) => s + t.quantity * t.price, 0) / trades.length;
    const tradeNotional = trade.quantity * trade.price;

    if (tradeNotional >= avgSize * WHALE_THRESHOLD_MULTIPLIER) {
      const whale: WhaleOrder = {
        id: nextWhaleId(),
        symbol,
        side: trade.side,
        price: trade.price,
        quantity: trade.quantity,
        notionalUsd: Math.round(tradeNotional * 100) / 100,
        detectedAt: isoNow(),
        type: 'single_trade',
      };

      if (!this.whaleOrders.has(symbol)) this.whaleOrders.set(symbol, []);
      const list = this.whaleOrders.get(symbol)!;
      list.push(whale);
      if (list.length > MAX_WHALE_ORDERS) list.splice(0, list.length - MAX_WHALE_ORDERS);
    }
  }

  /**
   * Seed demo data so the service is useful out-of-the-box.
   */
  private seedDemoData(): void {
    const now = Date.now();
    const symbols = ['SOL', 'BONK', 'JUP'];
    const basePrices: Record<string, number> = { SOL: 100, BONK: 0.002, JUP: 5 };

    for (const sym of symbols) {
      const base = basePrices[sym];
      // Seed trades
      for (let i = 0; i < 60; i++) {
        const side: 'buy' | 'sell' = Math.random() > 0.45 ? 'buy' : 'sell';
        const price = base * (1 + (Math.random() - 0.5) * 0.02);
        const qty = (Math.random() * 100 + 1) / base;
        this.recordTrade({
          symbol: sym,
          side,
          price,
          quantity: qty,
          timestamp: new Date(now - (60 - i) * 5000).toISOString(),
        });
      }

      // Seed a whale trade
      const whaleQty = (5000 / base);
      this.recordTrade({
        symbol: sym,
        side: 'buy',
        price: base * 1.005,
        quantity: whaleQty,
        timestamp: new Date(now - 1000).toISOString(),
      });

      // Seed spread snapshots
      for (let i = 0; i < 30; i++) {
        const mid = base * (1 + (Math.random() - 0.5) * 0.01);
        const halfSpread = mid * (0.0005 + Math.random() * 0.002);
        this.recordSpread(sym, mid - halfSpread, mid + halfSpread);
      }

      // Seed two depth snapshots for delta
      const makeBids = (px: number, mult: number) => [
        { price: px * 0.999, quantity: 100 * mult, total: 100 * mult },
        { price: px * 0.998, quantity: 200 * mult, total: 300 * mult },
        { price: px * 0.995, quantity: 300 * mult, total: 600 * mult },
      ];
      const makeAsks = (px: number, mult: number) => [
        { price: px * 1.001, quantity: 120 * mult, total: 120 * mult },
        { price: px * 1.002, quantity: 180 * mult, total: 300 * mult },
        { price: px * 1.005, quantity: 250 * mult, total: 550 * mult },
      ];

      this.recordDepth({
        symbol: sym,
        bids: makeBids(base, 1),
        asks: makeAsks(base, 1),
        timestamp: new Date(now - 60_000).toISOString(),
      });
      this.recordDepth({
        symbol: sym,
        bids: makeBids(base, 1.2),
        asks: makeAsks(base, 0.9),
        timestamp: new Date(now).toISOString(),
      });
    }
  }
}
