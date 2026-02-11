import { v4 as uuid } from 'uuid';
import { RiskEngine } from '../domain/risk/riskEngine.js';
import { StrategyRegistry } from '../domain/strategy/strategyRegistry.js';
import { StrategyAction } from '../domain/strategy/types.js';
import { DomainError, ErrorCode } from '../errors/taxonomy.js';
import { Agent, RiskLimits, Side, TradeIntent } from '../types.js';
import { isoNow } from '../utils/time.js';

export interface BacktestInput {
  strategyId: string;
  symbol: string;
  priceHistory: number[];
  startingCapitalUsd: number;
  riskOverrides?: Partial<RiskLimits>;
}

export interface BacktestTrade {
  tick: number;
  side: Side;
  priceUsd: number;
  quantity: number;
  notionalUsd: number;
  pnlUsd: number;
}

export interface BacktestResult {
  totalReturnPct: number;
  maxDrawdownPct: number;
  sharpeRatio: number;
  tradeCount: number;
  winRate: number;
  trades: BacktestTrade[];
}

const DEFAULT_RISK_LIMITS: RiskLimits = {
  maxPositionSizePct: 0.25,
  maxOrderNotionalUsd: 50_000,
  maxGrossExposureUsd: 100_000,
  dailyLossCapUsd: 10_000,
  maxDrawdownPct: 0.5,
  cooldownSeconds: 0,
};

const ORDER_SIZE_PCT = 0.1; // Use 10% of equity per trade

export class BacktestService {
  private readonly riskEngine = new RiskEngine();

  constructor(private readonly strategyRegistry: StrategyRegistry) {}

  run(input: BacktestInput): BacktestResult {
    const strategy = this.strategyRegistry.get(input.strategyId);
    if (!strategy) {
      throw new DomainError(
        ErrorCode.InvalidPayload,
        400,
        `Unknown strategyId '${input.strategyId}'.`,
      );
    }

    if (input.priceHistory.length < 2) {
      throw new DomainError(
        ErrorCode.InvalidPayload,
        400,
        'priceHistory must contain at least 2 data points.',
      );
    }

    if (input.startingCapitalUsd <= 0) {
      throw new DomainError(
        ErrorCode.InvalidPayload,
        400,
        'startingCapitalUsd must be positive.',
      );
    }

    const riskLimits: RiskLimits = {
      ...DEFAULT_RISK_LIMITS,
      ...input.riskOverrides,
    };

    // Create ephemeral agent state (never persisted)
    const agent: Agent = {
      id: `backtest-${uuid()}`,
      name: 'Backtest Agent',
      apiKey: 'ephemeral',
      createdAt: isoNow(),
      updatedAt: isoNow(),
      startingCapitalUsd: input.startingCapitalUsd,
      cashUsd: input.startingCapitalUsd,
      realizedPnlUsd: 0,
      peakEquityUsd: input.startingCapitalUsd,
      riskLimits,
      positions: {},
      dailyRealizedPnlUsd: {},
      riskRejectionsByReason: {},
      strategyId: input.strategyId as Agent['strategyId'],
    };

    const symbol = input.symbol.toUpperCase();
    const trades: BacktestTrade[] = [];
    const equityCurve: number[] = [input.startingCapitalUsd];

    for (let tick = 1; tick < input.priceHistory.length; tick++) {
      const currentPrice = input.priceHistory[tick];
      const historySlice = input.priceHistory.slice(0, tick);

      if (!Number.isFinite(currentPrice) || currentPrice <= 0) continue;

      // Evaluate strategy
      const signal = strategy.evaluate({
        symbol,
        currentPriceUsd: currentPrice,
        priceHistoryUsd: historySlice,
      });

      if (signal.action === 'hold') {
        const equity = this.computeEquity(agent, symbol, currentPrice);
        equityCurve.push(equity);
        continue;
      }

      const side: Side = signal.action as Side;
      const equity = this.computeEquity(agent, symbol, currentPrice);
      const orderNotional = equity * ORDER_SIZE_PCT;
      const orderQuantity = orderNotional / currentPrice;

      if (orderNotional <= 0 || orderQuantity <= 0) {
        equityCurve.push(equity);
        continue;
      }

      // Build ephemeral intent for risk check
      const intent: TradeIntent = {
        id: `bt-intent-${tick}`,
        agentId: agent.id,
        symbol,
        side,
        notionalUsd: orderNotional,
        quantity: orderQuantity,
        createdAt: isoNow(),
        updatedAt: isoNow(),
        status: 'pending',
      };

      // Risk check
      const riskDecision = this.riskEngine.evaluate({
        agent,
        intent,
        priceUsd: currentPrice,
        now: new Date(),
      });

      if (!riskDecision.approved) {
        equityCurve.push(equity);
        continue;
      }

      // Execute paper trade
      const trade = this.executePaperTrade(
        agent,
        symbol,
        side,
        riskDecision.computedQuantity,
        currentPrice,
        tick,
      );

      if (trade) {
        trades.push(trade);
      }

      const newEquity = this.computeEquity(agent, symbol, currentPrice);
      agent.peakEquityUsd = Math.max(agent.peakEquityUsd, newEquity);
      equityCurve.push(newEquity);
    }

    return this.computeResults(input.startingCapitalUsd, equityCurve, trades);
  }

