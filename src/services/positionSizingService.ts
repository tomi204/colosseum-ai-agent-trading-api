/**
 * Position Sizing Engine.
 *
 * Provides optimal position sizing for each trade using multiple methods:
 * - Kelly Criterion (optimal bet size from win rate + payoff ratio)
 * - Fractional Kelly (configurable fraction for safety)
 * - Fixed-fractional sizing (risk X% of portfolio per trade)
 * - Volatility-adjusted sizing (ATR-based position scaling)
 * - Maximum drawdown constraint sizing
 * - Portfolio heat (total risk exposure) tracking
 * - Anti-martingale (increase size on wins, decrease on losses)
 */

import { isoNow } from '../utils/time.js';

// ── Types ──────────────────────────────────────────────────────────────

export interface KellyInput {
  winRate: number;           // 0..1 probability of winning
  payoffRatio: number;       // avg win / avg loss
  fraction?: number;         // optional fractional Kelly (0..1, default 1.0 = full Kelly)
  portfolioValueUsd: number; // current portfolio value
}

export interface KellyResult {
  kellyFraction: number;         // raw Kelly %
  adjustedFraction: number;      // after fractional multiplier
  positionSizeUsd: number;       // dollar amount to risk
  edge: number;                  // expected edge (win*payoff - loss)
  method: 'kelly' | 'fractional-kelly';
  calculatedAt: string;
}

export interface FixedFractionalInput {
  portfolioValueUsd: number;
  riskPerTradePct: number;   // 0..1 (e.g., 0.02 = 2%)
  entryPriceUsd: number;
  stopLossPriceUsd: number;
}

export interface FixedFractionalResult {
  riskAmountUsd: number;
  positionSizeUnits: number;
  positionSizeUsd: number;
  riskPerTradePct: number;
  riskPerUnitUsd: number;
  method: 'fixed-fractional';
  calculatedAt: string;
}

export interface VolatilityInput {
  portfolioValueUsd: number;
  atr: number;               // Average True Range in price units
  riskPerTradePct: number;   // 0..1
  currentPriceUsd: number;
  atrMultiplier?: number;    // stop distance in ATR units (default 2)
}

export interface VolatilityResult {
  atr: number;
  atrMultiplier: number;
  stopDistanceUsd: number;
  riskAmountUsd: number;
  positionSizeUnits: number;
  positionSizeUsd: number;
  method: 'volatility-atr';
  calculatedAt: string;
}

export interface AntiMartingaleInput {
  portfolioValueUsd: number;
  baseRiskPct: number;        // base risk per trade 0..1
  consecutiveWins: number;
  consecutiveLosses: number;
  winScaleUpPct?: number;     // % to increase per consecutive win (default 0.25 = 25%)
  lossScaleDownPct?: number;  // % to decrease per consecutive loss (default 0.50 = 50%)
  maxRiskPct?: number;        // max risk cap 0..1 (default 0.10 = 10%)
  minRiskPct?: number;        // min risk floor 0..1 (default 0.005 = 0.5%)
}

export interface AntiMartingaleResult {
  baseRiskPct: number;
  adjustedRiskPct: number;
  positionSizeUsd: number;
  scaleFactor: number;
  streak: { wins: number; losses: number };
  method: 'anti-martingale';
  calculatedAt: string;
}

export interface DrawdownConstraintInput {
  portfolioValueUsd: number;
  peakPortfolioValueUsd: number;
  maxDrawdownPct: number;       // 0..1 (e.g., 0.20 = 20%)
  baseRiskPct: number;          // 0..1
}

export interface DrawdownConstraintResult {
  currentDrawdownPct: number;
  drawdownRatio: number;         // currentDD / maxDD (0..1+)
  adjustedRiskPct: number;
  positionSizeUsd: number;
  isDrawdownBreached: boolean;
  method: 'drawdown-constraint';
  calculatedAt: string;
}

export interface PortfolioHeatEntry {
  agentId: string;
  symbol: string;
  riskUsd: number;
  riskPct: number;
}

