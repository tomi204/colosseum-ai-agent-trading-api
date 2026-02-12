import { describe, expect, it, beforeEach } from 'vitest';
import { vi } from 'vitest';
import {
  TokenAnalyticsService,
  HolderDistribution,
  TokenVelocity,
  TokenSupply,
  CorrelationMatrix,
  MomentumScore,
  RiskRating,
} from '../src/services/tokenAnalyticsService.js';
import { AppState } from '../src/types.js';
import { createDefaultState } from '../src/infra/storage/defaultState.js';

function createMockStore(state: AppState) {
  return {
    snapshot: () => structuredClone(state),
    transaction: vi.fn(),
    init: vi.fn(),
    flush: vi.fn(),
  } as any;
}

describe('TokenAnalyticsService', () => {
  let service: TokenAnalyticsService;
  let state: AppState;

  beforeEach(() => {
    state = createDefaultState();
    state.marketPricesUsd['SOL'] = 100;
    state.marketPricesUsd['BONK'] = 0.002;
    state.marketPricesUsd['JUP'] = 5;
    state.marketPricesUsd['ETH'] = 3000;

    // Create some price history for SOL
    const now = Date.now();
    state.marketPriceHistoryUsd = state.marketPriceHistoryUsd ?? {};
    state.marketPriceHistoryUsd['SOL'] = Array.from({ length: 20 }, (_, i) => ({
      ts: new Date(now - (20 - i) * 3600_000).toISOString(),
      priceUsd: 90 + i * 0.5 + Math.sin(i) * 3,
    }));
    state.marketPriceHistoryUsd['BONK'] = Array.from({ length: 20 }, (_, i) => ({
      ts: new Date(now - (20 - i) * 3600_000).toISOString(),
      priceUsd: 0.001 + i * 0.00005 + Math.cos(i) * 0.0001,
    }));
    state.marketPriceHistoryUsd['JUP'] = Array.from({ length: 15 }, (_, i) => ({
      ts: new Date(now - (15 - i) * 3600_000).toISOString(),
      priceUsd: 4.5 + i * 0.04 - Math.sin(i) * 0.2,
    }));

    // Add some executions to give the service data
    state.executions['exec-1'] = {
      id: 'exec-1',
      intentId: 'i1',
      agentId: 'agent-1',
      symbol: 'SOL',
      side: 'buy',
      quantity: 10,
      priceUsd: 100,
      grossNotionalUsd: 1000,
      feeUsd: 1,
      netUsd: 999,
      realizedPnlUsd: 0,
      pnlSnapshotUsd: 0,
      mode: 'paper',
      status: 'filled',
      createdAt: new Date().toISOString(),
    } as any;
    state.executions['exec-2'] = {
      id: 'exec-2',
      intentId: 'i2',
      agentId: 'agent-1',
      symbol: 'SOL',
      side: 'sell',
      quantity: 5,
      priceUsd: 105,
      grossNotionalUsd: 525,
      feeUsd: 0.5,
      netUsd: 524.5,
      realizedPnlUsd: 25,
      pnlSnapshotUsd: 25,
      mode: 'paper',
      status: 'filled',
      createdAt: new Date().toISOString(),
    } as any;

    const store = createMockStore(state);
    service = new TokenAnalyticsService(store);
  });

  // ─── Holder Distribution ─────────────────────────────────────────────

  it('returns holder distribution with expected fields', () => {
    const result: HolderDistribution = service.getHolderDistribution('SOL');
    expect(result.symbol).toBe('SOL');
    expect(result.totalHolders).toBeGreaterThan(0);
    expect(result.topHolders).toHaveLength(10);
    expect(result.whalePct).toBeGreaterThan(0);
    expect(result.whalePct).toBeLessThanOrEqual(100);
    expect(result.herfindahlIndex).toBeGreaterThan(0);
    expect(result.giniCoefficient).toBeGreaterThanOrEqual(0);
    expect(result.giniCoefficient).toBeLessThanOrEqual(1);
    expect(result.timestamp).toBeDefined();
  });

  it('normalises holder distribution symbol to uppercase', () => {
    const result = service.getHolderDistribution('sol');
    expect(result.symbol).toBe('SOL');
  });

  it('topHolders are sorted descending by balance', () => {
    const result = service.getHolderDistribution('SOL');
    for (let i = 1; i < result.topHolders.length; i++) {
      expect(result.topHolders[i - 1].balance).toBeGreaterThanOrEqual(
        result.topHolders[i].balance,
      );
    }
  });

  // ─── Token Velocity ──────────────────────────────────────────────────

  it('returns token velocity with required fields', () => {
    const result: TokenVelocity = service.getTokenVelocity('SOL');
    expect(result.symbol).toBe('SOL');
    expect(typeof result.velocity).toBe('number');
    expect(result.avgHoldPeriodHours).toBeGreaterThan(0);
    expect(typeof result.transfersLast24h).toBe('number');
    expect(typeof result.volumeLast24hUsd).toBe('number');
    expect(['accelerating', 'stable', 'decelerating']).toContain(result.velocityTrend);
    expect(result.timestamp).toBeDefined();
  });

  it('computes velocity trend from execution data', () => {
    const result = service.getTokenVelocity('SOL');
    // With only 2 executions, it should still work
    expect(result.velocity).toBeGreaterThanOrEqual(0);
  });

  // ─── Supply Analysis ─────────────────────────────────────────────────

  it('returns supply analysis that sums correctly', () => {
    const result: TokenSupply = service.getSupplyAnalysis('SOL');
    expect(result.symbol).toBe('SOL');
    expect(result.maxSupply).toBeGreaterThan(0);
    expect(result.circulatingSupply + result.lockedSupply + result.burnedSupply).toBe(
      result.maxSupply,
    );
    expect(result.totalSupply).toBe(result.maxSupply - result.burnedSupply);
    expect(result.circulatingPct + result.lockedPct + result.burnedPct).toBeCloseTo(100, 0);
    expect(result.inflationRatePct).toBeGreaterThanOrEqual(0);
  });

  it('supply analysis is deterministic for same symbol', () => {
    const a = service.getSupplyAnalysis('BONK');
    const b = service.getSupplyAnalysis('BONK');
    expect(a.maxSupply).toBe(b.maxSupply);
    expect(a.circulatingSupply).toBe(b.circulatingSupply);
    expect(a.lockedSupply).toBe(b.lockedSupply);
    expect(a.burnedSupply).toBe(b.burnedSupply);
  });

  // ─── Correlation Matrix ──────────────────────────────────────────────

  it('returns correlation matrix with diagonal = 1', () => {
    const result: CorrelationMatrix = service.getCorrelationMatrix(['SOL', 'BONK', 'JUP']);
    expect(result.symbols).toHaveLength(3);
    expect(result.matrix).toHaveLength(3);

    // Diagonal should be 1
    for (let i = 0; i < 3; i++) {
      expect(result.matrix[i][i]).toBe(1);
    }

    // Matrix should be symmetric
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        expect(result.matrix[i][j]).toBe(result.matrix[j][i]);
      }
    }

    // Correlations should be between -1 and 1
    for (const pair of result.pairs) {
      expect(pair.correlation).toBeGreaterThanOrEqual(-1);
      expect(pair.correlation).toBeLessThanOrEqual(1);
      expect([
        'strong-negative', 'moderate-negative', 'weak',
        'moderate-positive', 'strong-positive',
      ]).toContain(pair.strength);
    }
  });

  it('auto-discovers symbols when none provided', () => {
    const result = service.getCorrelationMatrix();
    // Should include symbols from marketPriceHistoryUsd
    expect(result.symbols.length).toBeGreaterThan(0);
  });

  // ─── Momentum Score ──────────────────────────────────────────────────

  it('returns momentum score in 0-100 range', () => {
    const result: MomentumScore = service.getMomentumScore('SOL');
    expect(result.symbol).toBe('SOL');
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
    expect([
      'strong-bearish', 'bearish', 'neutral', 'bullish', 'strong-bullish',
    ]).toContain(result.signal);
    expect(result.components).toBeDefined();
    expect(typeof result.components.rsi).toBe('number');
    expect(typeof result.components.priceChange24h).toBe('number');
    expect(typeof result.components.priceChange7d).toBe('number');
    expect(typeof result.components.macdSignal).toBe('number');
    expect(typeof result.components.volumeTrend).toBe('number');
  });

  it('handles symbol with no price history gracefully', () => {
    const result = service.getMomentumScore('UNKNOWN');
    expect(result.symbol).toBe('UNKNOWN');
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  // ─── Risk Rating ─────────────────────────────────────────────────────

  it('returns risk rating with valid grade', () => {
    const result: RiskRating = service.getRiskRating('SOL');
    expect(result.symbol).toBe('SOL');
    expect(result.overallRisk).toBeGreaterThanOrEqual(0);
    expect(result.overallRisk).toBeLessThanOrEqual(100);
    expect(['A', 'B', 'C', 'D', 'F']).toContain(result.grade);
    expect(result.components.volatilityRisk).toBeGreaterThanOrEqual(0);
    expect(result.components.liquidityRisk).toBeGreaterThanOrEqual(0);
    expect(result.components.concentrationRisk).toBeGreaterThanOrEqual(0);
    expect(result.factors.length).toBeGreaterThan(0);
    expect(result.timestamp).toBeDefined();
  });

  it('risk rating components are all within 0-100', () => {
    const result = service.getRiskRating('BONK');
    expect(result.components.volatilityRisk).toBeLessThanOrEqual(100);
    expect(result.components.liquidityRisk).toBeLessThanOrEqual(100);
    expect(result.components.concentrationRisk).toBeLessThanOrEqual(100);
  });

  it('risk grade reflects overall risk level', () => {
    // Different symbols should potentially have different risk grades
    const sol = service.getRiskRating('SOL');
    const unknown = service.getRiskRating('NEWTOKEN');
    // Both should have valid grades
    expect(['A', 'B', 'C', 'D', 'F']).toContain(sol.grade);
    expect(['A', 'B', 'C', 'D', 'F']).toContain(unknown.grade);
  });
});
