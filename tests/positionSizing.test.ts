import { describe, expect, it } from 'vitest';
import {
  PositionSizingService,
  KellyResult,
  FixedFractionalResult,
  VolatilityResult,
  AntiMartingaleResult,
  DrawdownConstraintResult,
  PortfolioHeat,
  OptimalSizingResult,
} from '../src/services/positionSizingService.js';

function createService(): PositionSizingService {
  return new PositionSizingService();
}

describe('PositionSizingService', () => {
  // ═══ Kelly Criterion ═══════════════════════════════════════════════

  it('calculates full Kelly criterion correctly', () => {
    const svc = createService();
    // 60% win rate, 1.5:1 payoff ratio, $100k portfolio
    const result: KellyResult = svc.calculateKelly({
      winRate: 0.6,
      payoffRatio: 1.5,
      portfolioValueUsd: 100_000,
    });

    // Kelly = (0.6 * 1.5 - 0.4) / 1.5 = (0.9 - 0.4) / 1.5 = 0.5 / 1.5 ≈ 0.3333
    expect(result.kellyFraction).toBeCloseTo(0.3333, 3);
    expect(result.adjustedFraction).toBeCloseTo(0.3333, 3);
    expect(result.positionSizeUsd).toBeCloseTo(33_333.33, 0);
    expect(result.edge).toBeGreaterThan(0);
    expect(result.method).toBe('kelly');
    expect(result.calculatedAt).toBeTruthy();
  });

  it('calculates fractional Kelly (half Kelly)', () => {
    const svc = createService();
    const result: KellyResult = svc.calculateKelly({
      winRate: 0.6,
      payoffRatio: 1.5,
      fraction: 0.5,
      portfolioValueUsd: 100_000,
    });

    expect(result.kellyFraction).toBeCloseTo(0.3333, 3);
    expect(result.adjustedFraction).toBeCloseTo(0.1667, 3);
    expect(result.positionSizeUsd).toBeCloseTo(16_666.67, 0);
    expect(result.method).toBe('fractional-kelly');
  });

  it('returns zero position when no edge (win rate too low)', () => {
    const svc = createService();
    // 30% win rate, 1:1 payoff → negative Kelly
    const result: KellyResult = svc.calculateKelly({
      winRate: 0.3,
      payoffRatio: 1.0,
      portfolioValueUsd: 100_000,
    });

    expect(result.kellyFraction).toBe(0);
    expect(result.positionSizeUsd).toBe(0);
    expect(result.edge).toBeLessThan(0);
  });

  it('throws on invalid Kelly inputs', () => {
    const svc = createService();
    expect(() => svc.calculateKelly({
      winRate: 1.5,
      payoffRatio: 1.0,
      portfolioValueUsd: 100_000,
    })).toThrow('winRate must be between 0 and 1');

    expect(() => svc.calculateKelly({
      winRate: 0.5,
      payoffRatio: -1,
      portfolioValueUsd: 100_000,
    })).toThrow('payoffRatio must be positive');
  });

  // ═══ Fixed-Fractional Sizing ═══════════════════════════════════════

  it('calculates fixed-fractional position size', () => {
    const svc = createService();
    const result: FixedFractionalResult = svc.calculateFixedFractional({
      portfolioValueUsd: 50_000,
      riskPerTradePct: 0.02,  // 2%
      entryPriceUsd: 100,
      stopLossPriceUsd: 95,
    });

    // Risk amount = 50000 * 0.02 = 1000
    // Risk per unit = 100 - 95 = 5
    // Position size units = 1000 / 5 = 200
    // Position size USD = 200 * 100 = 20000
    expect(result.riskAmountUsd).toBe(1000);
    expect(result.riskPerUnitUsd).toBe(5);
    expect(result.positionSizeUnits).toBe(200);
    expect(result.positionSizeUsd).toBe(20_000);
    expect(result.method).toBe('fixed-fractional');
  });

  it('throws when stop loss >= entry price', () => {
    const svc = createService();
    expect(() => svc.calculateFixedFractional({
      portfolioValueUsd: 50_000,
      riskPerTradePct: 0.02,
      entryPriceUsd: 100,
      stopLossPriceUsd: 105,
    })).toThrow('stopLossPriceUsd must be less than entryPriceUsd');
  });

  // ═══ Volatility-Adjusted (ATR) Sizing ═════════════════════════════

  it('calculates ATR-based volatility sizing with default multiplier', () => {
    const svc = createService();
    const result: VolatilityResult = svc.calculateVolatilitySizing({
      portfolioValueUsd: 100_000,
      atr: 5.0,
      riskPerTradePct: 0.01,  // 1%
      currentPriceUsd: 150,
    });

    // Stop distance = 5 * 2 = 10
    // Risk amount = 100000 * 0.01 = 1000
    // Units = 1000 / 10 = 100
    // Position USD = 100 * 150 = 15000
    expect(result.atrMultiplier).toBe(2);
    expect(result.stopDistanceUsd).toBe(10);
    expect(result.riskAmountUsd).toBe(1000);
    expect(result.positionSizeUnits).toBe(100);
    expect(result.positionSizeUsd).toBe(15_000);
    expect(result.method).toBe('volatility-atr');
  });

  it('calculates ATR-based sizing with custom multiplier', () => {
    const svc = createService();
    const result: VolatilityResult = svc.calculateVolatilitySizing({
      portfolioValueUsd: 100_000,
      atr: 5.0,
      riskPerTradePct: 0.01,
      currentPriceUsd: 150,
      atrMultiplier: 3,
    });

    // Stop distance = 5 * 3 = 15
    // Risk amount = 1000
    // Units = 1000 / 15 ≈ 66.666...
    expect(result.stopDistanceUsd).toBe(15);
    expect(result.positionSizeUnits).toBeCloseTo(66.6667, 3);
    expect(result.positionSizeUsd).toBeCloseTo(10_000, 0);
  });

  // ═══ Anti-Martingale Sizing ════════════════════════════════════════

  it('scales up on consecutive wins', () => {
    const svc = createService();
    const result: AntiMartingaleResult = svc.calculateAntiMartingale({
      portfolioValueUsd: 100_000,
      baseRiskPct: 0.02,
      consecutiveWins: 3,
      consecutiveLosses: 0,
    });

    // Scale = 1 + (0.25 * 3) = 1.75
    // Adjusted risk = 0.02 * 1.75 = 0.035
    expect(result.scaleFactor).toBe(1.75);
    expect(result.adjustedRiskPct).toBeCloseTo(0.035, 4);
    expect(result.positionSizeUsd).toBeCloseTo(3_500, 0);
    expect(result.method).toBe('anti-martingale');
  });

  it('scales down on consecutive losses', () => {
    const svc = createService();
    const result: AntiMartingaleResult = svc.calculateAntiMartingale({
      portfolioValueUsd: 100_000,
      baseRiskPct: 0.02,
      consecutiveWins: 0,
      consecutiveLosses: 2,
    });

    // Scale = (1 - 0.5)^2 = 0.25
    // Adjusted risk = 0.02 * 0.25 = 0.005
    expect(result.scaleFactor).toBe(0.25);
    expect(result.adjustedRiskPct).toBeCloseTo(0.005, 4);
    expect(result.positionSizeUsd).toBeCloseTo(500, 0);
  });

  it('respects max/min risk caps for anti-martingale', () => {
    const svc = createService();
    // Many wins should hit the cap
    const winResult = svc.calculateAntiMartingale({
      portfolioValueUsd: 100_000,
      baseRiskPct: 0.05,
      consecutiveWins: 10,
      consecutiveLosses: 0,
      maxRiskPct: 0.10,
    });
    expect(winResult.adjustedRiskPct).toBe(0.10);

    // Many losses should hit the floor
    const lossResult = svc.calculateAntiMartingale({
      portfolioValueUsd: 100_000,
      baseRiskPct: 0.05,
      consecutiveWins: 0,
      consecutiveLosses: 10,
      minRiskPct: 0.005,
    });
    expect(lossResult.adjustedRiskPct).toBe(0.005);
  });

  // ═══ Maximum Drawdown Constraint ═══════════════════════════════════

  it('reduces position size based on current drawdown', () => {
    const svc = createService();
    const result: DrawdownConstraintResult = svc.calculateDrawdownConstraint({
      portfolioValueUsd: 90_000,     // down 10% from peak
      peakPortfolioValueUsd: 100_000,
      maxDrawdownPct: 0.20,          // 20% max
      baseRiskPct: 0.02,
    });

    // Current DD = 10/100 = 10%
    // DD ratio = 0.10 / 0.20 = 0.50
    // Risk multiplier = 1 - 0.50 = 0.50
    // Adjusted risk = 0.02 * 0.50 = 0.01
    expect(result.currentDrawdownPct).toBeCloseTo(0.10, 4);
    expect(result.drawdownRatio).toBeCloseTo(0.50, 4);
    expect(result.adjustedRiskPct).toBeCloseTo(0.01, 4);
    expect(result.positionSizeUsd).toBeCloseTo(900, 0);
    expect(result.isDrawdownBreached).toBe(false);
  });

  it('returns zero size when drawdown exceeds max', () => {
    const svc = createService();
    const result: DrawdownConstraintResult = svc.calculateDrawdownConstraint({
      portfolioValueUsd: 75_000,
      peakPortfolioValueUsd: 100_000,
      maxDrawdownPct: 0.20,
      baseRiskPct: 0.02,
    });

    // Current DD = 25% > max 20%
    expect(result.isDrawdownBreached).toBe(true);
    expect(result.positionSizeUsd).toBe(0);
    expect(result.adjustedRiskPct).toBe(0);
  });

  // ═══ Portfolio Heat Tracking ═══════════════════════════════════════

  it('tracks portfolio heat correctly', () => {
    const svc = createService();
    const heat: PortfolioHeat = svc.updateHeat(
      'agent-1',
      100_000,
      [
        { symbol: 'SOL', riskUsd: 5_000 },
        { symbol: 'BTC', riskUsd: 3_000 },
        { symbol: 'ETH', riskUsd: 2_000 },
      ],
      0.15, // 15% max heat
    );

    expect(heat.agentId).toBe('agent-1');
    expect(heat.totalRiskUsd).toBe(10_000);
    expect(heat.totalHeatPct).toBeCloseTo(0.10, 4);
    expect(heat.portfolioValueUsd).toBe(100_000);
    expect(heat.maxHeatPct).toBe(0.15);
    expect(heat.isOverheated).toBe(false);
    expect(heat.positions).toHaveLength(3);
  });

  it('detects overheated portfolio', () => {
    const svc = createService();
    const heat = svc.updateHeat(
      'agent-hot',
      100_000,
      [
        { symbol: 'SOL', riskUsd: 8_000 },
        { symbol: 'BTC', riskUsd: 7_000 },
        { symbol: 'ETH', riskUsd: 6_000 },
      ],
      0.15,
    );

    // Total risk = 21000 = 21% > 15% max
    expect(heat.totalHeatPct).toBeCloseTo(0.21, 2);
    expect(heat.isOverheated).toBe(true);
  });

  it('returns empty heat for unknown agent', () => {
    const svc = createService();
    const heat = svc.getHeat('unknown-agent');
    expect(heat.totalRiskUsd).toBe(0);
    expect(heat.totalHeatPct).toBe(0);
    expect(heat.isOverheated).toBe(false);
    expect(heat.positions).toHaveLength(0);
  });

  it('persists heat and retrieves via getHeat', () => {
    const svc = createService();
    svc.updateHeat('agent-persist', 50_000, [
      { symbol: 'SOL', riskUsd: 2_500 },
    ]);

    const retrieved = svc.getHeat('agent-persist');
    expect(retrieved.totalRiskUsd).toBe(2_500);
    expect(retrieved.portfolioValueUsd).toBe(50_000);
    expect(retrieved.totalHeatPct).toBeCloseTo(0.05, 4);
  });

  // ═══ Optimal Sizing ════════════════════════════════════════════════

  it('calculates optimal sizing across multiple methods', () => {
    const svc = createService();
    const result: OptimalSizingResult = svc.calculateOptimal({
      portfolioValueUsd: 100_000,
      winRate: 0.6,
      payoffRatio: 1.5,
      atr: 5.0,
      currentPriceUsd: 150,
      entryPriceUsd: 150,
      stopLossPriceUsd: 145,
      consecutiveWins: 2,
      consecutiveLosses: 0,
      peakPortfolioValueUsd: 105_000,
      riskPerTradePct: 0.02,
      maxDrawdownPct: 0.20,
    });

    expect(result.recommended).toBeTruthy();
    expect(result.recommended.method).toBeTruthy();
    expect(result.recommended.positionSizeUsd).toBeGreaterThan(0);
    expect(result.recommended.reason).toContain('conservative');
    expect(result.allMethods.length).toBeGreaterThanOrEqual(4);
    expect(result.calculatedAt).toBeTruthy();
  });

  it('falls back to simple percentage when no inputs provided', () => {
    const svc = createService();
    const result = svc.calculateOptimal({
      portfolioValueUsd: 100_000,
    });

    expect(result.allMethods).toHaveLength(1);
    expect(result.allMethods[0].method).toBe('simple-percentage');
    expect(result.recommended.positionSizeUsd).toBe(2_000);  // 2% of 100k
  });

  it('picks the most conservative sizing as recommended', () => {
    const svc = createService();
    const result = svc.calculateOptimal({
      portfolioValueUsd: 100_000,
      winRate: 0.6,
      payoffRatio: 1.5,
      riskPerTradePct: 0.02,
      peakPortfolioValueUsd: 100_000,
      maxDrawdownPct: 0.20,
    });

    // Recommended should be the smallest position
    const sizes = result.allMethods.map((m) => m.positionSizeUsd);
    const minSize = Math.min(...sizes);
    expect(result.recommended.positionSizeUsd).toBe(minSize);
  });
});