export interface PortfolioHeat {
  agentId: string;
  totalHeatPct: number;
  totalRiskUsd: number;
  portfolioValueUsd: number;
  maxHeatPct: number;
  isOverheated: boolean;
  positions: PortfolioHeatEntry[];
  calculatedAt: string;
}

export interface OptimalSizingInput {
  portfolioValueUsd: number;
  peakPortfolioValueUsd?: number;
  winRate?: number;
  payoffRatio?: number;
  atr?: number;
  currentPriceUsd?: number;
  entryPriceUsd?: number;
  stopLossPriceUsd?: number;
  consecutiveWins?: number;
  consecutiveLosses?: number;
  riskPerTradePct?: number;
  maxDrawdownPct?: number;
}

export interface OptimalSizingResult {
  recommended: {
    method: string;
    positionSizeUsd: number;
    riskPct: number;
    reason: string;
  };
  allMethods: Array<{
    method: string;
    positionSizeUsd: number;
    riskPct: number;
  }>;
  calculatedAt: string;
}

// ── Service ──────────────────────────────────────────────────────────

export class PositionSizingService {
  /** agentId → list of position heat entries */
  private heatMap: Map<string, { portfolioValueUsd: number; maxHeatPct: number; positions: PortfolioHeatEntry[] }> = new Map();

  // ── Kelly Criterion ────────────────────────────────────────────────

  calculateKelly(input: KellyInput): KellyResult {
    const { winRate, payoffRatio, portfolioValueUsd } = input;
    const fraction = input.fraction ?? 1.0;

    if (winRate < 0 || winRate > 1) {
      throw new Error('winRate must be between 0 and 1');
    }
    if (payoffRatio <= 0) {
      throw new Error('payoffRatio must be positive');
    }
    if (portfolioValueUsd <= 0) {
      throw new Error('portfolioValueUsd must be positive');
    }
    if (fraction <= 0 || fraction > 1) {
      throw new Error('fraction must be between 0 (exclusive) and 1 (inclusive)');
    }

    const lossRate = 1 - winRate;
    // Kelly formula: f* = (p * b - q) / b
    // where p = win probability, q = loss probability, b = payoff ratio
    const kellyFraction = (winRate * payoffRatio - lossRate) / payoffRatio;

    // Edge = expected value per dollar bet
    const edge = winRate * payoffRatio - lossRate;

    // If Kelly is negative, no edge — size is 0
    const clampedKelly = Math.max(0, kellyFraction);
    const adjustedFraction = clampedKelly * fraction;

    const positionSizeUsd = Number((portfolioValueUsd * adjustedFraction).toFixed(2));

    return {
      kellyFraction: Number(clampedKelly.toFixed(6)),
      adjustedFraction: Number(adjustedFraction.toFixed(6)),
      positionSizeUsd,
      edge: Number(edge.toFixed(6)),
      method: fraction < 1 ? 'fractional-kelly' : 'kelly',
      calculatedAt: isoNow(),
    };
  }

  // ── Fixed-Fractional Sizing ─────────────────────────────────────────

  calculateFixedFractional(input: FixedFractionalInput): FixedFractionalResult {
    const { portfolioValueUsd, riskPerTradePct, entryPriceUsd, stopLossPriceUsd } = input;

    if (portfolioValueUsd <= 0) throw new Error('portfolioValueUsd must be positive');
    if (riskPerTradePct <= 0 || riskPerTradePct > 1) throw new Error('riskPerTradePct must be between 0 and 1');
    if (entryPriceUsd <= 0) throw new Error('entryPriceUsd must be positive');
    if (stopLossPriceUsd <= 0) throw new Error('stopLossPriceUsd must be positive');
    if (stopLossPriceUsd >= entryPriceUsd) throw new Error('stopLossPriceUsd must be less than entryPriceUsd');

    const riskAmountUsd = portfolioValueUsd * riskPerTradePct;
    const riskPerUnitUsd = entryPriceUsd - stopLossPriceUsd;
    const positionSizeUnits = riskAmountUsd / riskPerUnitUsd;
    const positionSizeUsd = positionSizeUnits * entryPriceUsd;

    return {
      riskAmountUsd: Number(riskAmountUsd.toFixed(2)),
      positionSizeUnits: Number(positionSizeUnits.toFixed(6)),
      positionSizeUsd: Number(positionSizeUsd.toFixed(2)),
      riskPerTradePct,
      riskPerUnitUsd: Number(riskPerUnitUsd.toFixed(4)),
      method: 'fixed-fractional',
      calculatedAt: isoNow(),
    };
  }

