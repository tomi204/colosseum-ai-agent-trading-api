/**
 * AI Strategy Generator Service.
 *
 * Creates NEW strategies from learned patterns using:
 * - Strategy template system (define strategy skeletons with configurable parameters)
 * - Auto-generate strategies from market regime + performance data
 * - Strategy validation (backtest before deploying)
 * - Strategy versioning (track evolution of strategies over time)
 * - Strategy DNA (encode strategy parameters as a compact vector for comparison/mutation)
 * - Genetic algorithm for strategy evolution (crossover + mutation of top performers)
 */

import { v4 as uuid } from 'uuid';
import { StateStore } from '../infra/storage/stateStore.js';
import { isoNow } from '../utils/time.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export type MarketRegime = 'trending-up' | 'trending-down' | 'ranging' | 'volatile';

export interface TemplateParameter {
  name: string;
  description: string;
  min: number;
  max: number;
  defaultValue: number;
  step: number;
}

export interface StrategyTemplate {
  id: string;
  name: string;
  description: string;
  category: 'momentum' | 'mean-reversion' | 'breakout' | 'scalping' | 'trend-following';
  parameters: TemplateParameter[];
  /** Regimes this template is suited for */
  suitableRegimes: MarketRegime[];
  createdAt: string;
}

export interface GeneratedStrategy {
  id: string;
  templateId: string;
  name: string;
  description: string;
  parameters: Record<string, number>;
  dna: number[];
  version: number;
  parentId?: string;
  regime: MarketRegime;
  fitness: number;
  createdAt: string;
  metadata: Record<string, unknown>;
}

export interface StrategyVersion {
  version: number;
  parameters: Record<string, number>;
  dna: number[];
  fitness: number;
  createdAt: string;
  changelog: string;
}

export interface ValidationResult {
  strategyId: string;
  passed: boolean;
  totalReturnPct: number;
  maxDrawdownPct: number;
  sharpeRatio: number;
  tradeCount: number;
  winRate: number;
  score: number;
  warnings: string[];
  timestamp: string;
}

export interface EvolutionResult {
  generation: number;
  populationSize: number;
  bestFitness: number;
  avgFitness: number;
  survivors: GeneratedStrategy[];
  newOffspring: GeneratedStrategy[];
  timestamp: string;
}

export interface GenerateInput {
  regime: MarketRegime;
  templateId?: string;
  performanceHints?: {
    preferredWinRate?: number;
    maxDrawdown?: number;
    targetReturnPct?: number;
  };
  count?: number;
}

export interface ValidateInput {
  strategyId: string;
  priceHistory: number[];
  startingCapitalUsd: number;
}

export interface EvolveInput {
  strategyIds: string[];
  generations?: number;
  mutationRate?: number;
  crossoverRate?: number;
  eliteCount?: number;
  priceHistory: number[];
}

// ─── Built-in templates ────────────────────────────────────────────────────

