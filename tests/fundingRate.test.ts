import { describe, expect, it, beforeEach } from 'vitest';
import {
  FundingRateService,
  Protocol,
} from '../src/services/fundingRateService.js';

describe('FundingRateService', () => {
  let service: FundingRateService;

  beforeEach(() => {
    service = new FundingRateService();
  });

  // ─── Current Funding Rates ────────────────────────────────────────────

  it('returns current funding rates for SOL-PERP across both protocols', () => {
    const rates = service.getCurrentRates('SOL-PERP');
    expect(rates).toHaveLength(2);

    const protocols = rates.map((r) => r.protocol).sort();
    expect(protocols).toEqual(['drift', 'mango']);

    for (const rate of rates) {
      expect(rate.symbol).toBe('SOL-PERP');
      expect(rate.fundingRate).toBeDefined();
      expect(typeof rate.fundingRate).toBe('number');
      expect(rate.fundingRateAnnualized).toBeDefined();
      expect(rate.markPrice).toBeGreaterThan(0);
      expect(rate.indexPrice).toBeGreaterThan(0);
      expect(rate.openInterest).toBeGreaterThan(0);
      expect(rate.nextFundingAt).toBeDefined();
      expect(rate.period).toMatch(/^(hourly|8h)$/);
      expect(rate.timestamp).toBeDefined();
    }
  });

  it('returns empty array for unknown symbol', () => {
    const rates = service.getCurrentRates('UNKNOWN-PERP');
    expect(rates).toEqual([]);
  });

  it('returns correct funding period per protocol', () => {
    const rates = service.getCurrentRates('BTC-PERP');
    const drift = rates.find((r) => r.protocol === 'drift')!;
    const mango = rates.find((r) => r.protocol === 'mango')!;

    expect(drift.period).toBe('hourly');
    expect(mango.period).toBe('8h');
  });

  it('lists all tracked symbols', () => {
    const symbols = service.getSymbols();
    expect(symbols.length).toBeGreaterThanOrEqual(6);
    expect(symbols).toContain('SOL-PERP');
    expect(symbols).toContain('BTC-PERP');
    expect(symbols).toContain('ETH-PERP');
  });

  // ─── Historical Funding Rates ─────────────────────────────────────────

  it('returns historical funding rate data with stats', () => {
    const history = service.getHistory('SOL-PERP');
    expect(history).toHaveLength(2); // drift + mango

    for (const h of history) {
      expect(h.symbol).toBe('SOL-PERP');
      expect(h.entries.length).toBeGreaterThan(0);
      expect(h.entries.length).toBeLessThanOrEqual(168);
      expect(h.avgRate).toBeDefined();
      expect(h.medianRate).toBeDefined();
      expect(h.maxRate).toBeDefined();
      expect(h.minRate).toBeDefined();
      expect(h.stdDev).toBeGreaterThanOrEqual(0);
      expect(h.totalEntries).toBe(h.entries.length);

      // Each entry has all required fields
      const entry = h.entries[0];
      expect(entry.timestamp).toBeDefined();
      expect(typeof entry.fundingRate).toBe('number');
      expect(entry.markPrice).toBeGreaterThan(0);
      expect(entry.indexPrice).toBeGreaterThan(0);
      expect(entry.openInterest).toBeGreaterThan(0);
    }
  });

  it('filters history by protocol', () => {
    const history = service.getHistory('BTC-PERP', { protocol: 'drift' });
    expect(history).toHaveLength(1);
    expect(history[0].protocol).toBe('drift');
  });

  it('respects limit parameter for history', () => {
    const history = service.getHistory('ETH-PERP', { limit: 10 });
    for (const h of history) {
      expect(h.entries.length).toBeLessThanOrEqual(10);
      expect(h.totalEntries).toBeLessThanOrEqual(10);
    }
  });

  it('returns empty array for unknown symbol history', () => {
    const history = service.getHistory('FAKE-PERP');
    expect(history).toEqual([]);
  });

  // ─── Arbitrage Opportunity Detection ──────────────────────────────────

  it('detects funding rate arbitrage opportunities', () => {
    const opps = service.getArbitrageOpportunities();
    expect(opps.length).toBeGreaterThan(0);

    for (const opp of opps) {
      expect(opp.id).toBeDefined();
      expect(opp.symbol).toBeDefined();
      expect(opp.direction).toMatch(/^(long-spot-short-perp|short-spot-long-perp)$/);
      expect(opp.protocol).toMatch(/^(drift|mango)$/);
      expect(typeof opp.fundingRate).toBe('number');
      expect(typeof opp.fundingRateAnnualized).toBe('number');
      expect(typeof opp.basisPct).toBe('number');
      expect(typeof opp.estimatedAnnualYieldPct).toBe('number');
      expect(opp.markPrice).toBeGreaterThan(0);
      expect(opp.spotPrice).toBeGreaterThan(0);
      expect(opp.riskLevel).toMatch(/^(low|medium|high)$/);
      expect(opp.capitalRequiredUsd).toBeGreaterThan(0);
      expect(opp.detectedAt).toBeDefined();
      expect(opp.expiresAt).toBeDefined();
      expect(typeof opp.viable).toBe('boolean');
    }
  });

  it('positive funding → long-spot-short-perp direction', () => {
    const opps = service.getArbitrageOpportunities({ symbol: 'SOL-PERP' });
    const positiveRate = opps.find((o) => o.fundingRate > 0);
    if (positiveRate) {
      expect(positiveRate.direction).toBe('long-spot-short-perp');
    }
  });

  it('negative funding → short-spot-long-perp direction', () => {
    // BONK-PERP has negative funding rates in seed data
    const opps = service.getArbitrageOpportunities({ symbol: 'BONK-PERP' });
    const negativeRate = opps.find((o) => o.fundingRate < 0);
    if (negativeRate) {
      expect(negativeRate.direction).toBe('short-spot-long-perp');
    }
  });

  it('filters opportunities by minimum annualized yield', () => {
    const lowThreshold = service.getArbitrageOpportunities({ minAnnualizedYieldPct: 1 });
    const highThreshold = service.getArbitrageOpportunities({ minAnnualizedYieldPct: 50 });
    expect(lowThreshold.length).toBeGreaterThanOrEqual(highThreshold.length);
  });

  it('opportunities are sorted by estimated yield descending', () => {
    const opps = service.getArbitrageOpportunities();
    for (let i = 1; i < opps.length; i++) {
      expect(opps[i - 1].estimatedAnnualYieldPct).toBeGreaterThanOrEqual(opps[i].estimatedAnnualYieldPct);
    }
  });

  // ─── Predicted Funding Rate ───────────────────────────────────────────

  it('predicts next funding rate with confidence and factors', () => {
    const predictions = service.predictFundingRate('SOL-PERP');
    expect(predictions).toHaveLength(2);

    for (const pred of predictions) {
      expect(pred.symbol).toBe('SOL-PERP');
      expect(pred.protocol).toMatch(/^(drift|mango)$/);
      expect(typeof pred.currentRate).toBe('number');
      expect(typeof pred.predictedRate).toBe('number');
      expect(pred.confidence).toBeGreaterThan(0);
      expect(pred.confidence).toBeLessThanOrEqual(1);
      expect(pred.factors).toBeDefined();
      expect(typeof pred.factors.openInterestBias).toBe('number');
      expect(typeof pred.factors.markIndexSpread).toBe('number');
      expect(typeof pred.factors.recentTrend).toBe('number');
      expect(typeof pred.factors.volatilityImpact).toBe('number');
      expect(pred.predictedAt).toBeDefined();
    }
  });

  it('filters prediction by protocol', () => {
    const predictions = service.predictFundingRate('ETH-PERP', 'mango');
    expect(predictions).toHaveLength(1);
    expect(predictions[0].protocol).toBe('mango');
  });

  it('returns empty for unknown symbol prediction', () => {
    const predictions = service.predictFundingRate('FAKE-PERP');
    expect(predictions).toEqual([]);
  });

  // ─── Carry Trade Calculator ───────────────────────────────────────────

  it('calculates carry trade returns for a given position size', () => {
    const results = service.calculateCarryTrade('SOL-PERP', 10_000);
    expect(results).toHaveLength(2);

    for (const r of results) {
      expect(r.symbol).toBe('SOL-PERP');
      expect(r.positionSizeUsd).toBe(10_000);
      expect(r.protocol).toMatch(/^(drift|mango)$/);
      expect(typeof r.fundingRate).toBe('number');
      expect(r.fundingPeriod).toMatch(/^(hourly|8h)$/);
      expect(r.periodsPerYear).toBeGreaterThan(0);
      expect(r.annualizedYieldPct).toBeGreaterThan(0);
      expect(r.dailyYieldUsd).toBeGreaterThan(0);
      expect(r.weeklyYieldUsd).toBeGreaterThan(0);
      expect(r.monthlyYieldUsd).toBeGreaterThan(0);
      expect(r.yearlyYieldUsd).toBeGreaterThan(0);
      expect(r.breakEvenSlippagePct).toBeGreaterThan(0);
      expect(r.riskAdjustedYieldPct).toBeGreaterThan(0);
      expect(r.riskAdjustedYieldPct).toBeLessThan(r.annualizedYieldPct);
      expect(r.calculatedAt).toBeDefined();
    }
  });

  it('carry trade daily yield scales linearly with position size', () => {
    const small = service.calculateCarryTrade('BTC-PERP', 1_000, 'drift');
    const large = service.calculateCarryTrade('BTC-PERP', 10_000, 'drift');

    expect(small).toHaveLength(1);
    expect(large).toHaveLength(1);

    // 10x position should give ~10x daily yield
    const ratio = large[0].dailyYieldUsd / small[0].dailyYieldUsd;
    expect(ratio).toBeCloseTo(10, 0);
  });

  it('returns empty for unknown symbol carry trade', () => {
    const results = service.calculateCarryTrade('FAKE-PERP', 10_000);
    expect(results).toEqual([]);
  });

  // ─── Basis Tracking ───────────────────────────────────────────────────

  it('tracks basis for a symbol across protocols', () => {
    const basis = service.getBasis('SOL-PERP');
    expect(basis).not.toBeNull();
    expect(basis!.symbol).toBe('SOL-PERP');
    expect(basis!.protocols).toHaveLength(2);
    expect(basis!.timestamp).toBeDefined();
    expect(basis!.basisTrend).toMatch(/^(contango|backwardation|flat)$/);
    expect(typeof basis!.avgBasisPct).toBe('number');

    for (const entry of basis!.protocols) {
      expect(entry.protocol).toMatch(/^(drift|mango)$/);
      expect(entry.spotPrice).toBeGreaterThan(0);
      expect(entry.perpPrice).toBeGreaterThan(0);
      expect(typeof entry.basisAbsolute).toBe('number');
      expect(typeof entry.basisPct).toBe('number');
      expect(typeof entry.fundingRate).toBe('number');
      expect(typeof entry.annualizedBasisPct).toBe('number');
    }
  });

  it('returns null for unknown symbol basis', () => {
    const basis = service.getBasis('FAKE-PERP');
    expect(basis).toBeNull();
  });

  it('returns all basis across all symbols', () => {
    const allBasis = service.getAllBasis();
    expect(allBasis.length).toBeGreaterThanOrEqual(6);

    const symbols = allBasis.map((b) => b.symbol);
    expect(symbols).toContain('SOL-PERP');
    expect(symbols).toContain('BTC-PERP');
    expect(symbols).toContain('ETH-PERP');
  });

  it('SOL-PERP should be in contango (perp > spot in seed data)', () => {
    const basis = service.getBasis('SOL-PERP');
    expect(basis).not.toBeNull();
    // SOL seed: drift mark=105.45, mango mark=105.38, spot=105.20 → all perp > spot
    expect(basis!.basisTrend).toBe('contango');
    expect(basis!.avgBasisPct).toBeGreaterThan(0);
  });
});
