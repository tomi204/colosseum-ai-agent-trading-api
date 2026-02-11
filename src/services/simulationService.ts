import { v4 as uuid } from 'uuid';
import { AppConfig } from '../config.js';
import { FeeEngine } from '../domain/fee/feeEngine.js';
import { RiskEngine } from '../domain/risk/riskEngine.js';
import { StateStore } from '../infra/storage/stateStore.js';
import { Agent, Side } from '../types.js';
import { isoNow } from '../utils/time.js';

// ─── Simulation types ───────────────────────────────────────────────────────

export interface SimulationInput {
  agentId: string;
  symbol: string;
  side: Side;
  quantity?: number;
  notionalUsd?: number;
  hypotheticalPriceUsd?: number;
}

export interface SimulationResult {
  simulationId: string;
  agentId: string;
  symbol: string;
  side: Side;
  quantity: number;
  priceUsd: number;
  grossNotionalUsd: number;
  projectedFeeUsd: number;
  projectedNetUsd: number;
  projectedRealizedPnlUsd: number;
  projectedEquityAfter: number;
  projectedCashAfter: number;
  riskImpact: {
    currentGrossExposureUsd: number;
    projectedGrossExposureUsd: number;
    currentDrawdownPct: number;
    projectedDrawdownPct: number;
    wouldExceedLimits: boolean;
    limitViolations: string[];
  };
  feasible: boolean;
  infeasibilityReason: string | null;
  simulatedAt: string;
}

// ─── Simulation service ─────────────────────────────────────────────────────

export class SimulationService {
  private readonly riskEngine = new RiskEngine();

  constructor(
    private readonly store: StateStore,
    private readonly feeEngine: FeeEngine,
    private readonly config: AppConfig,
  ) {}

  simulate(input: SimulationInput): SimulationResult {
    const snapshot = this.store.snapshot();
    const agent = snapshot.agents[input.agentId];

    if (!agent) {
      return this.infeasibleResult(input, 'agent_not_found');
    }

    const symbol = input.symbol.toUpperCase();
    const marketPrice = input.hypotheticalPriceUsd ?? snapshot.marketPricesUsd[symbol];
    if (!marketPrice || marketPrice <= 0) {
      return this.infeasibleResult(input, 'market_price_missing');
    }

    const notionalUsd = input.notionalUsd ?? ((input.quantity ?? 0) * marketPrice);
    const quantity = input.quantity ?? (input.notionalUsd ? input.notionalUsd / marketPrice : 0);

    if (notionalUsd <= 0 || quantity <= 0) {
      return this.infeasibleResult(input, 'invalid_order_size');
    }

    const feeUsd = this.feeEngine.calculateExecutionFeeUsd(notionalUsd);

    // Project P&L
    const { projectedNetUsd, projectedRealizedPnl, projectedCash } = this.projectPnl(
      agent, symbol, input.side, quantity, marketPrice, feeUsd,
    );

    // Current risk metrics
    const priceResolver = (s: string) => snapshot.marketPricesUsd[s];
    const currentEquity = this.riskEngine.computeEquityUsd(agent, priceResolver);
    const currentGrossExposure = this.riskEngine.computeGrossExposureUsd(agent, priceResolver);
    const currentDrawdownPct = agent.peakEquityUsd > 0
      ? Number(((agent.peakEquityUsd - currentEquity) / agent.peakEquityUsd).toFixed(8))
      : 0;

    // Projected risk metrics (simulate position change)
    const clonedAgent = structuredClone(agent);
    this.applySimulatedTrade(clonedAgent, symbol, input.side, quantity, marketPrice, feeUsd);

    const projectedEquity = this.riskEngine.computeEquityUsd(clonedAgent, priceResolver);
    const projectedGrossExposure = this.riskEngine.computeGrossExposureUsd(clonedAgent, priceResolver);
    const projectedDrawdownPct = agent.peakEquityUsd > 0
      ? Number(((agent.peakEquityUsd - projectedEquity) / agent.peakEquityUsd).toFixed(8))
      : 0;

    // Check risk limits
    const limitViolations: string[] = [];

    if (notionalUsd > agent.riskLimits.maxOrderNotionalUsd) {
      limitViolations.push('max_order_notional_exceeded');
    }
    if (currentEquity > 0 && notionalUsd > currentEquity * agent.riskLimits.maxPositionSizePct) {
      limitViolations.push('position_size_pct_exceeded');
    }
    if (projectedGrossExposure > agent.riskLimits.maxGrossExposureUsd) {
      limitViolations.push('gross_exposure_cap_exceeded');
    }
    if (projectedDrawdownPct >= agent.riskLimits.maxDrawdownPct) {
      limitViolations.push('drawdown_guard_triggered');
    }

    // Feasibility check
    let feasible = true;
    let infeasibilityReason: string | null = null;

    if (input.side === 'buy') {
      const totalCost = notionalUsd + feeUsd;
      if (agent.cashUsd < totalCost) {
        feasible = false;
        infeasibilityReason = 'insufficient_cash_for_buy';
      }
    } else {
      const currentQty = agent.positions[symbol]?.quantity ?? 0;
      if (quantity > currentQty) {
        feasible = false;
        infeasibilityReason = 'insufficient_position_for_sell';
      }
    }

    if (limitViolations.length > 0 && feasible) {
      feasible = false;
      infeasibilityReason = limitViolations[0];
    }

    return {
      simulationId: uuid(),
      agentId: input.agentId,
      symbol,
      side: input.side,
      quantity: Number(quantity.toFixed(8)),
      priceUsd: marketPrice,
      grossNotionalUsd: Number(notionalUsd.toFixed(8)),
      projectedFeeUsd: feeUsd,
      projectedNetUsd: Number(projectedNetUsd.toFixed(8)),
      projectedRealizedPnlUsd: Number(projectedRealizedPnl.toFixed(8)),
      projectedEquityAfter: Number(projectedEquity.toFixed(8)),
      projectedCashAfter: Number(projectedCash.toFixed(8)),
      riskImpact: {
        currentGrossExposureUsd: Number(currentGrossExposure.toFixed(8)),
        projectedGrossExposureUsd: Number(projectedGrossExposure.toFixed(8)),
        currentDrawdownPct,
        projectedDrawdownPct,
        wouldExceedLimits: limitViolations.length > 0,
        limitViolations,
      },
      feasible,
      infeasibilityReason,
      simulatedAt: isoNow(),
    };
  }