  private executePaperTrade(
    agent: Agent,
    symbol: string,
    side: Side,
    quantity: number,
    priceUsd: number,
    tick: number,
  ): BacktestTrade | null {
    const notional = quantity * priceUsd;
    let pnl = 0;

    if (side === 'buy') {
      if (agent.cashUsd < notional) return null;

      agent.cashUsd -= notional;
      const existing = agent.positions[symbol];
      if (existing) {
        const totalQty = existing.quantity + quantity;
        const totalCost = existing.quantity * existing.avgEntryPriceUsd + notional;
        existing.avgEntryPriceUsd = totalCost / totalQty;
        existing.quantity = totalQty;
      } else {
        agent.positions[symbol] = {
          symbol,
          quantity,
          avgEntryPriceUsd: priceUsd,
        };
      }
    } else {
      // sell
      const existing = agent.positions[symbol];
      if (!existing || existing.quantity < quantity) return null;

      const proceeds = quantity * priceUsd;
      pnl = (priceUsd - existing.avgEntryPriceUsd) * quantity;
      agent.cashUsd += proceeds;
      agent.realizedPnlUsd += pnl;

      existing.quantity -= quantity;
      if (existing.quantity <= 1e-12) {
        delete agent.positions[symbol];
      }
    }

    return {
      tick,
      side,
      priceUsd,
      quantity: Number(quantity.toFixed(8)),
      notionalUsd: Number(notional.toFixed(8)),
      pnlUsd: Number(pnl.toFixed(8)),
    };
  }

  private computeEquity(agent: Agent, symbol: string, currentPrice: number): number {
    const inventoryValue = Object.values(agent.positions).reduce((sum, pos) => {
      const px = pos.symbol === symbol ? currentPrice : pos.avgEntryPriceUsd;
      return sum + pos.quantity * px;
    }, 0);
    return Number((agent.cashUsd + inventoryValue).toFixed(8));
  }

  private computeResults(
    startingCapital: number,
    equityCurve: number[],
    trades: BacktestTrade[],
  ): BacktestResult {
    const finalEquity = equityCurve[equityCurve.length - 1] ?? startingCapital;
    const totalReturnPct = ((finalEquity - startingCapital) / startingCapital) * 100;

    // Max drawdown
    let peak = equityCurve[0] ?? startingCapital;
    let maxDrawdownPct = 0;
    for (const eq of equityCurve) {
      if (eq > peak) peak = eq;
      const dd = peak > 0 ? ((peak - eq) / peak) * 100 : 0;
      if (dd > maxDrawdownPct) maxDrawdownPct = dd;
    }

    // Sharpe ratio (using equity returns)
    const returns: number[] = [];
    for (let i = 1; i < equityCurve.length; i++) {
      const prev = equityCurve[i - 1];
      if (prev > 0) {
        returns.push((equityCurve[i] - prev) / prev);
      }
    }

    let sharpeRatio = 0;
    if (returns.length > 1) {
      const meanReturn = returns.reduce((s, r) => s + r, 0) / returns.length;
      const variance = returns.reduce((s, r) => s + (r - meanReturn) ** 2, 0) / (returns.length - 1);
      const stdDev = Math.sqrt(variance);
      sharpeRatio = stdDev > 0 ? (meanReturn / stdDev) * Math.sqrt(252) : 0; // Annualized
    }

    // Win rate
    const tradeCount = trades.length;
    const winningTrades = trades.filter((t) => t.pnlUsd > 0).length;
    const winRate = tradeCount > 0 ? (winningTrades / tradeCount) * 100 : 0;

    return {
      totalReturnPct: Number(totalReturnPct.toFixed(4)),
      maxDrawdownPct: Number(maxDrawdownPct.toFixed(4)),
      sharpeRatio: Number(sharpeRatio.toFixed(4)),
      tradeCount,
      winRate: Number(winRate.toFixed(2)),
      trades,
    };
  }
}