  // ── Volatility-Adjusted (ATR-based) Sizing ─────────────────────────

  calculateVolatilitySizing(input: VolatilityInput): VolatilityResult {
    const { portfolioValueUsd, atr, riskPerTradePct, currentPriceUsd } = input;
    const atrMultiplier = input.atrMultiplier ?? 2;

    if (portfolioValueUsd <= 0) throw new Error('portfolioValueUsd must be positive');
    if (atr <= 0) throw new Error('atr must be positive');
    if (riskPerTradePct <= 0 || riskPerTradePct > 1) throw new Error('riskPerTradePct must be between 0 and 1');
    if (currentPriceUsd <= 0) throw new Error('currentPriceUsd must be positive');
    if (atrMultiplier <= 0) throw new Error('atrMultiplier must be positive');

    const stopDistanceUsd = atr * atrMultiplier;
    const riskAmountUsd = portfolioValueUsd * riskPerTradePct;
    const positionSizeUnits = riskAmountUsd / stopDistanceUsd;
    const positionSizeUsd = positionSizeUnits * currentPriceUsd;

    return {
      atr,
      atrMultiplier,
      stopDistanceUsd: Number(stopDistanceUsd.toFixed(4)),
      riskAmountUsd: Number(riskAmountUsd.toFixed(2)),
      positionSizeUnits: Number(positionSizeUnits.toFixed(6)),
      positionSizeUsd: Number(positionSizeUsd.toFixed(2)),
      method: 'volatility-atr',
      calculatedAt: isoNow(),
    };
  }

  // ── Anti-Martingale Sizing ──────────────────────────────────────────

  calculateAntiMartingale(input: AntiMartingaleInput): AntiMartingaleResult {
    const {
      portfolioValueUsd,
      baseRiskPct,
      consecutiveWins,
      consecutiveLosses,
    } = input;
    const winScaleUpPct = input.winScaleUpPct ?? 0.25;
    const lossScaleDownPct = input.lossScaleDownPct ?? 0.50;
    const maxRiskPct = input.maxRiskPct ?? 0.10;
    const minRiskPct = input.minRiskPct ?? 0.005;

    if (portfolioValueUsd <= 0) throw new Error('portfolioValueUsd must be positive');
    if (baseRiskPct <= 0 || baseRiskPct > 1) throw new Error('baseRiskPct must be between 0 and 1');

    let scaleFactor = 1.0;

    if (consecutiveWins > 0) {
      // Scale up: increase by winScaleUpPct for each consecutive win
      scaleFactor = 1 + (winScaleUpPct * consecutiveWins);
    } else if (consecutiveLosses > 0) {
      // Scale down: decrease by lossScaleDownPct for each consecutive loss
      scaleFactor = Math.pow(1 - lossScaleDownPct, consecutiveLosses);
    }

    let adjustedRiskPct = baseRiskPct * scaleFactor;
    adjustedRiskPct = Math.max(minRiskPct, Math.min(maxRiskPct, adjustedRiskPct));

    const positionSizeUsd = portfolioValueUsd * adjustedRiskPct;

    return {
      baseRiskPct,
      adjustedRiskPct: Number(adjustedRiskPct.toFixed(6)),
      positionSizeUsd: Number(positionSizeUsd.toFixed(2)),
      scaleFactor: Number(scaleFactor.toFixed(4)),
      streak: { wins: consecutiveWins, losses: consecutiveLosses },
      method: 'anti-martingale',
      calculatedAt: isoNow(),
    };
  }

  // ── Maximum Drawdown Constraint Sizing ──────────────────────────────