const BUILT_IN_TEMPLATES: StrategyTemplate[] = [
  {
    id: 'tpl-momentum',
    name: 'Momentum Rider',
    description: 'Rides price momentum using moving average crossovers and RSI confirmation.',
    category: 'momentum',
    parameters: [
      { name: 'fastPeriod', description: 'Fast MA period', min: 3, max: 20, defaultValue: 7, step: 1 },
      { name: 'slowPeriod', description: 'Slow MA period', min: 10, max: 50, defaultValue: 21, step: 1 },
      { name: 'rsiThreshold', description: 'RSI buy threshold', min: 20, max: 45, defaultValue: 30, step: 1 },
      { name: 'stopLossPct', description: 'Stop loss percentage', min: 0.01, max: 0.15, defaultValue: 0.05, step: 0.01 },
      { name: 'takeProfitPct', description: 'Take profit percentage', min: 0.02, max: 0.30, defaultValue: 0.10, step: 0.01 },
    ],
    suitableRegimes: ['trending-up', 'trending-down'],
    createdAt: '2025-01-01T00:00:00Z',
  },
  {
    id: 'tpl-mean-reversion',
    name: 'Mean Reversion Snapper',
    description: 'Buys dips and sells rips based on Bollinger Band deviations.',
    category: 'mean-reversion',
    parameters: [
      { name: 'lookbackPeriod', description: 'Lookback window', min: 10, max: 50, defaultValue: 20, step: 1 },
      { name: 'deviationMultiplier', description: 'Std deviation multiplier', min: 1.0, max: 3.5, defaultValue: 2.0, step: 0.1 },
      { name: 'entryThreshold', description: 'Z-score entry threshold', min: 1.0, max: 3.0, defaultValue: 1.5, step: 0.1 },
      { name: 'exitThreshold', description: 'Z-score exit threshold', min: 0.0, max: 1.0, defaultValue: 0.3, step: 0.1 },
      { name: 'maxHoldBars', description: 'Max bars to hold position', min: 5, max: 100, defaultValue: 30, step: 1 },
    ],
    suitableRegimes: ['ranging'],
    createdAt: '2025-01-01T00:00:00Z',
  },
  {
    id: 'tpl-breakout',
    name: 'Breakout Blaster',
    description: 'Detects range breakouts using ATR and volume expansion.',
    category: 'breakout',
    parameters: [
      { name: 'atrPeriod', description: 'ATR calculation period', min: 5, max: 30, defaultValue: 14, step: 1 },
      { name: 'atrMultiplier', description: 'ATR breakout multiplier', min: 1.0, max: 4.0, defaultValue: 2.0, step: 0.1 },
      { name: 'consolidationBars', description: 'Min bars of consolidation', min: 5, max: 30, defaultValue: 10, step: 1 },
      { name: 'trailingStopAtr', description: 'Trailing stop in ATR units', min: 0.5, max: 3.0, defaultValue: 1.5, step: 0.1 },
      { name: 'volumeMultiplier', description: 'Volume expansion threshold', min: 1.2, max: 3.0, defaultValue: 1.8, step: 0.1 },
    ],
    suitableRegimes: ['volatile', 'ranging'],
    createdAt: '2025-01-01T00:00:00Z',
  },
  {
    id: 'tpl-scalping',
    name: 'Micro Scalper',
    description: 'High-frequency scalping using micro price movements and tight stops.',
    category: 'scalping',
    parameters: [
      { name: 'tickThreshold', description: 'Min tick movement to trigger', min: 0.001, max: 0.02, defaultValue: 0.005, step: 0.001 },
      { name: 'maxSpread', description: 'Max spread tolerance', min: 0.001, max: 0.01, defaultValue: 0.003, step: 0.001 },
      { name: 'targetTicks', description: 'Take profit in ticks', min: 2, max: 20, defaultValue: 5, step: 1 },
      { name: 'stopTicks', description: 'Stop loss in ticks', min: 1, max: 10, defaultValue: 3, step: 1 },
      { name: 'cooldownBars', description: 'Bars between trades', min: 1, max: 10, defaultValue: 2, step: 1 },
    ],
    suitableRegimes: ['ranging', 'volatile'],
    createdAt: '2025-01-01T00:00:00Z',
  },
  {
    id: 'tpl-trend-following',
    name: 'Trend Surfer',
    description: 'Long-term trend following using Donchian channels and ADX filter.',
    category: 'trend-following',
    parameters: [
      { name: 'channelPeriod', description: 'Donchian channel period', min: 10, max: 60, defaultValue: 20, step: 1 },
      { name: 'adxThreshold', description: 'ADX min trend strength', min: 15, max: 40, defaultValue: 25, step: 1 },
      { name: 'riskPerTrade', description: 'Risk per trade (fraction)', min: 0.005, max: 0.05, defaultValue: 0.02, step: 0.005 },
      { name: 'pyramidLevels', description: 'Max pyramid entries', min: 1, max: 5, defaultValue: 2, step: 1 },
      { name: 'exitChannelPeriod', description: 'Exit channel period', min: 5, max: 30, defaultValue: 10, step: 1 },
    ],
    suitableRegimes: ['trending-up', 'trending-down'],
    createdAt: '2025-01-01T00:00:00Z',
  },
];

// ─── Service ────────────────────────────────────────────────────────────────

export class StrategyGeneratorService {
  private strategies = new Map<string, GeneratedStrategy>();
  private versions = new Map<string, StrategyVersion[]>();
  private templates: StrategyTemplate[] = [...BUILT_IN_TEMPLATES];

