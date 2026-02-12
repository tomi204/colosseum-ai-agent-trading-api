/**
 * Market Making Engine — automated market making service.
 *
 * Features:
 * - Dynamic spread calculation based on volatility + inventory risk
 * - Inventory management (track and rebalance inventory)
 * - Quote generation (bid/ask quotes with configurable depth)
 * - PnL tracking for market making activities
 * - Risk limits for market makers (max inventory, max loss, etc.)
 * - Maker/taker fee optimization
 */

import { StateStore } from '../infra/storage/stateStore.js';
import { isoNow } from '../utils/time.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface MarketMakingConfig {
  /** Target half-spread in basis points (default: 30 bps) */
  baseSpreadBps: number;
  /** Order depth – number of quote levels on each side (default: 5) */
  depth: number;
  /** Step between depth levels as multiple of base spread (default: 0.5) */
  depthStepMultiplier: number;
  /** Size per level in USD notional (default: 100) */
  orderSizeUsd: number;
  /** Volatility lookback window in ms (default: 5 min) */
  volatilityWindowMs: number;
  /** Volatility multiplier applied to spread (default: 2.0) */
  volatilityMultiplier: number;
  /** Inventory skew factor – how aggressively spread skews with inventory (default: 0.5) */
  inventorySkewFactor: number;
  /** Maximum inventory in base units before hedging (default: 1000) */
  maxInventory: number;
  /** Maximum unrealised loss in USD before session halts (default: -500) */
  maxLossUsd: number;
  /** Maker fee rate (default: 0.0002 = 2 bps) */
  makerFeeRate: number;
  /** Taker fee rate (default: 0.0005 = 5 bps) */
  takerFeeRate: number;
  /** Refresh interval for quote updates in ms (default: 1000) */
  refreshIntervalMs: number;
}

export interface MarketMakingSession {
  id: string;
  agentId: string;
  pair: string;
  status: 'active' | 'stopped' | 'halted';
  haltReason?: string;
  config: MarketMakingConfig;
  inventory: InventoryState;
  pnl: PnLState;
  quotes: QuoteSet;
  createdAt: string;
  updatedAt: string;
  tradeCount: number;
  quoteRefreshCount: number;
}

export interface InventoryState {
  baseBalance: number;     // units of base asset
  quoteBalance: number;    // units of quote asset (USD)
  netExposure: number;     // baseBalance * midPrice
  inventoryRatio: number;  // baseBalance / maxInventory, range [-1, 1]
  avgEntryPrice: number;   // weighted average entry price for cost basis
  lastRebalanceAt: string | null;
  rebalanceCount: number;
}

export interface PnLState {
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  totalPnlUsd: number;
  feesEarnedUsd: number;
  feesPaidUsd: number;
  netFeesPnlUsd: number;
  tradeCount: number;
  makerTradeCount: number;
  takerTradeCount: number;
  avgSpreadCapturedBps: number;
  peakPnlUsd: number;
  drawdownUsd: number;
  drawdownPct: number;
  startedAt: string;
  updatedAt: string;
}

export interface QuoteLevel {
  price: number;
  size: number;
  sizeUsd: number;
  level: number;
}

export interface QuoteSet {
  pair: string;
  midPrice: number;
  bids: QuoteLevel[];
  asks: QuoteLevel[];
  spreadBps: number;
  effectiveSpreadBps: number;
  skewBps: number;
  volatilityBps: number;
  timestamp: string;
}

export interface MarketMakingTrade {
  id: string;
  sessionId: string;
  pair: string;
  side: 'buy' | 'sell';
  price: number;
  quantity: number;
  notionalUsd: number;
  feeUsd: number;
  feeType: 'maker' | 'taker';
  pnlImpactUsd: number;
  timestamp: string;
}

export interface SpreadCalculation {
  baseSpreadBps: number;
  volatilityComponentBps: number;
  inventorySkewBps: number;
  feeAdjustmentBps: number;
  finalBidSpreadBps: number;
  finalAskSpreadBps: number;
  midPrice: number;
  bidPrice: number;
  askPrice: number;
}

