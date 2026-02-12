import { describe, expect, it } from 'vitest';
import {
  YieldFarmingService,
  YieldOpportunity,
  CompoundResult,
  ImpermanentLossResult,
  ProtocolRiskScore,
  RiskAdjustedYield,
  YieldPosition,
} from '../src/services/yieldFarmingService.js';

function createService(): YieldFarmingService {
  return new YieldFarmingService();
}

describe('YieldFarmingService', () => {
  // ── 1. Scan all opportunities ──────────────────────────────────────
  it('scanOpportunities returns all seeded opportunities', () => {
    const svc = createService();
    const opps = svc.scanOpportunities();

    expect(opps.length).toBeGreaterThanOrEqual(8);
    for (const o of opps) {
      expect(o).toHaveProperty('id');
      expect(o).toHaveProperty('protocol');
      expect(o).toHaveProperty('pool');
      expect(o).toHaveProperty('totalApy');
      expect(o).toHaveProperty('tvlUsd');
      expect(o).toHaveProperty('riskTier');
      expect(o.totalApy).toBeCloseTo(o.baseApy + o.rewardApy, 5);
    }
  });

  // ── 2. Filter by protocol ──────────────────────────────────────────
  it('scanOpportunities filters by protocol', () => {
    const svc = createService();
    const raydiumOpps = svc.scanOpportunities({ protocol: 'raydium' });

    expect(raydiumOpps.length).toBeGreaterThanOrEqual(2);
    for (const o of raydiumOpps) {
      expect(o.protocol).toBe('raydium');
    }
  });

  // ── 3. Filter by minimum APY ───────────────────────────────────────
  it('scanOpportunities filters by minimum APY', () => {
    const svc = createService();
    const highYield = svc.scanOpportunities({ minApy: 20 });

    expect(highYield.length).toBeGreaterThanOrEqual(1);
    for (const o of highYield) {
      expect(o.totalApy).toBeGreaterThanOrEqual(20);
    }
  });

  // ── 4. Filter by max risk tier ─────────────────────────────────────
  it('scanOpportunities filters by max risk tier', () => {
    const svc = createService();
    const lowRisk = svc.scanOpportunities({ maxRisk: 'low' });

    for (const o of lowRisk) {
      expect(o.riskTier).toBe('low');
    }

    const mediumOrLess = svc.scanOpportunities({ maxRisk: 'medium' });
    for (const o of mediumOrLess) {
      expect(['low', 'medium']).toContain(o.riskTier);
    }
  });

  // ── 5. Sort by TVL ─────────────────────────────────────────────────
  it('scanOpportunities sorts by TVL descending', () => {
    const svc = createService();
    const sorted = svc.scanOpportunities({ sortBy: 'tvl' });

    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i - 1].tvlUsd).toBeGreaterThanOrEqual(sorted[i].tvlUsd);
    }
  });

  // ── 6. Get specific opportunity ────────────────────────────────────
  it('getOpportunity returns correct opportunity or null', () => {
    const svc = createService();
    const opp = svc.getOpportunity('yield-raydium-sol-usdc');
    expect(opp).not.toBeNull();
    expect(opp!.protocol).toBe('raydium');
    expect(opp!.pool).toBe('SOL-USDC');

    const missing = svc.getOpportunity('nonexistent');
    expect(missing).toBeNull();
  });

  // ── 7. Compound calculator basic ───────────────────────────────────
  it('calculateCompound returns correct compound interest results', () => {
    const svc = createService();
    const result = svc.calculateCompound({
      principalUsd: 10000,
      apy: 12,
      compoundsPerYear: 365,
    });

    expect(result.principalUsd).toBe(10000);
    expect(result.apy).toBe(12);
    expect(result.compoundsPerYear).toBe(365);
    // Daily compounding of 12% APY on $10k ≈ $11,274.75
    expect(result.finalValueUsd).toBeGreaterThan(11270);
    expect(result.finalValueUsd).toBeLessThan(11280);
    expect(result.earnedUsd).toBeGreaterThan(1270);
    expect(result.effectiveApy).toBeGreaterThan(12); // compounded rate > simple rate
    expect(result.optimalCompoundsPerYear).toBeGreaterThan(0);
  });

  // ── 8. Compound calculator: more compounds = higher returns ────────
  it('more frequent compounding yields higher effective APY', () => {
    const svc = createService();
    const annual = svc.calculateCompound({ principalUsd: 10000, apy: 20, compoundsPerYear: 1 });
    const monthly = svc.calculateCompound({ principalUsd: 10000, apy: 20, compoundsPerYear: 12 });
    const daily = svc.calculateCompound({ principalUsd: 10000, apy: 20, compoundsPerYear: 365 });

    expect(monthly.effectiveApy).toBeGreaterThan(annual.effectiveApy);
    expect(daily.effectiveApy).toBeGreaterThan(monthly.effectiveApy);
  });

  // ── 9. Compound calculator: optimal frequency accounts for gas ─────
  it('optimal frequency balances gas costs vs compounding gains', () => {
    const svc = createService();
    // With high gas cost, optimal should be less frequent
    const highGas = svc.calculateCompound({
      principalUsd: 100,
      apy: 10,
      compoundsPerYear: 365,
      gasCostPerCompoundUsd: 1.0,
    });
    const lowGas = svc.calculateCompound({
      principalUsd: 100,
      apy: 10,
      compoundsPerYear: 365,
      gasCostPerCompoundUsd: 0.001,
    });

    expect(highGas.optimalCompoundsPerYear).toBeLessThan(lowGas.optimalCompoundsPerYear);
    expect(highGas.netGainAtOptimal).toBeLessThan(lowGas.netGainAtOptimal);
  });

  // ── 10. Impermanent loss: no price change = no IL ──────────────────
  it('impermanent loss is zero when price ratio unchanged', () => {
    const svc = createService();
    const result = svc.calculateImpermanentLoss({
      initialPriceRatio: 100,
      currentPriceRatio: 100,
      depositValueUsd: 10000,
    });

    expect(result.priceChangeRatio).toBe(1);
    expect(result.ilPct).toBeCloseTo(0, 2);
    expect(result.ilUsd).toBeCloseTo(0, 1);
  });

  // ── 11. IL increases with price divergence ─────────────────────────
  it('impermanent loss increases as price diverges', () => {
    const svc = createService();

    const small = svc.calculateImpermanentLoss({
      initialPriceRatio: 1,
      currentPriceRatio: 1.25,
      depositValueUsd: 10000,
    });

    const large = svc.calculateImpermanentLoss({
      initialPriceRatio: 1,
      currentPriceRatio: 4,
      depositValueUsd: 10000,
    });

    expect(large.ilPct).toBeGreaterThan(small.ilPct);
    expect(large.ilUsd).toBeGreaterThan(small.ilUsd);
  });

  // ── 12. IL break-even days calculation ─────────────────────────────
  it('calculates break-even days for IL with fee APY', () => {
    const svc = createService();
    const result = svc.calculateImpermanentLoss({
      initialPriceRatio: 1,
      currentPriceRatio: 2,
      depositValueUsd: 10000,
      baseApy: 30,
      durationDays: 365,
    });

    // 2x price change → ~5.72% IL
    expect(result.ilPct).toBeGreaterThan(5);
    expect(result.ilPct).toBeLessThan(6);
    expect(result.breakEvenDays).not.toBeNull();
    expect(result.breakEvenDays!).toBeGreaterThan(0);
    expect(result.netApyAfterIl).toBeLessThan(30);
  });

  // ── 13. Risk-adjusted yield ranking ────────────────────────────────
  it('risk-adjusted ranking orders by Sharpe ratio', () => {
    const svc = createService();
    const ranking = svc.getRiskAdjustedRanking();

    expect(ranking.length).toBeGreaterThanOrEqual(8);

    // Verify sorted by Sharpe descending
    for (let i = 1; i < ranking.length; i++) {
      expect(ranking[i - 1].sharpeRatio).toBeGreaterThanOrEqual(ranking[i].sharpeRatio);
    }

    // Each entry has rank
    for (let i = 0; i < ranking.length; i++) {
      expect(ranking[i].riskAdjustedRank).toBe(i + 1);
    }

    // IL adjusted APY should be less than total APY (for non-zero IL)
    for (const r of ranking) {
      expect(r.ilAdjustedApy).toBeLessThanOrEqual(r.totalApy);
    }
  });

  // ── 14. Enter and track yield position ─────────────────────────────
  it('enterPosition creates and tracks a yield position', () => {
    const svc = createService();
    const pos = svc.enterPosition({
      agentId: 'agent-1',
      opportunityId: 'yield-raydium-sol-usdc',
      depositedUsd: 5000,
    });

    expect(pos.id).toBeDefined();
    expect(pos.agentId).toBe('agent-1');
    expect(pos.opportunityId).toBe('yield-raydium-sol-usdc');
    expect(pos.depositedUsd).toBe(5000);
    expect(pos.currentValueUsd).toBe(5000);
    expect(pos.earnedUsd).toBe(0);
    expect(pos.status).toBe('active');
    expect(pos.protocol).toBe('raydium');
    expect(pos.pool).toBe('SOL-USDC');
    expect(pos.entryApy).toBe(12.7);
  });

  // ── 15. Get positions by agent ─────────────────────────────────────
  it('getPositions returns positions for a specific agent', () => {
    const svc = createService();

    svc.enterPosition({ agentId: 'agent-1', opportunityId: 'yield-raydium-sol-usdc', depositedUsd: 1000 });
    svc.enterPosition({ agentId: 'agent-1', opportunityId: 'yield-orca-sol-usdc', depositedUsd: 2000 });
    svc.enterPosition({ agentId: 'agent-2', opportunityId: 'yield-marinade-msol', depositedUsd: 3000 });

    const a1 = svc.getPositions('agent-1');
    expect(a1.length).toBe(2);
    for (const p of a1) {
      expect(p.agentId).toBe('agent-1');
    }

    const a2 = svc.getPositions('agent-2');
    expect(a2.length).toBe(1);
    expect(a2[0].agentId).toBe('agent-2');
  });

  // ── 16. Enter position with invalid opportunity throws ─────────────
  it('enterPosition throws for invalid opportunity', () => {
    const svc = createService();

    expect(() => svc.enterPosition({
      agentId: 'agent-1',
      opportunityId: 'fake-opp',
      depositedUsd: 1000,
    })).toThrow('Opportunity not found');
  });

  // ── 17. Protocol risk scores ───────────────────────────────────────
  it('getProtocolRiskScores returns seeded protocols sorted by score', () => {
    const svc = createService();
    const scores = svc.getProtocolRiskScores();

    expect(scores.length).toBeGreaterThanOrEqual(6);

    // Sorted by overallScore descending
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i - 1].overallScore).toBeGreaterThanOrEqual(scores[i].overallScore);
    }

    // Each score has required fields
    for (const s of scores) {
      expect(s.overallScore).toBeGreaterThanOrEqual(0);
      expect(s.overallScore).toBeLessThanOrEqual(100);
      expect(['low', 'medium', 'high', 'very-high']).toContain(s.riskTier);
      expect(['audited', 'partial', 'unaudited']).toContain(s.auditStatus);
      expect(typeof s.insuranceCoverage).toBe('boolean');
    }
  });

  // ── 18. Get specific protocol risk score ───────────────────────────
  it('getProtocolRiskScore returns specific protocol or null', () => {
    const svc = createService();

    const marinade = svc.getProtocolRiskScore('marinade');
    expect(marinade).not.toBeNull();
    expect(marinade!.protocol).toBe('marinade');
    expect(marinade!.overallScore).toBeGreaterThan(80); // marinade is well-rated

    const missing = svc.getProtocolRiskScore('unknown-protocol');
    expect(missing).toBeNull();
  });

  // ── 19. Compute custom protocol risk score ─────────────────────────
  it('computeProtocolRisk calculates and caches a custom score', () => {
    const svc = createService();

    const result = svc.computeProtocolRisk({
      protocol: 'new-protocol',
      tvlUsd: 200_000_000,
      auditStatus: 'audited',
      ageMonths: 24,
      insuranceCoverage: true,
    });

    expect(result.protocol).toBe('new-protocol');
    expect(result.overallScore).toBeGreaterThan(50);
    expect(result.tvlScore).toBeGreaterThan(50);
    expect(result.auditScore).toBe(90);
    expect(result.ageScore).toBe(70);
    expect(result.insuranceScore).toBe(80);
    expect(result.riskTier).toBeDefined();

    // Should be cached
    const cached = svc.getProtocolRiskScore('new-protocol');
    expect(cached).not.toBeNull();
    expect(cached!.overallScore).toBe(result.overallScore);
  });

  // ── 20. Unaudited protocol scores low ──────────────────────────────
  it('unaudited protocol with low TVL scores poorly', () => {
    const svc = createService();

    const risky = svc.computeProtocolRisk({
      protocol: 'risky-dex',
      tvlUsd: 500_000,
      auditStatus: 'unaudited',
      ageMonths: 2,
      insuranceCoverage: false,
    });

    expect(risky.overallScore).toBeLessThan(30);
    expect(risky.riskTier).toBe('very-high');
    expect(risky.auditScore).toBe(10);
    expect(risky.insuranceScore).toBe(0);
  });

  // ── 21. Sort opportunities by risk ─────────────────────────────────
  it('scanOpportunities sorts by risk ascending', () => {
    const svc = createService();
    const sorted = svc.scanOpportunities({ sortBy: 'risk' });

    const riskOrder: Record<string, number> = { low: 1, medium: 2, high: 3, 'very-high': 4 };
    for (let i = 1; i < sorted.length; i++) {
      expect(riskOrder[sorted[i - 1].riskTier]).toBeLessThanOrEqual(riskOrder[sorted[i].riskTier]);
    }
  });

  // ── 22. Default sort is by APY descending ──────────────────────────
  it('scanOpportunities defaults to APY descending sort', () => {
    const svc = createService();
    const opps = svc.scanOpportunities();

    for (let i = 1; i < opps.length; i++) {
      expect(opps[i - 1].totalApy).toBeGreaterThanOrEqual(opps[i].totalApy);
    }
  });
});