  constructor(private readonly stateStore: StateStore) {}

  // ── Templates ─────────────────────────────────────────────────────────

  listTemplates(): StrategyTemplate[] {
    return [...this.templates];
  }

  getTemplate(templateId: string): StrategyTemplate | undefined {
    return this.templates.find((t) => t.id === templateId);
  }

  // ── Generation ────────────────────────────────────────────────────────

  generate(input: GenerateInput): GeneratedStrategy[] {
    const count = input.count ?? 1;
    const results: GeneratedStrategy[] = [];

    for (let i = 0; i < count; i++) {
      const template = input.templateId
        ? this.getTemplate(input.templateId)
        : this.pickTemplateForRegime(input.regime);

      if (!template) {
        throw new Error(`No template found for regime '${input.regime}'`);
      }

      const params = this.generateParameters(template, input);
      const dna = this.encodeDna(template, params);
      const fitness = this.estimateInitialFitness(params, input);

      const strategy: GeneratedStrategy = {
        id: `gen-${uuid().slice(0, 8)}`,
        templateId: template.id,
        name: `${template.name} #${Date.now().toString(36).slice(-4)}`,
        description: `Auto-generated ${template.category} strategy for ${input.regime} regime`,
        parameters: params,
        dna,
        version: 1,
        regime: input.regime,
        fitness,
        createdAt: isoNow(),
        metadata: {
          generationMethod: 'auto',
          performanceHints: input.performanceHints ?? {},
        },
      };

      this.strategies.set(strategy.id, strategy);
      this.versions.set(strategy.id, [
        {
          version: 1,
          parameters: { ...params },
          dna: [...dna],
          fitness,
          createdAt: strategy.createdAt,
          changelog: 'Initial generation',
        },
      ]);

      results.push(strategy);
    }

    return results;
  }

  // ── Validation / Backtest ─────────────────────────────────────────────

  validate(input: ValidateInput): ValidationResult {
    const strategy = this.strategies.get(input.strategyId);
    if (!strategy) {
      throw new Error(`Strategy '${input.strategyId}' not found`);
    }

    const template = this.getTemplate(strategy.templateId);
    if (!template) {
      throw new Error(`Template '${strategy.templateId}' not found`);
    }

    const result = this.runSimulatedBacktest(strategy, input.priceHistory, input.startingCapitalUsd);
    return result;
  }

  // ── Versioning ────────────────────────────────────────────────────────

  getVersions(strategyId: string): StrategyVersion[] {
    const versions = this.versions.get(strategyId);
    if (!versions) {
      throw new Error(`Strategy '${strategyId}' not found`);
    }
    return [...versions];
  }

  getStrategy(strategyId: string): GeneratedStrategy | undefined {
    return this.strategies.get(strategyId);
  }

  // ── DNA ───────────────────────────────────────────────────────────────

  getDna(strategyId: string): { strategyId: string; dna: number[]; dimension: number; templateId: string } {
    const strategy = this.strategies.get(strategyId);
    if (!strategy) {
      throw new Error(`Strategy '${strategyId}' not found`);
    }
    return {
      strategyId: strategy.id,
      dna: [...strategy.dna],
      dimension: strategy.dna.length,
      templateId: strategy.templateId,
    };
  }

  encodeDna(template: StrategyTemplate, params: Record<string, number>): number[] {
    return template.parameters.map((p) => {
      const range = p.max - p.min;
      if (range === 0) return 0.5;
      return (params[p.name] - p.min) / range;
    });
  }

  decodeDna(template: StrategyTemplate, dna: number[]): Record<string, number> {
    const params: Record<string, number> = {};
    template.parameters.forEach((p, i) => {
      const raw = p.min + dna[i] * (p.max - p.min);
      // Snap to step
      params[p.name] = Math.round(raw / p.step) * p.step;
      // Clamp
      params[p.name] = Math.max(p.min, Math.min(p.max, params[p.name]));
    });
    return params;
  }

  dnaDistance(dna1: number[], dna2: number[]): number {
    if (dna1.length !== dna2.length) return Infinity;
    let sum = 0;
    for (let i = 0; i < dna1.length; i++) {
      sum += (dna1[i] - dna2[i]) ** 2;
    }
    return Math.sqrt(sum);
  }

