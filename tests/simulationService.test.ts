import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import { SimulationService } from '../src/services/simulationService.js';
import { FeeEngine } from '../src/domain/fee/feeEngine.js';
import { StateStore } from '../src/infra/storage/stateStore.js';
import { createTempDir, buildTestConfig } from './helpers.js';

describe('SimulationService', () => {
  let tmpDir: string;
  let store: StateStore;
  let service: SimulationService;

  beforeEach(async () => {
    tmpDir = await createTempDir();
    const config = buildTestConfig(tmpDir);
    store = new StateStore(config.paths.stateFile);
    await store.init();

    const feeEngine = new FeeEngine(config.trading);
    service = new SimulationService(store, feeEngine, config);

    // Seed an agent with some cash and a position
    await store.transaction((state) => {
      state.agents['agent-1'] = {
        id: 'agent-1',
        name: 'Test Agent',
        apiKey: 'test-key',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        startingCapitalUsd: 10000,
        cashUsd: 8000,
        realizedPnlUsd: 0,
        peakEquityUsd: 10000,
        riskLimits: {
          maxPositionSizePct: 0.25,
          maxOrderNotionalUsd: 2500,
          maxGrossExposureUsd: 7500,
          dailyLossCapUsd: 1000,
          maxDrawdownPct: 0.2,
          cooldownSeconds: 3,
        },
        positions: {
          SOL: { symbol: 'SOL', quantity: 20, avgEntryPriceUsd: 100 },
        },
        dailyRealizedPnlUsd: {},
        riskRejectionsByReason: {},
        strategyId: 'momentum-v1',
      };

      state.marketPricesUsd = {
        SOL: 100,
        USDC: 1,
        BONK: 0.00002,
        JUP: 0.8,
      };
      return undefined;
    });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('simulates a buy trade successfully', () => {
    const result = service.simulate({
      agentId: 'agent-1',
      symbol: 'SOL',
      side: 'buy',
      notionalUsd: 500,
    });

    expect(result.feasible).toBe(true);
    expect(result.infeasibilityReason).toBeNull();
    expect(result.symbol).toBe('SOL');
    expect(result.side).toBe('buy');
    expect(result.grossNotionalUsd).toBe(500);
    expect(result.projectedFeeUsd).toBeGreaterThan(0);
    expect(result.projectedNetUsd).toBeLessThan(0); // buying costs money
    expect(result.projectedCashAfter).toBeLessThan(8000);
    expect(result.simulationId).toBeDefined();
    expect(result.riskImpact).toBeDefined();
    expect(result.riskImpact.projectedGrossExposureUsd).toBeGreaterThan(
      result.riskImpact.currentGrossExposureUsd,
    );
  });

  it('simulates a sell trade with P&L projection', () => {
    const result = service.simulate({
      agentId: 'agent-1',
      symbol: 'SOL',
      side: 'sell',
      quantity: 5,
      hypotheticalPriceUsd: 120,
    });

    expect(result.feasible).toBe(true);
    expect(result.projectedRealizedPnlUsd).toBe(100); // (120-100)*5
    expect(result.projectedNetUsd).toBeGreaterThan(0); // selling produces cash
  });

  it('detects insufficient cash for buy', () => {
    const result = service.simulate({
      agentId: 'agent-1',
      symbol: 'SOL',
      side: 'buy',
      notionalUsd: 9000, // more than 8000 cash
    });

    expect(result.feasible).toBe(false);
    expect(result.infeasibilityReason).toContain('insufficient_cash');
  });

  it('detects insufficient position for sell', () => {
    const result = service.simulate({
      agentId: 'agent-1',
      symbol: 'SOL',
      side: 'sell',
      quantity: 50, // only have 20
    });

    expect(result.feasible).toBe(false);
    expect(result.infeasibilityReason).toContain('insufficient_position');
  });

  it('returns infeasible for unknown agent', () => {
    const result = service.simulate({
      agentId: 'nonexistent',
      symbol: 'SOL',
      side: 'buy',
      notionalUsd: 100,
    });

    expect(result.feasible).toBe(false);
    expect(result.infeasibilityReason).toBe('agent_not_found');
  });

  it('returns infeasible for missing market price', () => {
    const result = service.simulate({
      agentId: 'agent-1',
      symbol: 'UNKNOWN_TOKEN',
      side: 'buy',
      notionalUsd: 100,
    });

    expect(result.feasible).toBe(false);
    expect(result.infeasibilityReason).toBe('market_price_missing');
  });

  it('detects risk limit violations', () => {
    const result = service.simulate({
      agentId: 'agent-1',
      symbol: 'SOL',
      side: 'buy',
      notionalUsd: 2600, // exceeds maxOrderNotionalUsd of 2500
    });

    expect(result.feasible).toBe(false);
    expect(result.riskImpact.wouldExceedLimits).toBe(true);
    expect(result.riskImpact.limitViolations).toContain('max_order_notional_exceeded');
  });

  it('allows hypothetical price override', () => {
    const result = service.simulate({
      agentId: 'agent-1',
      symbol: 'SOL',
      side: 'buy',
      notionalUsd: 500,
      hypotheticalPriceUsd: 200,
    });

    expect(result.feasible).toBe(true);
    expect(result.priceUsd).toBe(200);
    expect(result.quantity).toBeCloseTo(2.5, 4);
  });
});
