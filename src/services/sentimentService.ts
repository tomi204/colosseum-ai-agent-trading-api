/**
 * Market Sentiment Analysis Service.
 *
 * Computes market sentiment from price momentum, volume proxy,
 * agent consensus, and strategy agreement.
 *
 * Sentiment score: -100 (extreme fear) to +100 (extreme greed)
 */

import { z } from 'zod';
import { StateStore } from '../infra/storage/stateStore.js';
import { isoNow } from '../utils/time.js';

// ─── Schemas ────────────────────────────────────────────────────────────────

export const sentimentQuerySchema = z.object({
  symbol: z.string().min(1).max(20),
});

export const sentimentHistoryQuerySchema = z.object({
  symbol: z.string().min(1).max(20),
  limit: z.number().int().positive().max(500).optional(),
});

// ─── Types ──────────────────────────────────────────────────────────────────

export type SentimentClassification =
  | 'Extreme Fear'
  | 'Fear'
  | 'Neutral'
  | 'Greed'
  | 'Extreme Greed';

export interface SentimentBreakdown {
  priceMomentum: number;     // -100 to +100
  volumeProxy: number;       // -100 to +100
  agentConsensus: number;    // -100 to +100
  strategyAgreement: number; // -100 to +100
}

export interface SentimentReading {
  symbol: string;
  score: number;
  classification: SentimentClassification;
  breakdown: SentimentBreakdown;
  timestamp: string;
}

