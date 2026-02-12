import { describe, it, expect, beforeEach } from 'vitest';
import { StrategyGeneratorService, GenerateInput, MarketRegime, StrategyTemplate } from '../src/services/strategyGeneratorService.js';
import { StateStore } from '../src/infra/storage/stateStore.js';
import { createTempDir, buildTestConfig } from './helpers.js';

describe('StrategyGeneratorService', () => {
  let service: StrategyGeneratorService;
  let store: StateStore;

  beforeEach(async () => {
    const tmp = await createTempDir();
    const config = buildTestConfig(tmp);
    store = new StateStore(config.paths.stateFile);
    await store.init();
    service = new StrategyGeneratorService(store);
  });

  // ── Template tests ──────────────────────────────────────────────────

  it('lists built-in templates', () => {
    const templates = service.listTemplates();
    expect(templates.length).toBeGreaterThanOrEqual(5);
    expect(templates.map((t) => t.id)).toContain('tpl-momentum');
    expect(templates.map((t) => t.id)).toContain('tpl-mean-reversion');
    expect(templates.map((t) => t.id)).toContain('tpl-breakout');
    expect(templates.map((t) => t.id)).toContain('tpl-scalping');
    expect(templates.map((t) => t.id)).toContain('tpl-trend-following');
  });

  it('gets a specific template by id', () => {
    const template = service.getTemplate('tpl-momentum');
    expect(template).toBeDefined();
    expect(template!.name).toBe('Momentum Rider');
    expect(template!.parameters.length).toBeGreaterThanOrEqual(3);
    expect(template!.suitableRegimes).toContain('trending-up');
  });

  it('returns undefined for unknown template', () => {
    expect(service.getTemplate('tpl-nonexistent')).toBeUndefined();
  });

  // ── Generation tests ────────────────────────────────────────────────

  it('generates a single strategy for a given regime', () => {
    const strategies = service.generate({ regime: 'trending-up' });
    expect(strategies).toHaveLength(1);
    const s = strategies[0];
    expect(s.id).toMatch(/^gen-/);
    expect(s.regime).toBe('trending-up');
    expect(s.version).toBe(1);
    expect(s.dna.length).toBeGreaterThan(0);
    expect(Object.keys(s.parameters).length).toBeGreaterThan(0);
  });

  it('generates multiple strategies with count parameter', () => {
    const strategies = service.generate({ regime: 'ranging', count: 4 });
    expect(strategies).toHaveLength(4);
    const ids = strategies.map((s) => s.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(4); // all unique
  });

  it('generates strategy with specific template', () => {
    const strategies = service.generate({
      regime: 'volatile',
      templateId: 'tpl-breakout',
    });
    expect(strategies).toHaveLength(1);
    expect(strategies[0].templateId).toBe('tpl-breakout');
  });

  it('uses performance hints to influence parameters', () => {
    const strategies = service.generate({
      regime: 'trending-up',
      templateId: 'tpl-momentum',
      performanceHints: {
        maxDrawdown: 5,
        targetReturnPct: 20,
      },
    });
    expect(strategies).toHaveLength(1);
    expect(strategies[0].metadata.performanceHints).toEqual({
      maxDrawdown: 5,
      targetReturnPct: 20,
    });
  });

  // ── DNA tests ───────────────────────────────────────────────────────

  it('encodes and decodes DNA correctly (round-trip)', () => {
    const template = service.getTemplate('tpl-momentum')!;
    const params: Record<string, number> = {
      fastPeriod: 10,
      slowPeriod: 30,
      rsiThreshold: 35,
      stopLossPct: 0.07,
      takeProfitPct: 0.15,
    };
    const dna = service.encodeDna(template, params);
    expect(dna.length).toBe(template.parameters.length);
    // All values should be normalized between 0 and 1
    for (const v of dna) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }

    const decoded = service.decodeDna(template, dna);
    // Decoded should be close to original (within step tolerance)
    for (const p of template.parameters) {
      expect(decoded[p.name]).toBeCloseTo(params[p.name], 0);
    }
  });

  it('retrieves DNA for a generated strategy', () => {
    const [strategy] = service.generate({ regime: 'ranging' });
    const dnaResult = service.getDna(strategy.id);
    expect(dnaResult.strategyId).toBe(strategy.id);
    expect(dnaResult.dna).toEqual(strategy.dna);
    expect(dnaResult.dimension).toBe(strategy.dna.length);
    expect(dnaResult.templateId).toBe(strategy.templateId);
  });

  it('computes DNA distance between strategies', () => {
    const dna1 = [0.1, 0.5, 0.8, 0.3, 0.6];
    const dna2 = [0.1, 0.5, 0.8, 0.3, 0.6];
    expect(service.dnaDistance(dna1, dna2)).toBe(0);

    const dna3 = [0.9, 0.5, 0.8, 0.3, 0.6];
    const dist = service.dnaDistance(dna1, dna3);
    expect(dist).toBeGreaterThan(0);
    expect(dist).toBeCloseTo(0.8, 1);
  });

  it('returns Infinity for DNA of different dimensions', () => {
    expect(service.dnaDistance([0.1, 0.2], [0.1, 0.2, 0.3])).toBe(Infinity);
  });

  // ── Validation tests ────────────────────────────────────────────────

  it('validates a generated strategy with price history', () => {
    const [strategy] = service.generate({ regime: 'trending-up', templateId: 'tpl-momentum' });
    // Generate a simple trending price history
    const prices: number[] = [];
    let price = 100;
    for (let i = 0; i < 100; i++) {
      price += (Math.random() - 0.3) * 2; // slight uptrend
      prices.push(Math.max(10, price));
    }

    const result = service.validate({
      strategyId: strategy.id,
      priceHistory: prices,
      startingCapitalUsd: 10000,
    });

    expect(result.strategyId).toBe(strategy.id);
    expect(typeof result.passed).toBe('boolean');
    expect(typeof result.totalReturnPct).toBe('number');
    expect(typeof result.maxDrawdownPct).toBe('number');
    expect(typeof result.sharpeRatio).toBe('number');
    expect(typeof result.tradeCount).toBe('number');
    expect(typeof result.winRate).toBe('number');
    expect(typeof result.score).toBe('number');
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
    expect(result.timestamp).toBeTruthy();
  });

  it('throws for validation with unknown strategy', () => {
    expect(() =>
      service.validate({
        strategyId: 'nonexistent',
        priceHistory: [100, 101, 102],
        startingCapitalUsd: 10000,
      }),
    ).toThrow("Strategy 'nonexistent' not found");
  });

  // ── Versioning tests ────────────────────────────────────────────────

  it('tracks version history for generated strategies', () => {
    const [strategy] = service.generate({ regime: 'ranging' });
    const versions = service.getVersions(strategy.id);
    expect(versions).toHaveLength(1);
    expect(versions[0].version).toBe(1);
    expect(versions[0].changelog).toBe('Initial generation');
    expect(versions[0].dna).toEqual(strategy.dna);
  });

  it('throws for version history of unknown strategy', () => {
    expect(() => service.getVersions('nonexistent')).toThrow("Strategy 'nonexistent' not found");
  });

  // ── Evolution / Genetic Algorithm tests ─────────────────────────────

  it('evolves a population of strategies', () => {
    // Generate a population of same-template strategies
    const strategies = service.generate({
      regime: 'trending-up',
      templateId: 'tpl-momentum',
      count: 5,
    });

    // Create a trending price history for backtest
    const prices: number[] = [];
    let p = 100;
    for (let i = 0; i < 100; i++) {
      p += (Math.random() - 0.3) * 2;
      prices.push(Math.max(10, p));
    }

    const result = service.evolve({
      strategyIds: strategies.map((s) => s.id),
      generations: 2,
      mutationRate: 0.15,
      crossoverRate: 0.7,
      eliteCount: 2,
      priceHistory: prices,
    });

    expect(result.generation).toBe(2);
    expect(result.populationSize).toBe(5);
    expect(result.survivors.length).toBeGreaterThan(0);
    expect(result.newOffspring.length).toBeGreaterThan(0);
    expect(typeof result.bestFitness).toBe('number');
    expect(typeof result.avgFitness).toBe('number');
    expect(result.timestamp).toBeTruthy();
  });

  it('throws if evolving fewer than 2 strategies', () => {
    const [s] = service.generate({ regime: 'trending-up', templateId: 'tpl-momentum' });
    expect(() =>
      service.evolve({
        strategyIds: [s.id],
        priceHistory: [100, 101, 102, 103, 104, 105, 106, 107, 108, 109],
      }),
    ).toThrow('Need at least 2 strategies to evolve');
  });

  it('throws if evolving strategies from different templates', () => {
    const [s1] = service.generate({ regime: 'trending-up', templateId: 'tpl-momentum' });
    const [s2] = service.generate({ regime: 'ranging', templateId: 'tpl-mean-reversion' });
    expect(() =>
      service.evolve({
        strategyIds: [s1.id, s2.id],
        priceHistory: [100, 101, 102, 103, 104],
      }),
    ).toThrow('All strategies must share the same template for evolution');
  });

  it('evolved strategies have unique IDs and proper metadata', () => {
    const strategies = service.generate({
      regime: 'volatile',
      templateId: 'tpl-breakout',
      count: 4,
    });

    const prices: number[] = [];
    let p = 100;
    for (let i = 0; i < 80; i++) {
      p += (Math.random() - 0.5) * 5; // volatile
      prices.push(Math.max(10, p));
    }

    const result = service.evolve({
      strategyIds: strategies.map((s) => s.id),
      priceHistory: prices,
      generations: 1,
    });

    const allIds = [...result.survivors, ...result.newOffspring].map((s) => s.id);
    expect(new Set(allIds).size).toBe(allIds.length); // all unique

    for (const offspring of result.newOffspring) {
      expect(offspring.metadata.generationMethod).toBe('evolution');
      expect(offspring.metadata.parentIds).toBeDefined();
    }
  });
});