export interface PriceUpdate {
  pair: string;
  price: number;
  timestamp: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: MarketMakingConfig = {
  baseSpreadBps: 30,
  depth: 5,
  depthStepMultiplier: 0.5,
  orderSizeUsd: 100,
  volatilityWindowMs: 5 * 60 * 1000,
  volatilityMultiplier: 2.0,
  inventorySkewFactor: 0.5,
  maxInventory: 1000,
  maxLossUsd: -500,
  makerFeeRate: 0.0002,
  takerFeeRate: 0.0005,
  refreshIntervalMs: 1000,
};

const MAX_PRICE_HISTORY = 2000;
const MAX_TRADES_PER_SESSION = 5000;

// ─── Helpers ────────────────────────────────────────────────────────────────

let sessionIdCounter = 0;
function nextSessionId(): string {
  sessionIdCounter += 1;
  return `mm-${Date.now()}-${sessionIdCounter}`;
}

let tradeIdCounter = 0;
function nextTradeId(): string {
  tradeIdCounter += 1;
  return `mmt-${Date.now()}-${tradeIdCounter}`;
}

function computeVolatility(prices: number[]): number {
  if (prices.length < 2) return 0;
  const returns: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i - 1] > 0) {
      returns.push((prices[i] - prices[i - 1]) / prices[i - 1]);
    }
  }
  if (returns.length === 0) return 0;
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
  return Math.sqrt(variance);
}

// ─── Service ────────────────────────────────────────────────────────────────

export class MarketMakingService {
  /** sessionId → session */
  private sessions: Map<string, MarketMakingSession> = new Map();
  /** pair → price history (timestamped) */
  private priceHistory: Map<string, PriceUpdate[]> = new Map();
  /** sessionId → trades */
  private trades: Map<string, MarketMakingTrade[]> = new Map();

  constructor(private readonly store: StateStore) {}

  // ─── Session Management ─────────────────────────────────────────────

  /**
   * Start a new market making session for a trading pair.
   */
  startSession(params: {
    agentId: string;
    pair: string;
    config?: Partial<MarketMakingConfig>;
  }): MarketMakingSession {
    const pair = params.pair.toUpperCase();

    // Check if agent already has an active session for this pair
    for (const session of this.sessions.values()) {
      if (session.agentId === params.agentId && session.pair === pair && session.status === 'active') {
        throw new Error(`Agent ${params.agentId} already has an active session for ${pair}`);
      }
    }

    const config: MarketMakingConfig = { ...DEFAULT_CONFIG, ...params.config };
    const now = isoNow();

    const session: MarketMakingSession = {
      id: nextSessionId(),
      agentId: params.agentId,
      pair,
      status: 'active',
      config,
      inventory: {
        baseBalance: 0,
        quoteBalance: config.orderSizeUsd * config.depth * 2,
        netExposure: 0,
        inventoryRatio: 0,
        avgEntryPrice: 0,
        lastRebalanceAt: null,
        rebalanceCount: 0,
      },
      pnl: {
        realizedPnlUsd: 0,
        unrealizedPnlUsd: 0,
        totalPnlUsd: 0,
        feesEarnedUsd: 0,
        feesPaidUsd: 0,
        netFeesPnlUsd: 0,
        tradeCount: 0,
        makerTradeCount: 0,
        takerTradeCount: 0,
        avgSpreadCapturedBps: 0,
        peakPnlUsd: 0,
        drawdownUsd: 0,
        drawdownPct: 0,
        startedAt: now,
        updatedAt: now,
      },
      quotes: {
        pair,
        midPrice: 0,
        bids: [],
        asks: [],
        spreadBps: 0,
        effectiveSpreadBps: 0,
        skewBps: 0,
        volatilityBps: 0,
        timestamp: now,
      },
      createdAt: now,
      updatedAt: now,
      tradeCount: 0,
      quoteRefreshCount: 0,
    };

    this.sessions.set(session.id, session);
    this.trades.set(session.id, []);

    // Generate initial quotes if we have a price
    const midPrice = this.getLatestPrice(pair);
    if (midPrice > 0) {
      this.refreshQuotes(session.id);
    }

    return structuredClone(session);
  }