  calculateDrawdownConstraint(input: DrawdownConstraintInput): DrawdownConstraintResult {
    const { portfolioValueUsd, peakPortfolioValueUsd, maxDrawdownPct, baseRiskPct } = input;

    if (portfolioValueUsd <= 0) throw new Error('portfolioValueUsd must be positive');
    if (peakPortfolioValueUsd <= 0) throw new Error('peakPortfolioValueUsd must be positive');
    if (maxDrawdownPct <= 0 || maxDrawdownPct > 1) throw new Error('maxDrawdownPct must be between 0 and 1');
    if (baseRiskPct <= 0 || baseRiskPct > 1) throw new Error('baseRiskPct must be between 0 and 1');

    const currentDrawdownPct = (peakPortfolioValueUsd - portfolioValueUsd) / peakPortfolioValueUsd;
    const drawdownRatio = currentDrawdownPct / maxDrawdownPct;

    // Linearly reduce risk as we approach max drawdown
    // At 0% DD → full risk, at 100% of maxDD → 0 risk
    const riskMultiplier = Math.max(0, 1 - drawdownRatio);
    const adjustedRiskPct = baseRiskPct * riskMultiplier;
    const positionSizeUsd = portfolioValueUsd * adjustedRiskPct;
    const isDrawdownBreached = currentDrawdownPct >= maxDrawdownPct;

    return {
      currentDrawdownPct: Number(currentDrawdownPct.toFixed(6)),
      drawdownRatio: Number(drawdownRatio.toFixed(6)),
      adjustedRiskPct: Number(adjustedRiskPct.toFixed(6)),
      positionSizeUsd: Number(positionSizeUsd.toFixed(2)),
      isDrawdownBreached,
      method: 'drawdown-constraint',
      calculatedAt: isoNow(),
    };
  }

  // ── Portfolio Heat Tracking ────────────────────────────────────────

  updateHeat(
    agentId: string,
    portfolioValueUsd: number,
    positions: Array<{ symbol: string; riskUsd: number }>,
    maxHeatPct?: number,
  ): PortfolioHeat {
    if (portfolioValueUsd <= 0) throw new Error('portfolioValueUsd must be positive');

    const effectiveMaxHeat = maxHeatPct ?? 0.20; // default 20% max portfolio heat
    const entries: PortfolioHeatEntry[] = positions.map((p) => ({
      agentId,
      symbol: p.symbol,
      riskUsd: p.riskUsd,
      riskPct: Number((p.riskUsd / portfolioValueUsd).toFixed(6)),
    }));

    const totalRiskUsd = entries.reduce((sum, e) => sum + e.riskUsd, 0);
    const totalHeatPct = totalRiskUsd / portfolioValueUsd;

    this.heatMap.set(agentId, { portfolioValueUsd, maxHeatPct: effectiveMaxHeat, positions: entries });

    return {
      agentId,
      totalHeatPct: Number(totalHeatPct.toFixed(6)),
      totalRiskUsd: Number(totalRiskUsd.toFixed(2)),
      portfolioValueUsd,
      maxHeatPct: effectiveMaxHeat,
      isOverheated: totalHeatPct > effectiveMaxHeat,
      positions: entries,
      calculatedAt: isoNow(),
    };
  }

  getHeat(agentId: string): PortfolioHeat {
    const data = this.heatMap.get(agentId);
    if (!data) {
      return {
        agentId,
        totalHeatPct: 0,
        totalRiskUsd: 0,
        portfolioValueUsd: 0,
        maxHeatPct: 0.20,
        isOverheated: false,
        positions: [],
        calculatedAt: isoNow(),
      };
    }

    const totalRiskUsd = data.positions.reduce((sum, e) => sum + e.riskUsd, 0);
    const totalHeatPct = data.portfolioValueUsd > 0 ? totalRiskUsd / data.portfolioValueUsd : 0;

    return {
      agentId,
      totalHeatPct: Number(totalHeatPct.toFixed(6)),
      totalRiskUsd: Number(totalRiskUsd.toFixed(2)),
      portfolioValueUsd: data.portfolioValueUsd,
      maxHeatPct: data.maxHeatPct,
      isOverheated: totalHeatPct > data.maxHeatPct,
      positions: data.positions,
      calculatedAt: isoNow(),
    };
  }