  // ── Genetic Algorithm ─────────────────────────────────────────────────

  evolve(input: EvolveInput): EvolutionResult {
    const generations = input.generations ?? 1;
    const mutationRate = input.mutationRate ?? 0.1;
    const crossoverRate = input.crossoverRate ?? 0.7;
    const eliteCount = input.eliteCount ?? 2;

    // Load population
    const population: GeneratedStrategy[] = [];
    for (const id of input.strategyIds) {
      const s = this.strategies.get(id);
      if (s) population.push(s);
    }

    if (population.length < 2) {
      throw new Error('Need at least 2 strategies to evolve');
    }

    // They must all share the same template
    const templateId = population[0].templateId;
    const template = this.getTemplate(templateId);
    if (!template) {
      throw new Error(`Template '${templateId}' not found`);
    }

    for (const s of population) {
      if (s.templateId !== templateId) {
        throw new Error('All strategies must share the same template for evolution');
      }
    }

    let currentPop = [...population];
    let bestFitness = 0;
    let avgFitness = 0;

    for (let gen = 0; gen < generations; gen++) {
      // Evaluate fitness via backtest
      for (const s of currentPop) {
        const result = this.runSimulatedBacktest(s, input.priceHistory, 10000);
        s.fitness = result.score;
      }

      // Sort by fitness (descending)
      currentPop.sort((a, b) => b.fitness - a.fitness);

      // Elite selection
      const elites = currentPop.slice(0, Math.min(eliteCount, currentPop.length));

      // Create offspring
      const offspring: GeneratedStrategy[] = [];
      const targetPop = currentPop.length;

      while (offspring.length + elites.length < targetPop) {
        const parent1 = this.tournamentSelect(currentPop);
        const parent2 = this.tournamentSelect(currentPop);

        let childDna: number[];
        if (Math.random() < crossoverRate) {
          childDna = this.crossover(parent1.dna, parent2.dna);
        } else {
          childDna = [...parent1.dna];
        }

        childDna = this.mutate(childDna, mutationRate);
        // Clamp to [0, 1]
        childDna = childDna.map((v) => Math.max(0, Math.min(1, v)));

        const childParams = this.decodeDna(template, childDna);
        const childId = `gen-${uuid().slice(0, 8)}`;
        const child: GeneratedStrategy = {
          id: childId,
          templateId,
          name: `${template.name} Evo #${Date.now().toString(36).slice(-4)}`,
          description: `Evolved from ${parent1.id} × ${parent2.id}`,
          parameters: childParams,
          dna: childDna,
          version: 1,
          parentId: parent1.id,
          regime: parent1.regime,
          fitness: 0,
          createdAt: isoNow(),
          metadata: {
            generationMethod: 'evolution',
            parentIds: [parent1.id, parent2.id],
            generation: gen + 1,
            mutationRate,
            crossoverRate,
          },
        };

        // Evaluate child
        const childResult = this.runSimulatedBacktest(child, input.priceHistory, 10000);
        child.fitness = childResult.score;

        this.strategies.set(child.id, child);
        this.versions.set(child.id, [
          {
            version: 1,
            parameters: { ...childParams },
            dna: [...childDna],
            fitness: child.fitness,
            createdAt: child.createdAt,
            changelog: `Evolved (gen ${gen + 1}) from ${parent1.id} × ${parent2.id}`,
          },
        ]);

        offspring.push(child);
      }

      currentPop = [...elites, ...offspring];

      bestFitness = currentPop.reduce((max, s) => Math.max(max, s.fitness), 0);
      avgFitness = currentPop.reduce((sum, s) => sum + s.fitness, 0) / currentPop.length;
    }

    // Update elites in store with incremented version
    const survivors = currentPop.slice(0, Math.min(eliteCount, currentPop.length));
    for (const s of survivors) {
      const existing = this.strategies.get(s.id);
      if (existing && existing.version > 0) {
        existing.version++;
        const versionHistory = this.versions.get(s.id) ?? [];
        versionHistory.push({
          version: existing.version,
          parameters: { ...existing.parameters },
          dna: [...existing.dna],
          fitness: existing.fitness,
          createdAt: isoNow(),
          changelog: 'Survived evolution round',
        });
        this.versions.set(s.id, versionHistory);
      }
    }

    const newOffspring = currentPop.slice(Math.min(eliteCount, currentPop.length));

    return {
      generation: generations,
      populationSize: currentPop.length,
      bestFitness,
      avgFitness,
      survivors,
      newOffspring,
      timestamp: isoNow(),
    };
  }