  /**
   * Stop a market making session.
   */
  stopSession(sessionId: string): MarketMakingSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    if (session.status !== 'active') {
      throw new Error(`Session ${sessionId} is already ${session.status}`);
    }

    session.status = 'stopped';
    session.updatedAt = isoNow();
    session.quotes = {
      ...session.quotes,
      bids: [],
      asks: [],
      timestamp: isoNow(),
    };

    return structuredClone(session);
  }

  /**
   * Get all active sessions, optionally filtered by agentId.
   */
  getActiveSessions(agentId?: string): MarketMakingSession[] {
    const sessions: MarketMakingSession[] = [];
    for (const session of this.sessions.values()) {
      if (agentId && session.agentId !== agentId) continue;
      sessions.push(structuredClone(session));
    }
    return sessions;
  }

  /**
   * Get a specific session.
   */
  getSession(sessionId: string): MarketMakingSession | null {
    const session = this.sessions.get(sessionId);
    return session ? structuredClone(session) : null;
  }

  // ─── Price Feed ─────────────────────────────────────────────────────

  /**
   * Feed a price update. Triggers quote refresh for all active sessions on this pair.
   */
  feedPrice(pair: string, price: number): void {
    const upper = pair.toUpperCase();
    const update: PriceUpdate = { pair: upper, price, timestamp: isoNow() };

    if (!this.priceHistory.has(upper)) this.priceHistory.set(upper, []);
    const history = this.priceHistory.get(upper)!;
    history.push(update);
    if (history.length > MAX_PRICE_HISTORY) history.splice(0, history.length - MAX_PRICE_HISTORY);

    // Refresh quotes for all active sessions on this pair
    for (const session of this.sessions.values()) {
      if (session.pair === upper && session.status === 'active') {
        this.refreshQuotes(session.id);
      }
    }
  }

  // ─── Spread Calculation ─────────────────────────────────────────────

  /**
   * Calculate dynamic spread based on volatility and inventory risk.
   */
  calculateSpread(sessionId: string): SpreadCalculation {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    const config = session.config;
    const midPrice = this.getLatestPrice(session.pair);

    // 1. Base spread component
    const baseSpreadBps = config.baseSpreadBps;

    // 2. Volatility component
    const volatility = this.getVolatility(session.pair, config.volatilityWindowMs);
    const volatilityBps = volatility * 10_000 * config.volatilityMultiplier;

    // 3. Inventory skew component – shift quotes to reduce inventory
    //    Positive inventory → lower bid, raise ask (discourage buying)
    //    Negative inventory → raise bid, lower ask (discourage selling)
    const inventoryRatio = session.inventory.inventoryRatio;
    const inventorySkewBps = inventoryRatio * config.inventorySkewFactor * baseSpreadBps;

    // 4. Fee adjustment – widen spread to cover taker fees, narrow for maker rebates
    const feeAdjustmentBps = (config.takerFeeRate - config.makerFeeRate) * 10_000 * 0.5;

    // 5. Combine into final bid/ask spreads
    const totalHalfSpread = baseSpreadBps + volatilityBps + feeAdjustmentBps;
    const finalBidSpreadBps = Math.max(1, totalHalfSpread + inventorySkewBps);
    const finalAskSpreadBps = Math.max(1, totalHalfSpread - inventorySkewBps);

    const bidPrice = midPrice > 0
      ? midPrice * (1 - finalBidSpreadBps / 10_000)
      : 0;
    const askPrice = midPrice > 0
      ? midPrice * (1 + finalAskSpreadBps / 10_000)
      : 0;

    return {
      baseSpreadBps,
      volatilityComponentBps: Math.round(volatilityBps * 100) / 100,
      inventorySkewBps: Math.round(inventorySkewBps * 100) / 100,
      feeAdjustmentBps: Math.round(feeAdjustmentBps * 100) / 100,
      finalBidSpreadBps: Math.round(finalBidSpreadBps * 100) / 100,
      finalAskSpreadBps: Math.round(finalAskSpreadBps * 100) / 100,
      midPrice,
      bidPrice: Math.round(bidPrice * 1e8) / 1e8,
      askPrice: Math.round(askPrice * 1e8) / 1e8,
    };
  }

  // ─── Quote Generation ───────────────────────────────────────────────

  /**
   * Refresh quotes for a session. Generates bid/ask levels with depth.
   */
  refreshQuotes(sessionId: string): QuoteSet {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    if (session.status !== 'active') throw new Error(`Session ${sessionId} is not active`);

    const spread = this.calculateSpread(sessionId);
    const config = session.config;
    const midPrice = spread.midPrice;

    if (midPrice <= 0) {
      session.quotes = {
        pair: session.pair,
        midPrice: 0,
        bids: [],
        asks: [],
        spreadBps: 0,
        effectiveSpreadBps: 0,
        skewBps: 0,
        volatilityBps: 0,
        timestamp: isoNow(),
      };
      return structuredClone(session.quotes);
    }

    const bids: QuoteLevel[] = [];
    const asks: QuoteLevel[] = [];

    for (let i = 0; i < config.depth; i++) {
      const levelOffset = i * config.depthStepMultiplier * config.baseSpreadBps;

      // Bid levels go down from best bid
      const bidBps = spread.finalBidSpreadBps + levelOffset;
      const bidPrice = midPrice * (1 - bidBps / 10_000);
      const bidSize = bidPrice > 0 ? config.orderSizeUsd / bidPrice : 0;
      bids.push({
        price: Math.round(bidPrice * 1e8) / 1e8,
        size: Math.round(bidSize * 1e8) / 1e8,
        sizeUsd: config.orderSizeUsd,
        level: i + 1,
      });

      // Ask levels go up from best ask
      const askBps = spread.finalAskSpreadBps + levelOffset;
      const askPrice = midPrice * (1 + askBps / 10_000);
      const askSize = askPrice > 0 ? config.orderSizeUsd / askPrice : 0;
      asks.push({
        price: Math.round(askPrice * 1e8) / 1e8,
        size: Math.round(askSize * 1e8) / 1e8,
        sizeUsd: config.orderSizeUsd,
        level: i + 1,
      });
    }

    const totalSpreadBps = spread.finalBidSpreadBps + spread.finalAskSpreadBps;
    const skewBps = spread.finalAskSpreadBps - spread.finalBidSpreadBps;

    session.quotes = {
      pair: session.pair,
      midPrice,
      bids,
      asks,
      spreadBps: Math.round(totalSpreadBps * 100) / 100,
      effectiveSpreadBps: Math.round(totalSpreadBps * 100) / 100,
      skewBps: Math.round(skewBps * 100) / 100,
      volatilityBps: spread.volatilityComponentBps,
      timestamp: isoNow(),
    };

    session.quoteRefreshCount += 1;
    session.updatedAt = isoNow();

    return structuredClone(session.quotes);
  }

  /**
   * Get current quotes for a pair across all active sessions.
   */
  getQuotesForPair(pair: string): QuoteSet[] {
    const upper = pair.toUpperCase();
    const results: QuoteSet[] = [];
    for (const session of this.sessions.values()) {
      if (session.pair === upper && session.status === 'active') {
        results.push(structuredClone(session.quotes));
      }
    }
    return results;
  }

  // ─── Inventory Management ───────────────────────────────────────────

  /**
   * Record a trade fill against a session's inventory.
   */
  recordFill(params: {
    sessionId: string;
    side: 'buy' | 'sell';
    price: number;
    quantity: number;
    feeType: 'maker' | 'taker';
  }): MarketMakingTrade {
    const session = this.sessions.get(params.sessionId);
    if (!session) throw new Error(`Session ${params.sessionId} not found`);

    const config = session.config;
    const notionalUsd = params.price * params.quantity;
    const feeRate = params.feeType === 'maker' ? config.makerFeeRate : config.takerFeeRate;
    const feeUsd = notionalUsd * feeRate;

    // Compute PnL impact using cost basis
    const midPrice = this.getLatestPrice(session.pair);
    let pnlImpact = -feeUsd;

    if (params.side === 'buy') {
      // Update average entry price (weighted average)
      const prevCost = session.inventory.baseBalance * session.inventory.avgEntryPrice;
      const newCost = params.quantity * params.price;
      const newBalance = session.inventory.baseBalance + params.quantity;
      session.inventory.avgEntryPrice = newBalance > 0
        ? (prevCost + newCost) / newBalance
        : params.price;

      session.inventory.baseBalance += params.quantity;
      session.inventory.quoteBalance -= notionalUsd;
    } else {
      // Realised PnL = (sell price - avg entry) * quantity
      if (session.inventory.avgEntryPrice > 0) {
        pnlImpact += (params.price - session.inventory.avgEntryPrice) * params.quantity;
      }
      session.inventory.baseBalance -= params.quantity;
      session.inventory.quoteBalance += notionalUsd;
      // Reset avg entry price if position closed
      if (session.inventory.baseBalance <= 0) {
        session.inventory.avgEntryPrice = 0;
      }
    }

    // Update inventory ratio
    session.inventory.inventoryRatio = config.maxInventory > 0
      ? Math.max(-1, Math.min(1, session.inventory.baseBalance / config.maxInventory))
      : 0;

    // Update net exposure
    session.inventory.netExposure = session.inventory.baseBalance * midPrice;

    // Update PnL state
    session.pnl.realizedPnlUsd += pnlImpact;
    session.pnl.tradeCount += 1;
    if (params.feeType === 'maker') {
      session.pnl.feesEarnedUsd += feeUsd * 0.1; // maker rebate simulation
      session.pnl.feesPaidUsd += feeUsd * 0.9;
      session.pnl.makerTradeCount += 1;
    } else {
      session.pnl.feesPaidUsd += feeUsd;
      session.pnl.takerTradeCount += 1;
    }
    session.pnl.netFeesPnlUsd = session.pnl.feesEarnedUsd - session.pnl.feesPaidUsd;

    // Spread captured estimate
    const spreadCapture = Math.abs(params.price - midPrice) / midPrice * 10_000;
    const prevTotal = session.pnl.avgSpreadCapturedBps * (session.pnl.tradeCount - 1);
    session.pnl.avgSpreadCapturedBps = session.pnl.tradeCount > 0
      ? (prevTotal + spreadCapture) / session.pnl.tradeCount
      : 0;

    // Update unrealised PnL (mark-to-market vs cost basis)
    session.pnl.unrealizedPnlUsd = session.inventory.baseBalance > 0 && session.inventory.avgEntryPrice > 0
      ? session.inventory.baseBalance * (midPrice - session.inventory.avgEntryPrice)
      : 0;
    session.pnl.totalPnlUsd = session.pnl.realizedPnlUsd + session.pnl.unrealizedPnlUsd;

    // Track peak and drawdown
    if (session.pnl.totalPnlUsd > session.pnl.peakPnlUsd) {
      session.pnl.peakPnlUsd = session.pnl.totalPnlUsd;
    }
    session.pnl.drawdownUsd = session.pnl.peakPnlUsd - session.pnl.totalPnlUsd;
    session.pnl.drawdownPct = session.pnl.peakPnlUsd > 0
      ? session.pnl.drawdownUsd / session.pnl.peakPnlUsd
      : 0;

    session.pnl.updatedAt = isoNow();
    session.tradeCount += 1;
    session.updatedAt = isoNow();

    // Create trade record
    const trade: MarketMakingTrade = {
      id: nextTradeId(),
      sessionId: params.sessionId,
      pair: session.pair,
      side: params.side,
      price: params.price,
      quantity: params.quantity,
      notionalUsd: Math.round(notionalUsd * 100) / 100,
      feeUsd: Math.round(feeUsd * 100) / 100,
      feeType: params.feeType,
      pnlImpactUsd: Math.round(pnlImpact * 100) / 100,
      timestamp: isoNow(),
    };

    const sessionTrades = this.trades.get(params.sessionId) ?? [];
    sessionTrades.push(trade);
    if (sessionTrades.length > MAX_TRADES_PER_SESSION) {
      sessionTrades.splice(0, sessionTrades.length - MAX_TRADES_PER_SESSION);
    }
    this.trades.set(params.sessionId, sessionTrades);

    // Check risk limits
    this.checkRiskLimits(session);

    return structuredClone(trade);
  }

  /**
   * Rebalance inventory for a session by simulating a hedge trade.
   */
  rebalanceInventory(sessionId: string): { rebalanced: boolean; trade?: MarketMakingTrade; reason: string } {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    const ratio = Math.abs(session.inventory.inventoryRatio);
    if (ratio < 0.5) {
      return { rebalanced: false, reason: 'Inventory within acceptable range' };
    }

    const midPrice = this.getLatestPrice(session.pair);
    if (midPrice <= 0) {
      return { rebalanced: false, reason: 'No price available for rebalance' };
    }

    // Rebalance by trading to reduce inventory towards zero
    const side: 'buy' | 'sell' = session.inventory.baseBalance > 0 ? 'sell' : 'buy';
    const rebalanceQty = Math.abs(session.inventory.baseBalance) * 0.5; // reduce by 50%

    const trade = this.recordFill({
      sessionId,
      side,
      price: midPrice,
      quantity: rebalanceQty,
      feeType: 'taker',
    });

    session.inventory.lastRebalanceAt = isoNow();
    session.inventory.rebalanceCount += 1;

    return { rebalanced: true, trade, reason: `Rebalanced ${rebalanceQty.toFixed(4)} units via ${side}` };
  }

  // ─── PnL Tracking ──────────────────────────────────────────────────

  /**
   * Get PnL for a specific agent across all their sessions.
   */
  getAgentPnl(agentId: string): {
    agentId: string;
    sessions: Array<{
      sessionId: string;
      pair: string;
      status: string;
      pnl: PnLState;
    }>;
    aggregated: {
      totalRealizedPnlUsd: number;
      totalUnrealizedPnlUsd: number;
      totalPnlUsd: number;
      totalFeesEarnedUsd: number;
      totalFeesPaidUsd: number;
      totalTrades: number;
      totalMakerTrades: number;
      totalTakerTrades: number;
      makerRatio: number;
    };
    timestamp: string;
  } {
    const agentSessions: Array<{
      sessionId: string;
      pair: string;
      status: string;
      pnl: PnLState;
    }> = [];

    let totalRealized = 0;
    let totalUnrealized = 0;
    let totalFeesEarned = 0;
    let totalFeesPaid = 0;
    let totalTrades = 0;
    let totalMaker = 0;
    let totalTaker = 0;

    for (const session of this.sessions.values()) {
      if (session.agentId !== agentId) continue;
      agentSessions.push({
        sessionId: session.id,
        pair: session.pair,
        status: session.status,
        pnl: structuredClone(session.pnl),
      });
      totalRealized += session.pnl.realizedPnlUsd;
      totalUnrealized += session.pnl.unrealizedPnlUsd;
      totalFeesEarned += session.pnl.feesEarnedUsd;
      totalFeesPaid += session.pnl.feesPaidUsd;
      totalTrades += session.pnl.tradeCount;
      totalMaker += session.pnl.makerTradeCount;
      totalTaker += session.pnl.takerTradeCount;
    }

    return {
      agentId,
      sessions: agentSessions,
      aggregated: {
        totalRealizedPnlUsd: Math.round(totalRealized * 100) / 100,
        totalUnrealizedPnlUsd: Math.round(totalUnrealized * 100) / 100,
        totalPnlUsd: Math.round((totalRealized + totalUnrealized) * 100) / 100,
        totalFeesEarnedUsd: Math.round(totalFeesEarned * 100) / 100,
        totalFeesPaidUsd: Math.round(totalFeesPaid * 100) / 100,
        totalTrades,
        totalMakerTrades: totalMaker,
        totalTakerTrades: totalTaker,
        makerRatio: totalTrades > 0 ? Math.round((totalMaker / totalTrades) * 10000) / 10000 : 0,
      },
      timestamp: isoNow(),
    };
  }

  // ─── Configuration ──────────────────────────────────────────────────

  /**
   * Update configuration for an active session.
   */
  updateConfig(sessionId: string, configUpdate: Partial<MarketMakingConfig>): MarketMakingSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    session.config = { ...session.config, ...configUpdate };
    session.updatedAt = isoNow();

    // Refresh quotes with new config
    if (session.status === 'active') {
      const midPrice = this.getLatestPrice(session.pair);
      if (midPrice > 0) {
        this.refreshQuotes(session.id);
      }
    }

    return structuredClone(session);
  }

  /**
   * Get default market making config.
   */
  getDefaultConfig(): MarketMakingConfig {
    return { ...DEFAULT_CONFIG };
  }

  // ─── Risk Limits ────────────────────────────────────────────────────

  /**
   * Check and enforce risk limits. Halts session if breached.
   */
  private checkRiskLimits(session: MarketMakingSession): void {
    const config = session.config;

    // Max inventory check
    if (Math.abs(session.inventory.baseBalance) > config.maxInventory) {
      session.status = 'halted';
      session.haltReason = `Max inventory breached: ${Math.abs(session.inventory.baseBalance).toFixed(4)} > ${config.maxInventory}`;
      session.updatedAt = isoNow();
      return;
    }

    // Max loss check
    if (session.pnl.totalPnlUsd < config.maxLossUsd) {
      session.status = 'halted';
      session.haltReason = `Max loss breached: $${session.pnl.totalPnlUsd.toFixed(2)} < $${config.maxLossUsd}`;
      session.updatedAt = isoNow();
      return;
    }
  }

  // ─── Fee Optimization ───────────────────────────────────────────────

  /**
   * Compute maker/taker fee optimisation stats for a session.
   */
  getFeeOptimization(sessionId: string): {
    sessionId: string;
    makerFeeRate: number;
    takerFeeRate: number;
    makerTradeCount: number;
    takerTradeCount: number;
    makerRatio: number;
    feeSavingsVsAllTaker: number;
    recommendedAction: string;
  } {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    const { makerTradeCount, takerTradeCount, feesPaidUsd, tradeCount } = session.pnl;
    const makerRatio = tradeCount > 0 ? makerTradeCount / tradeCount : 0;

    // Calculate savings vs all-taker scenario
    const avgNotional = tradeCount > 0 ? feesPaidUsd / (tradeCount * session.config.takerFeeRate) : 0;
    const allTakerFees = avgNotional * tradeCount * session.config.takerFeeRate;
    const feeSavings = allTakerFees - feesPaidUsd;

    let recommendedAction = 'Maintain current strategy';
    if (makerRatio < 0.5) {
      recommendedAction = 'Increase passive quoting to improve maker ratio. Consider widening spread.';
    } else if (makerRatio > 0.9) {
      recommendedAction = 'Excellent maker ratio. Consider tightening spread for more fills.';
    }

    return {
      sessionId: session.id,
      makerFeeRate: session.config.makerFeeRate,
      takerFeeRate: session.config.takerFeeRate,
      makerTradeCount,
      takerTradeCount,
      makerRatio: Math.round(makerRatio * 10000) / 10000,
      feeSavingsVsAllTaker: Math.round(feeSavings * 100) / 100,
      recommendedAction,
    };
  }

  // ─── Private Helpers ────────────────────────────────────────────────

  private getLatestPrice(pair: string): number {
    const upper = pair.toUpperCase();
    const history = this.priceHistory.get(upper);
    if (!history || history.length === 0) {
      // Fall back to state store market prices
      const state = this.store.snapshot();
      const symbol = upper.replace(/\/.*$/, '').replace(/-.*$/, '');
      return state.marketPricesUsd[symbol] ?? 0;
    }
    return history[history.length - 1].price;
  }

  private getVolatility(pair: string, windowMs: number): number {
    const upper = pair.toUpperCase();
    const history = this.priceHistory.get(upper);
    if (!history || history.length < 2) return 0;

    const cutoff = Date.now() - windowMs;
    const recentPrices = history
      .filter((p) => new Date(p.timestamp).getTime() >= cutoff)
      .map((p) => p.price);

    return computeVolatility(recentPrices);
  }
}