  private projectPnl(
    agent: Agent,
    symbol: string,
    side: Side,
    quantity: number,
    priceUsd: number,
    feeUsd: number,
  ): { projectedNetUsd: number; projectedRealizedPnl: number; projectedCash: number } {
    const gross = quantity * priceUsd;

    if (side === 'buy') {
      const totalCost = gross + feeUsd;
      return {
        projectedNetUsd: -totalCost,
        projectedRealizedPnl: 0,
        projectedCash: agent.cashUsd - totalCost,
      };
    }

    // Sell
    const existing = agent.positions[symbol];
    const avgEntry = existing?.avgEntryPriceUsd ?? priceUsd;
    const realizedPnl = (priceUsd - avgEntry) * quantity;
    const proceeds = gross - feeUsd;

    return {
      projectedNetUsd: proceeds,
      projectedRealizedPnl: realizedPnl,
      projectedCash: agent.cashUsd + proceeds,
    };
  }

  private applySimulatedTrade(
    agent: Agent,
    symbol: string,
    side: Side,
    quantity: number,
    priceUsd: number,
    feeUsd: number,
  ): void {
    const gross = quantity * priceUsd;

    if (side === 'buy') {
      const totalCost = gross + feeUsd;
      agent.cashUsd = Math.max(0, agent.cashUsd - totalCost);

      const existing = agent.positions[symbol] ?? {
        symbol,
        quantity: 0,
        avgEntryPriceUsd: priceUsd,
      };

      const newQty = existing.quantity + quantity;
      const newAvg = ((existing.quantity * existing.avgEntryPriceUsd) + gross) / newQty;

      agent.positions[symbol] = {
        symbol,
        quantity: Number(newQty.toFixed(8)),
        avgEntryPriceUsd: Number(newAvg.toFixed(8)),
      };
    } else {
      const proceeds = gross - feeUsd;
      agent.cashUsd += proceeds;

      const existing = agent.positions[symbol];
      if (existing) {
        const remainingQty = existing.quantity - quantity;
        if (remainingQty <= 0) {
          delete agent.positions[symbol];
        } else {
          agent.positions[symbol] = {
            ...existing,
            quantity: Number(remainingQty.toFixed(8)),
          };
        }
      }
    }
  }

  private infeasibleResult(input: SimulationInput, reason: string): SimulationResult {
    return {
      simulationId: uuid(),
      agentId: input.agentId,
      symbol: input.symbol.toUpperCase(),
      side: input.side,
      quantity: input.quantity ?? 0,
      priceUsd: input.hypotheticalPriceUsd ?? 0,
      grossNotionalUsd: 0,
      projectedFeeUsd: 0,
      projectedNetUsd: 0,
      projectedRealizedPnlUsd: 0,
      projectedEquityAfter: 0,
      projectedCashAfter: 0,
      riskImpact: {
        currentGrossExposureUsd: 0,
        projectedGrossExposureUsd: 0,
        currentDrawdownPct: 0,
        projectedDrawdownPct: 0,
        wouldExceedLimits: false,
        limitViolations: [],
      },
      feasible: false,
      infeasibilityReason: reason,
      simulatedAt: isoNow(),
    };
  }
}