  // ── Private helpers ───────────────────────────────────────────────────

  private pickTemplateForRegime(regime: MarketRegime): StrategyTemplate | undefined {
    const suitable = this.templates.filter((t) => t.suitableRegimes.includes(regime));
    if (suitable.length === 0) return this.templates[0];
    return suitable[Math.floor(Math.random() * suitable.length)];
  }

  private generateParameters(template: StrategyTemplate, input: GenerateInput): Record<string, number> {
    const params: Record<string, number> = {};
    const hints = input.performanceHints;

    for (const p of template.parameters) {
      let value: number;

      if (hints?.maxDrawdown && p.name.toLowerCase().includes('stop')) {
        // Bias stop loss toward tighter if user wants low drawdown
        value = p.min + (p.max - p.min) * (hints.maxDrawdown / 100);
        value = Math.max(p.min, Math.min(p.max, value));
      } else if (hints?.targetReturnPct && p.name.toLowerCase().includes('profit')) {
        // Bias take profit toward target
        value = p.min + (p.max - p.min) * Math.min(1, hints.targetReturnPct / 50);
        value = Math.max(p.min, Math.min(p.max, value));
      } else {
        // Random within range, biased toward center
        const center = (p.min + p.max) / 2;
        const spread = (p.max - p.min) / 2;
        // Use pseudo-gaussian (average of 2 randoms)
        const r = (Math.random() + Math.random()) / 2;
        value = center + spread * (r - 0.5);
      }

      // Snap to step
      value = Math.round(value / p.step) * p.step;
      value = Math.max(p.min, Math.min(p.max, value));
      params[p.name] = value;
    }

    return params;
  }

  private estimateInitialFitness(params: Record<string, number>, input: GenerateInput): number {
    // Heuristic initial fitness based on parameter quality
    let score = 50; // baseline

    const hints = input.performanceHints;
    if (hints?.preferredWinRate) {
      score += hints.preferredWinRate > 0.5 ? 10 : -5;
    }

    // Penalize extreme parameters
    const values = Object.values(params);
    const variance = this.variance(values);
    if (variance > 1000) score -= 10;

    return Math.max(0, Math.min(100, score));
  }

