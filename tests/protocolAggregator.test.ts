import { describe, expect, it } from 'vitest';
import { ProtocolAggregatorService } from '../src/services/protocolAggregatorService.js';

function createService(): ProtocolAggregatorService {
  return new ProtocolAggregatorService();
}

describe('ProtocolAggregatorService', () => {
  // ── 1. List all protocols ──────────────────────────────────────────
  it('lists all seeded protocols (6 protocols)', () => {
    const svc = createService();
    const protocols = svc.listProtocols();
    expect(protocols.length).toBe(6);

    const ids = protocols.map((p) => p.id).sort();
    expect(ids).toEqual(['drift', 'jupiter', 'kamino', 'marinade', 'orca', 'raydium']);
  });

  // ── 2. Get specific protocol ───────────────────────────────────────
  it('returns a specific protocol by id', () => {
    const svc = createService();
    const protocol = svc.getProtocol('jupiter');
    expect(protocol).not.toBeNull();
    expect(protocol!.name).toBe('Jupiter');
    expect(protocol!.category).toBe('aggregator');
    expect(protocol!.chain).toBe('solana');
  });

  // ── 3. Returns null for unknown protocol ───────────────────────────
  it('returns null for unknown protocol id', () => {
    const svc = createService();
    const result = svc.getProtocol('nonexistent');
    expect(result).toBeNull();
  });

  // ── 4. Protocol with health breakdown ──────────────────────────────
  it('returns protocol with health breakdown', () => {
    const svc = createService();
    const result = svc.getProtocolWithHealth('kamino');
    expect(result).not.toBeNull();
    expect(result!.healthBreakdown).toBeDefined();
    expect(result!.healthBreakdown.tvlScore).toBeGreaterThan(0);
    expect(result!.healthBreakdown.auditScore).toBe(100); // fully-audited
    expect(result!.healthBreakdown.ageScore).toBeGreaterThan(0);
    expect(result!.healthBreakdown.incidentScore).toBe(100); // no incidents
  });

  // ── 5. Health score within bounds ──────────────────────────────────
  it('health scores are between 0 and 100', () => {
    const svc = createService();
    const protocols = svc.listProtocols();
    for (const p of protocols) {
      expect(p.healthScore).toBeGreaterThanOrEqual(0);
      expect(p.healthScore).toBeLessThanOrEqual(100);
    }
  });

  // ── 6. Risk grades are valid ───────────────────────────────────────
  it('risk grades are A, B, C, D, or F', () => {
    const svc = createService();
    const protocols = svc.listProtocols();
    const validGrades = ['A', 'B', 'C', 'D', 'F'];
    for (const p of protocols) {
      expect(validGrades).toContain(p.riskGrade);
    }
  });

  // ── 7. TVL rankings ────────────────────────────────────────────────
  it('provides TVL rankings sorted by TVL descending', () => {
    const svc = createService();
    const rankings = svc.getTvlRankings();

    expect(rankings.rankings.length).toBe(6);
    expect(rankings.totalTvlUsd).toBeGreaterThan(0);
    expect(rankings.rankings[0].rank).toBe(1);

    // Verify descending order
    for (let i = 1; i < rankings.rankings.length; i++) {
      expect(rankings.rankings[i - 1].tvlUsd).toBeGreaterThanOrEqual(rankings.rankings[i].tvlUsd);
    }

    // Market shares sum to ~100%
    const totalShare = rankings.rankings.reduce((sum, r) => sum + r.marketSharePct, 0);
    expect(totalShare).toBeCloseTo(100, 0);
  });

  // ── 8. Protocol comparison ─────────────────────────────────────────
  it('compares protocols side by side', () => {
    const svc = createService();
    const comparison = svc.compareProtocols(['raydium', 'orca', 'jupiter']);

    expect(comparison.protocols.length).toBe(3);
    expect(comparison.rankedBy).toBe('healthScore');
    expect(comparison.comparedAt).toBeDefined();

    for (const p of comparison.protocols) {
      expect(p.tvlUsd).toBeGreaterThan(0);
      expect(p.healthScore).toBeGreaterThanOrEqual(0);
    }
  });

  // ── 9. Compare all protocols (no filter) ───────────────────────────
  it('compares all protocols when no ids provided', () => {
    const svc = createService();
    const comparison = svc.compareProtocols();
    expect(comparison.protocols.length).toBe(6);
  });

  // ── 10. Unified swap routing ───────────────────────────────────────
  it('routes swap through best protocol', () => {
    const svc = createService();
    const result = svc.executeSwap({
      inputToken: 'SOL',
      outputToken: 'USDC',
      amountUsd: 1000,
    });

    expect(result.bestQuote).toBeDefined();
    expect(result.allQuotes.length).toBeGreaterThan(0);
    expect(result.selectedProtocol).toBeDefined();
    expect(result.bestQuote.outputAmount).toBeGreaterThan(0);
    expect(result.bestQuote.outputAmount).toBeLessThanOrEqual(1000);
    expect(result.savings).toBeDefined();
    expect(result.executedAt).toBeDefined();

    // Best quote should have highest output among all quotes
    for (const q of result.allQuotes) {
      expect(result.bestQuote.outputAmount).toBeGreaterThanOrEqual(q.outputAmount);
    }
  });

  // ── 11. Swap with preferred protocol ───────────────────────────────
  it('respects preferred protocol in swap', () => {
    const svc = createService();
    const result = svc.executeSwap({
      inputToken: 'SOL',
      outputToken: 'USDC',
      amountUsd: 500,
      preferredProtocol: 'jupiter',
    });

    expect(result.selectedProtocol).toBe('jupiter');
    expect(result.bestQuote.protocol).toBe('jupiter');
  });

  // ── 12. Cross-protocol yield comparison ────────────────────────────
  it('compares yields across protocols', () => {
    const svc = createService();
    const yields = svc.compareYields();

    expect(yields.length).toBeGreaterThan(0);

    for (const y of yields) {
      expect(y.protocolId).toBeDefined();
      expect(y.pools.length).toBeGreaterThan(0);
      expect(y.avgApy).toBeGreaterThanOrEqual(0);
      expect(y.bestApy).toBeGreaterThanOrEqual(y.avgApy);
      expect(y.poolCount).toBe(y.pools.length);
    }

    // Should be sorted by best APY descending
    for (let i = 1; i < yields.length; i++) {
      expect(yields[i - 1].bestApy).toBeGreaterThanOrEqual(yields[i].bestApy);
    }
  });

  // ── 13. Yield comparison filtered by token ─────────────────────────
  it('filters yield comparison by token', () => {
    const svc = createService();
    const yields = svc.compareYields('SOL');

    expect(yields.length).toBeGreaterThan(0);
    for (const y of yields) {
      for (const pool of y.pools) {
        expect(pool.tokenA === 'SOL' || pool.tokenB === 'SOL').toBe(true);
      }
    }
  });

  // ── 14. Risk alerts ────────────────────────────────────────────────
  it('returns risk alerts', () => {
    const svc = createService();
    const alerts = svc.getAlerts();

    expect(alerts.length).toBeGreaterThanOrEqual(2);
    for (const alert of alerts) {
      expect(alert.id).toBeDefined();
      expect(alert.protocolId).toBeDefined();
      expect(alert.type).toBeDefined();
      expect(alert.severity).toBeDefined();
    }
  });

  // ── 15. Filter alerts by severity ──────────────────────────────────
  it('filters alerts by severity', () => {
    const svc = createService();
    const warnings = svc.getAlerts({ severity: 'warning' });
    for (const a of warnings) {
      expect(a.severity).toBe('warning');
    }
  });

  // ── 16. Filter alerts by protocol ──────────────────────────────────
  it('filters alerts by protocol', () => {
    const svc = createService();
    const driftAlerts = svc.getAlerts({ protocolId: 'drift' });
    for (const a of driftAlerts) {
      expect(a.protocolId).toBe('drift');
    }
  });

  // ── 17. Add custom alert ───────────────────────────────────────────
  it('allows adding custom alerts', () => {
    const svc = createService();
    const beforeCount = svc.getAlerts().length;

    const newAlert = svc.addAlert({
      protocolId: 'raydium',
      protocolName: 'Raydium',
      type: 'exploit',
      severity: 'critical',
      title: 'Test exploit alert',
      description: 'Test description',
      detectedAt: new Date().toISOString(),
      resolved: false,
      resolvedAt: null,
      metadata: {},
    });

    expect(newAlert.id).toBeDefined();
    expect(svc.getAlerts().length).toBe(beforeCount + 1);
  });

  // ── 18. Drift has incident penalty in health score ─────────────────
  it('Drift has lower health score due to incident history', () => {
    const svc = createService();
    const drift = svc.getProtocol('drift');
    const kamino = svc.getProtocol('kamino');

    expect(drift).not.toBeNull();
    expect(kamino).not.toBeNull();
    // Drift has incidents + partial audit, should score lower than Kamino (no incidents, fully audited)
    expect(drift!.healthScore).toBeLessThan(kamino!.healthScore);
  });

  // ── 19. Protocol categories are correct ────────────────────────────
  it('protocols have correct categories', () => {
    const svc = createService();
    expect(svc.getProtocol('raydium')!.category).toBe('dex');
    expect(svc.getProtocol('orca')!.category).toBe('dex');
    expect(svc.getProtocol('marinade')!.category).toBe('liquid-staking');
    expect(svc.getProtocol('jupiter')!.category).toBe('aggregator');
    expect(svc.getProtocol('drift')!.category).toBe('perpetuals');
    expect(svc.getProtocol('kamino')!.category).toBe('lending');
  });

  // ── 20. Comparison sort by TVL ─────────────────────────────────────
  it('compares protocols sorted by TVL', () => {
    const svc = createService();
    const comparison = svc.compareProtocols(undefined, 'tvl');
    expect(comparison.rankedBy).toBe('tvl');

    for (let i = 1; i < comparison.protocols.length; i++) {
      expect(comparison.protocols[i - 1].tvlUsd).toBeGreaterThanOrEqual(comparison.protocols[i].tvlUsd);
    }
  });
});
