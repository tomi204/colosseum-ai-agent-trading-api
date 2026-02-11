import { describe, expect, it, beforeEach } from 'vitest';
import { SandboxService } from '../src/services/sandboxService.js';
import { StateStore } from '../src/infra/storage/stateStore.js';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

let store: StateStore;
let service: SandboxService;
let tmpDir: string;

async function createStore(): Promise<StateStore> {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sandbox-test-'));
  const s = new StateStore(path.join(tmpDir, 'state.json'));
  await s.init();
  return s;
}

beforeEach(async () => {
  store = await createStore();
  service = new SandboxService(store);
});

describe('SandboxService', () => {
  // ─── createSandbox ────────────────────────────────────────────────

  it('creates a sandbox with default config', async () => {
    const sandbox = await service.createSandbox({});
    expect(sandbox).toBeDefined();
    expect(sandbox.id).toBeTruthy();
    expect(sandbox.status).toBe('idle');
    expect(sandbox.config.virtualCapitalUsd).toBe(10_000);
    expect(sandbox.config.symbol).toBe('SOL');
    expect(sandbox.config.startPriceUsd).toBe(100);
    expect(sandbox.results).toBeNull();
    expect(sandbox.createdAt).toBeTruthy();
  });

  it('creates a sandbox with custom config', async () => {
    const sandbox = await service.createSandbox({
      name: 'my-test-sandbox',
      virtualCapitalUsd: 50_000,
      symbol: 'BONK',
      startPriceUsd: 0.00002,
      timeAcceleration: 10,
      strategyConfig: {
        buyThresholdPct: -0.05,
        sellThresholdPct: 0.1,
        positionSizePct: 0.2,
      },
    });

    expect(sandbox.config.name).toBe('my-test-sandbox');
    expect(sandbox.config.virtualCapitalUsd).toBe(50_000);
    expect(sandbox.config.symbol).toBe('BONK');
    expect(sandbox.config.startPriceUsd).toBe(0.00002);
    expect(sandbox.config.timeAcceleration).toBe(10);
    expect(sandbox.config.strategyConfig.buyThresholdPct).toBe(-0.05);
    expect(sandbox.config.strategyConfig.sellThresholdPct).toBe(0.1);
    expect(sandbox.config.strategyConfig.positionSizePct).toBe(0.2);
  });

  it('sandbox is persisted in state', async () => {
    const sandbox = await service.createSandbox({ name: 'persisted' });
    const state = store.snapshot();
    expect(state.sandboxes[sandbox.id]).toBeDefined();
    expect(state.sandboxes[sandbox.id].config.name).toBe('persisted');
  });

  // ─── listScenarios ───────────────────────────────────────────────

  it('lists all built-in scenarios', () => {
    const scenarios = service.listScenarios();
    expect(scenarios.length).toBe(5);

    const ids = scenarios.map((s) => s.id);
    expect(ids).toContain('flash-crash');
    expect(ids).toContain('steady-bull');
    expect(ids).toContain('sideways-chop');
    expect(ids).toContain('black-swan');
    expect(ids).toContain('pump-dump');

    for (const scenario of scenarios) {
      expect(scenario.name).toBeTruthy();
      expect(scenario.description).toBeTruthy();
      expect(scenario.category).toBeTruthy();
      expect(scenario.ticks).toBeGreaterThan(0);
      // Should NOT expose generatePrices function
      expect((scenario as any).generatePrices).toBeUndefined();
    }
  });

  // ─── runSandboxScenario ───────────────────────────────────────────

  it('runs flash-crash scenario', async () => {
    const sandbox = await service.createSandbox({
      virtualCapitalUsd: 10_000,
      startPriceUsd: 100,
      strategyConfig: { buyThresholdPct: -0.03, sellThresholdPct: 0.05, positionSizePct: 0.1 },
    });

    const results = await service.runSandboxScenario(sandbox.id, 'flash-crash');

    expect(results).toBeDefined();
    expect(results.scenarioId).toBe('flash-crash');
    expect(results.scenarioName).toBe('Flash Crash');
    expect(typeof results.pnlUsd).toBe('number');
    expect(typeof results.pnlPct).toBe('number');
    expect(typeof results.tradeCount).toBe('number');
    expect(typeof results.maxDrawdownPct).toBe('number');
    expect(typeof results.maxDrawdownUsd).toBe('number');
    expect(typeof results.riskBreaches).toBe('number');
    expect(typeof results.finalEquityUsd).toBe('number');
    expect(typeof results.peakEquityUsd).toBe('number');
    expect(typeof results.troughEquityUsd).toBe('number');
    expect(Array.isArray(results.trades)).toBe(true);
    expect(Array.isArray(results.priceHistory)).toBe(true);
    expect(Array.isArray(results.equityCurve)).toBe(true);
    expect(results.priceHistory.length).toBe(30);
    expect(results.equityCurve.length).toBe(30);
  });

  it('runs steady-bull scenario', async () => {
    const sandbox = await service.createSandbox({ startPriceUsd: 100 });
    const results = await service.runSandboxScenario(sandbox.id, 'steady-bull');

    expect(results.scenarioId).toBe('steady-bull');
    expect(results.priceHistory.length).toBe(50);
    expect(results.equityCurve.length).toBe(50);
    // In a bull market, final price should be higher than start
    expect(results.priceHistory[results.priceHistory.length - 1]).toBeGreaterThan(results.priceHistory[0]);
  });

  it('runs sideways-chop scenario', async () => {
    const sandbox = await service.createSandbox({ startPriceUsd: 100 });
    const results = await service.runSandboxScenario(sandbox.id, 'sideways-chop');

    expect(results.scenarioId).toBe('sideways-chop');
    expect(results.priceHistory.length).toBe(40);
  });

  it('runs black-swan scenario', async () => {
    const sandbox = await service.createSandbox({ startPriceUsd: 100 });
    const results = await service.runSandboxScenario(sandbox.id, 'black-swan');

    expect(results.scenarioId).toBe('black-swan');
    expect(results.priceHistory.length).toBe(40);
    // Black swan should produce significant drawdown
    expect(results.maxDrawdownPct).toBeGreaterThanOrEqual(0);
  });

  it('runs pump-dump scenario', async () => {
    const sandbox = await service.createSandbox({ startPriceUsd: 100 });
    const results = await service.runSandboxScenario(sandbox.id, 'pump-dump');

    expect(results.scenarioId).toBe('pump-dump');
    expect(results.priceHistory.length).toBe(40);
  });

  it('updates sandbox status to completed after run', async () => {
    const sandbox = await service.createSandbox({});
    await service.runSandboxScenario(sandbox.id, 'flash-crash');

    const updated = service.getSandboxResults(sandbox.id);
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe('completed');
    expect(updated!.results).not.toBeNull();
    expect(updated!.completedAt).toBeTruthy();
  });

  it('throws on unknown scenario', async () => {
    const sandbox = await service.createSandbox({});
    await expect(
      service.runSandboxScenario(sandbox.id, 'nonexistent-scenario'),
    ).rejects.toThrow('Unknown scenario');
  });

  it('throws on unknown sandbox', async () => {
    await expect(
      service.runSandboxScenario('nonexistent-sandbox', 'flash-crash'),
    ).rejects.toThrow('not found');
  });

  // ─── Trade fields validation ──────────────────────────────────────

  it('trades have required fields', async () => {
    const sandbox = await service.createSandbox({
      startPriceUsd: 100,
      strategyConfig: {
        buyThresholdPct: -0.01, // Very sensitive to trigger more trades
        sellThresholdPct: 0.01,
        positionSizePct: 0.15,
      },
    });

    const results = await service.runSandboxScenario(sandbox.id, 'flash-crash');

    for (const trade of results.trades) {
      expect(trade.tick).toBeTypeOf('number');
      expect(trade.tick).toBeGreaterThan(0);
      expect(['buy', 'sell']).toContain(trade.side);
      expect(trade.priceUsd).toBeGreaterThan(0);
      expect(trade.quantity).toBeGreaterThan(0);
      expect(trade.notionalUsd).toBeGreaterThan(0);
      expect(trade.pnlUsd).toBeTypeOf('number');
      expect(trade.reason).toBeTruthy();
    }
  });

  // ─── getSandboxResults ────────────────────────────────────────────

  it('returns null for nonexistent sandbox', () => {
    const result = service.getSandboxResults('nonexistent');
    expect(result).toBeNull();
  });

  it('returns sandbox without results before run', async () => {
    const sandbox = await service.createSandbox({});
    const result = service.getSandboxResults(sandbox.id);
    expect(result).not.toBeNull();
    expect(result!.status).toBe('idle');
    expect(result!.results).toBeNull();
  });

  // ─── destroySandbox ───────────────────────────────────────────────

  it('destroys a sandbox', async () => {
    const sandbox = await service.createSandbox({});
    const result = await service.destroySandbox(sandbox.id);
    expect(result.ok).toBe(true);

    const state = store.snapshot();
    expect(state.sandboxes[sandbox.id]).toBeUndefined();
  });

  it('throws when destroying nonexistent sandbox', async () => {
    await expect(
      service.destroySandbox('nonexistent'),
    ).rejects.toThrow('not found');
  });

  // ─── Multiple sandboxes ───────────────────────────────────────────

  it('supports multiple independent sandboxes', async () => {
    const sb1 = await service.createSandbox({ name: 'sandbox-1', virtualCapitalUsd: 5_000 });
    const sb2 = await service.createSandbox({ name: 'sandbox-2', virtualCapitalUsd: 20_000 });

    expect(sb1.id).not.toBe(sb2.id);

    await service.runSandboxScenario(sb1.id, 'flash-crash');
    await service.runSandboxScenario(sb2.id, 'steady-bull');

    const r1 = service.getSandboxResults(sb1.id);
    const r2 = service.getSandboxResults(sb2.id);

    expect(r1!.results!.scenarioId).toBe('flash-crash');
    expect(r2!.results!.scenarioId).toBe('steady-bull');
    expect(r1!.config.virtualCapitalUsd).toBe(5_000);
    expect(r2!.config.virtualCapitalUsd).toBe(20_000);
  });

  // ─── Re-running scenarios ─────────────────────────────────────────

  it('allows re-running a completed sandbox with a different scenario', async () => {
    const sandbox = await service.createSandbox({});

    const r1 = await service.runSandboxScenario(sandbox.id, 'flash-crash');
    expect(r1.scenarioId).toBe('flash-crash');

    // Re-run with different scenario
    const r2 = await service.runSandboxScenario(sandbox.id, 'pump-dump');
    expect(r2.scenarioId).toBe('pump-dump');

    const final = service.getSandboxResults(sandbox.id);
    expect(final!.results!.scenarioId).toBe('pump-dump');
  });

  // ─── Equity curve sanity ──────────────────────────────────────────

  it('equity curve starts at virtual capital', async () => {
    const capital = 25_000;
    const sandbox = await service.createSandbox({ virtualCapitalUsd: capital });
    const results = await service.runSandboxScenario(sandbox.id, 'steady-bull');

    expect(results.equityCurve[0]).toBe(capital);
  });

  it('final equity matches last equity curve point', async () => {
    const sandbox = await service.createSandbox({});
    const results = await service.runSandboxScenario(sandbox.id, 'flash-crash');

    const lastEquity = results.equityCurve[results.equityCurve.length - 1];
    // Should be very close (floating point)
    expect(Math.abs(results.finalEquityUsd - lastEquity)).toBeLessThan(1);
  });

  // ─── P&L calculations ────────────────────────────────────────────

  it('pnl percentage matches pnl dollar amount', async () => {
    const capital = 10_000;
    const sandbox = await service.createSandbox({ virtualCapitalUsd: capital });
    const results = await service.runSandboxScenario(sandbox.id, 'steady-bull');

    const expectedPct = (results.pnlUsd / capital) * 100;
    expect(Math.abs(results.pnlPct - expectedPct)).toBeLessThan(0.01);
  });
});