  private runSimulatedBacktest(
    strategy: GeneratedStrategy,
    priceHistory: number[],
    startingCapital: number,
  ): ValidationResult {
    const template = this.getTemplate(strategy.templateId);
    if (!template || priceHistory.length < 5) {
      return {
        strategyId: strategy.id,
        passed: false,
        totalReturnPct: 0,
        maxDrawdownPct: 0,
        sharpeRatio: 0,
        tradeCount: 0,
        winRate: 0,
        score: 0,
        warnings: ['Insufficient data or missing template'],
        timestamp: isoNow(),
      };
    }

    // Simple simulation using strategy parameters
    let cash = startingCapital;
    let position = 0;
    let entryPrice = 0;
    let trades = 0;
    let wins = 0;
    let peakEquity = startingCapital;
    let maxDrawdown = 0;
    const returns: number[] = [];
    const warnings: string[] = [];

    // Use parameters to define simple trading rules
    const params = strategy.parameters;
    const lookback = Math.floor(params[template.parameters[0]?.name] ?? 10);
    const threshold = params[template.parameters[2]?.name] ?? 1.5;

    for (let i = lookback; i < priceHistory.length; i++) {
      const window = priceHistory.slice(i - lookback, i);
      const mean = window.reduce((s, v) => s + v, 0) / window.length;
      const currentPrice = priceHistory[i];
      const deviation = (currentPrice - mean) / (mean || 1);

      const equity = cash + position * currentPrice;

      if (equity > peakEquity) peakEquity = equity;
      const dd = (peakEquity - equity) / peakEquity;
      if (dd > maxDrawdown) maxDrawdown = dd;

      if (position === 0 && deviation < -threshold * 0.01) {
        // Buy signal
        const qty = (cash * 0.1) / currentPrice;
        if (qty > 0 && cash >= qty * currentPrice) {
          position = qty;
          entryPrice = currentPrice;
          cash -= qty * currentPrice;
        }
      } else if (position > 0) {
        const pnlPct = (currentPrice - entryPrice) / entryPrice;
        const stopLoss = params['stopLossPct'] ?? params['stopTicks'] ?? 0.05;
        const takeProfit = params['takeProfitPct'] ?? params['targetTicks'] ?? 0.10;

        if (pnlPct <= -stopLoss || pnlPct >= takeProfit || deviation > threshold * 0.01) {
          cash += position * currentPrice;
          const tradePnl = (currentPrice - entryPrice) * position;
          returns.push(tradePnl / startingCapital);
          trades++;
          if (tradePnl > 0) wins++;
          position = 0;
          entryPrice = 0;
        }
      }
    }

    // Close any remaining position
    if (position > 0 && priceHistory.length > 0) {
      const lastPrice = priceHistory[priceHistory.length - 1];
      cash += position * lastPrice;
      const tradePnl = (lastPrice - entryPrice) * position;
      returns.push(tradePnl / startingCapital);
      trades++;
      if (tradePnl > 0) wins++;
      position = 0;
    }

    const finalEquity = cash;
    const totalReturnPct = ((finalEquity - startingCapital) / startingCapital) * 100;
    const winRate = trades > 0 ? wins / trades : 0;

    // Sharpe ratio approximation
    const avgReturn = returns.length > 0 ? returns.reduce((s, v) => s + v, 0) / returns.length : 0;
    const stdReturn = returns.length > 1 ? Math.sqrt(this.variance(returns)) : 1;
    const sharpeRatio = stdReturn > 0 ? (avgReturn / stdReturn) * Math.sqrt(252) : 0;

    // Composite score (0-100)
    let score = 50;
    score += Math.min(20, totalReturnPct * 2);
    score += winRate * 20;
    score += Math.min(10, sharpeRatio * 5);
    score -= maxDrawdown * 50;
    score = Math.max(0, Math.min(100, score));

    if (maxDrawdown > 0.3) warnings.push('High drawdown detected (>30%)');
    if (trades < 3) warnings.push('Low trade count — insufficient signal generation');
    if (winRate < 0.3) warnings.push('Low win rate (<30%)');

    const passed = totalReturnPct > 0 && maxDrawdown < 0.5 && trades >= 1;

    return {
      strategyId: strategy.id,
      passed,
      totalReturnPct: Math.round(totalReturnPct * 100) / 100,
      maxDrawdownPct: Math.round(maxDrawdown * 10000) / 100,
      sharpeRatio: Math.round(sharpeRatio * 100) / 100,
      tradeCount: trades,
      winRate: Math.round(winRate * 100) / 100,
      score: Math.round(score * 100) / 100,
      warnings,
      timestamp: isoNow(),
    };
  }

  private tournamentSelect(population: GeneratedStrategy[]): GeneratedStrategy {
    const tournamentSize = Math.min(3, population.length);
    let best: GeneratedStrategy = population[Math.floor(Math.random() * population.length)];
    for (let i = 1; i < tournamentSize; i++) {
      const candidate = population[Math.floor(Math.random() * population.length)];
      if (candidate.fitness > best.fitness) {
        best = candidate;
      }
    }
    return best;
  }

  private crossover(dna1: number[], dna2: number[]): number[] {
    const point = Math.floor(Math.random() * dna1.length);
    return [...dna1.slice(0, point), ...dna2.slice(point)];
  }

  private mutate(dna: number[], rate: number): number[] {
    return dna.map((gene) => {
      if (Math.random() < rate) {
        // Gaussian-like mutation
        const mutation = (Math.random() - 0.5) * 0.3;
        return gene + mutation;
      }
      return gene;
    });
  }

  private variance(values: number[]): number {
    if (values.length < 2) return 0;
    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    return values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1);
  }
}