  // ── Optimal Sizing (best method for conditions) ────────────────────

  calculateOptimal(input: OptimalSizingInput): OptimalSizingResult {
    const { portfolioValueUsd } = input;
    if (portfolioValueUsd <= 0) throw new Error('portfolioValueUsd must be positive');

    const riskPct = input.riskPerTradePct ?? 0.02;
    const allMethods: Array<{ method: string; positionSizeUsd: number; riskPct: number }> = [];

    // 1. Kelly (if stats available)
    if (input.winRate !== undefined && input.payoffRatio !== undefined && input.payoffRatio > 0) {
      const kelly = this.calculateKelly({
        winRate: input.winRate,
        payoffRatio: input.payoffRatio,
        fraction: 0.5, // half-Kelly for safety
        portfolioValueUsd,
      });
      if (kelly.positionSizeUsd > 0) {
        allMethods.push({
          method: 'fractional-kelly',
          positionSizeUsd: kelly.positionSizeUsd,
          riskPct: kelly.adjustedFraction,
        });
      }
    }

    // 2. Fixed-fractional (if entry/stop provided)
    if (input.entryPriceUsd && input.stopLossPriceUsd && input.stopLossPriceUsd < input.entryPriceUsd) {
      const ff = this.calculateFixedFractional({
        portfolioValueUsd,
        riskPerTradePct: riskPct,
        entryPriceUsd: input.entryPriceUsd,
        stopLossPriceUsd: input.stopLossPriceUsd,
      });
      allMethods.push({
        method: 'fixed-fractional',
        positionSizeUsd: ff.positionSizeUsd,
        riskPct: ff.riskPerTradePct,
      });
    }

    // 3. Volatility (if ATR provided)
    if (input.atr && input.currentPriceUsd) {
      const vol = this.calculateVolatilitySizing({
        portfolioValueUsd,
        atr: input.atr,
        riskPerTradePct: riskPct,
        currentPriceUsd: input.currentPriceUsd,
      });
      allMethods.push({
        method: 'volatility-atr',
        positionSizeUsd: vol.positionSizeUsd,
        riskPct: riskPct,
      });
    }

    // 4. Anti-martingale (if streak info provided)
    if (input.consecutiveWins !== undefined || input.consecutiveLosses !== undefined) {
      const am = this.calculateAntiMartingale({
        portfolioValueUsd,
        baseRiskPct: riskPct,
        consecutiveWins: input.consecutiveWins ?? 0,
        consecutiveLosses: input.consecutiveLosses ?? 0,
      });
      allMethods.push({
        method: 'anti-martingale',
        positionSizeUsd: am.positionSizeUsd,
        riskPct: am.adjustedRiskPct,
      });
    }

    // 5. Drawdown constraint (if peak provided)
    if (input.peakPortfolioValueUsd) {
      const dd = this.calculateDrawdownConstraint({
        portfolioValueUsd,
        peakPortfolioValueUsd: input.peakPortfolioValueUsd,
        maxDrawdownPct: input.maxDrawdownPct ?? 0.20,
        baseRiskPct: riskPct,
      });
      allMethods.push({
        method: 'drawdown-constraint',
        positionSizeUsd: dd.positionSizeUsd,
        riskPct: dd.adjustedRiskPct,
      });
    }

    // If no methods could be computed, fall back to simple fixed %
    if (allMethods.length === 0) {
      const simpleSize = portfolioValueUsd * riskPct;
      allMethods.push({
        method: 'simple-percentage',
        positionSizeUsd: Number(simpleSize.toFixed(2)),
        riskPct,
      });
    }

    // Pick the most conservative (smallest position) as recommended
    const sorted = [...allMethods].sort((a, b) => a.positionSizeUsd - b.positionSizeUsd);
    const recommended = sorted[0];

    return {
      recommended: {
        method: recommended.method,
        positionSizeUsd: recommended.positionSizeUsd,
        riskPct: recommended.riskPct,
        reason: `Most conservative sizing from ${allMethods.length} method(s) evaluated`,
      },
      allMethods,
      calculatedAt: isoNow(),
    };
  }
}