export interface SentimentOverviewEntry {
  symbol: string;
  score: number;
  classification: SentimentClassification;
  timestamp: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_HISTORY_PER_SYMBOL = 500;
const MOMENTUM_WINDOW = 10;

// Component weights for final score (sum to 1.0)
const WEIGHT_MOMENTUM = 0.35;
const WEIGHT_VOLUME = 0.20;
const WEIGHT_CONSENSUS = 0.25;
const WEIGHT_STRATEGY = 0.20;

// ─── Helpers ────────────────────────────────────────────────────────────────

function classifySentiment(score: number): SentimentClassification {
  if (score <= -60) return 'Extreme Fear';
  if (score <= -20) return 'Fear';
  if (score <= 20) return 'Neutral';
  if (score <= 60) return 'Greed';
  return 'Extreme Greed';
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// ─── Service ────────────────────────────────────────────────────────────────

export class SentimentService {
  /** symbol → historical sentiment readings */
  private history: Map<string, SentimentReading[]> = new Map();

  constructor(private readonly store: StateStore) {}

  /**
   * Analyze current market sentiment for a symbol.
   *
   * Components:
   * 1. Price momentum — trend of last N prices
   * 2. Volume proxy — trade frequency from execution history
   * 3. Agent consensus — net buy/sell sentiment across agents
   * 4. Strategy agreement — do multiple strategies agree on direction
   */
  analyzeSentiment(symbol: string): SentimentReading {
    const upper = symbol.toUpperCase();
    const state = this.store.snapshot();

    const priceMomentum = this.computePriceMomentum(upper, state);
    const volumeProxy = this.computeVolumeProxy(upper, state);
    const agentConsensus = this.computeAgentConsensus(upper, state);
    const strategyAgreement = this.computeStrategyAgreement(upper, state);

    const rawScore =
      priceMomentum * WEIGHT_MOMENTUM +
      volumeProxy * WEIGHT_VOLUME +
      agentConsensus * WEIGHT_CONSENSUS +
      strategyAgreement * WEIGHT_STRATEGY;

    const score = clamp(Math.round(rawScore), -100, 100);
    const classification = classifySentiment(score);

    const reading: SentimentReading = {
      symbol: upper,
      score,
      classification,
      breakdown: {
        priceMomentum: clamp(Math.round(priceMomentum), -100, 100),
        volumeProxy: clamp(Math.round(volumeProxy), -100, 100),
        agentConsensus: clamp(Math.round(agentConsensus), -100, 100),
        strategyAgreement: clamp(Math.round(strategyAgreement), -100, 100),
      },
      timestamp: isoNow(),
    };

    // Store in history
    if (!this.history.has(upper)) {
      this.history.set(upper, []);
    }

    const symbolHistory = this.history.get(upper)!;
    symbolHistory.unshift(reading);

    if (symbolHistory.length > MAX_HISTORY_PER_SYMBOL) {
      symbolHistory.length = MAX_HISTORY_PER_SYMBOL;
    }

    return structuredClone(reading);
  }

  /**
   * Get historical sentiment readings for a symbol.
   */
  getSentimentHistory(symbol: string, limit = 50): SentimentReading[] {
    const upper = symbol.toUpperCase();
    const symbolHistory = this.history.get(upper) ?? [];
    return symbolHistory
      .slice(0, Math.min(limit, MAX_HISTORY_PER_SYMBOL))
      .map((r) => structuredClone(r));
  }

  /**
   * Get overview of all tracked symbols' latest sentiment.
   */
  getOverview(): SentimentOverviewEntry[] {
    const entries: SentimentOverviewEntry[] = [];

    for (const [symbol, readings] of this.history) {
      if (readings.length === 0) continue;
      const latest = readings[0];
      entries.push({
        symbol,
        score: latest.score,
        classification: latest.classification,
        timestamp: latest.timestamp,
      });
    }

    return entries.sort((a, b) => b.score - a.score);
  }

  // ─── Private computation methods ──────────────────────────────────────

  /**
   * Price momentum: analyze the last N prices to determine trend.
   * Uses rate of change and direction consistency.
   * Returns -100 to +100.
   */
  private computePriceMomentum(
    symbol: string,
    state: { marketPriceHistoryUsd: Record<string, { ts: string; priceUsd: number }[]> },
  ): number {
    const priceHistory = state.marketPriceHistoryUsd[symbol];
    if (!priceHistory || priceHistory.length < 2) return 0;

    const recent = priceHistory.slice(-MOMENTUM_WINDOW);
    if (recent.length < 2) return 0;

    const first = recent[0].priceUsd;
    const last = recent[recent.length - 1].priceUsd;

    if (first === 0) return 0;

    // Rate of change as percentage
    const roc = ((last - first) / first) * 100;

    // Count up vs down moves for consistency
    let upMoves = 0;
    let downMoves = 0;
    for (let i = 1; i < recent.length; i++) {
      if (recent[i].priceUsd > recent[i - 1].priceUsd) upMoves++;
      else if (recent[i].priceUsd < recent[i - 1].priceUsd) downMoves++;
    }

    const totalMoves = upMoves + downMoves;
    const consistency = totalMoves > 0
      ? (Math.abs(upMoves - downMoves) / totalMoves)
      : 0;

    // Combine ROC magnitude with direction consistency
    // Cap ROC contribution at ±10% → ±80 points
    const rocScore = clamp(roc * 8, -80, 80);
    const consistencyBonus = consistency * 20 * Math.sign(rocScore || (upMoves > downMoves ? 1 : -1));

    return clamp(rocScore + consistencyBonus, -100, 100);
  }

  /**
   * Volume proxy: trade frequency from execution history.
   * More recent trades = higher activity = more greed.
   * Returns -100 to +100.
   */
  private computeVolumeProxy(
    symbol: string,
    state: { executions: Record<string, { symbol: string; createdAt: string; status: string }> },
  ): number {
    const executions = Object.values(state.executions)
      .filter((ex) => ex.symbol === symbol && ex.status === 'filled');

    if (executions.length === 0) return 0;

    // Count executions in last "hour" vs older ones
    const now = Date.now();
    const oneHourAgo = now - 3_600_000;
    const oneDayAgo = now - 86_400_000;

    let recentCount = 0;
    let dayCount = 0;

    for (const ex of executions) {
      const ts = new Date(ex.createdAt).getTime();
      if (ts >= oneHourAgo) recentCount++;
      if (ts >= oneDayAgo) dayCount++;
    }

    // Baseline: normalize around expected activity
    // More recent activity → positive (greed); less → negative (fear)
    if (dayCount === 0) return -30; // no activity = mild fear

    const recentRatio = dayCount > 0 ? recentCount / dayCount : 0;

    // If recent activity is high proportion, that's greedy
    // Score: recentRatio > 0.5 → positive, < 0.2 → negative
    const baseScore = (recentRatio - 0.3) * 200;

    // Add bonus for high absolute volume
    const volumeBonus = clamp(dayCount * 5, 0, 30);

    return clamp(baseScore + volumeBonus, -100, 100);
  }

  /**
   * Agent consensus: what are most agents doing with this symbol?
   * More net buying = greed, more net selling = fear.
   * Returns -100 to +100.
   */
  private computeAgentConsensus(
    symbol: string,
    state: {
      agents: Record<string, { positions: Record<string, { quantity: number }> }>;
      executions: Record<string, { symbol: string; side: string; agentId: string; status: string }>;
    },
  ): number {
    // Count agents with positions in this symbol
    const agentIds = Object.keys(state.agents);
    if (agentIds.length === 0) return 0;

    let holdingAgents = 0;
    for (const agent of Object.values(state.agents)) {
      if (agent.positions[symbol] && agent.positions[symbol].quantity > 0) {
        holdingAgents++;
      }
    }

    // Count recent buy vs sell executions across agents
    const recentExecs = Object.values(state.executions)
      .filter((ex) => ex.symbol === symbol && ex.status === 'filled');

    let buyAgents = new Set<string>();
    let sellAgents = new Set<string>();

    for (const ex of recentExecs) {
      if (ex.side === 'buy') buyAgents.add(ex.agentId);
      else sellAgents.add(ex.agentId);
    }

    const totalActiveAgents = new Set([...buyAgents, ...sellAgents]).size;
    if (totalActiveAgents === 0 && holdingAgents === 0) return 0;

    // Holding ratio
    const holdingRatio = agentIds.length > 0
      ? holdingAgents / agentIds.length
      : 0;

    // Buy/sell ratio
    const buyCount = buyAgents.size;
    const sellCount = sellAgents.size;
    const netDirection = totalActiveAgents > 0
      ? (buyCount - sellCount) / totalActiveAgents
      : 0;

    // Combine: holding adds baseline, net direction adds momentum
    const holdingScore = (holdingRatio - 0.3) * 100;
    const directionScore = netDirection * 80;

    return clamp(holdingScore + directionScore, -100, 100);
  }

  /**
   * Strategy agreement: do multiple strategies agree on direction?
   * If most agents using different strategies all buy → strong greed signal.
   * Returns -100 to +100.
   */
  private computeStrategyAgreement(
    symbol: string,
    state: {
      agents: Record<string, { id: string; strategyId: string }>;
      executions: Record<string, { symbol: string; side: string; agentId: string; status: string }>;
    },
  ): number {
    // Group agents by strategy
    const strategyDirections: Map<string, { buys: number; sells: number }> = new Map();

    const symbolExecs = Object.values(state.executions)
      .filter((ex) => ex.symbol === symbol && ex.status === 'filled');

    for (const ex of symbolExecs) {
      const agent = state.agents[ex.agentId];
      if (!agent) continue;

      const stratId = agent.strategyId;
      if (!strategyDirections.has(stratId)) {
        strategyDirections.set(stratId, { buys: 0, sells: 0 });
      }

      const dir = strategyDirections.get(stratId)!;
      if (ex.side === 'buy') dir.buys++;
      else dir.sells++;
    }

    if (strategyDirections.size === 0) return 0;

    // Determine each strategy's net direction
    let bullishStrategies = 0;
    let bearishStrategies = 0;

    for (const dir of strategyDirections.values()) {
      if (dir.buys > dir.sells) bullishStrategies++;
      else if (dir.sells > dir.buys) bearishStrategies++;
    }

    const totalStrategies = strategyDirections.size;
    if (totalStrategies === 0) return 0;

    // Agreement score: all agree → strong signal; split → neutral
    const netAgreement = (bullishStrategies - bearishStrategies) / totalStrategies;

    // Bonus for more strategies agreeing
    const diversityBonus = totalStrategies > 1 ? 20 : 0;

    return clamp(netAgreement * (80 + diversityBonus), -100, 100);
  }
}
