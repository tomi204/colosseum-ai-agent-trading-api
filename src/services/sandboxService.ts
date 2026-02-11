/**
 * Agent Simulation Sandbox Service.
 *
 * Creates isolated sandbox environments where agents can test strategies
 * against predefined market scenarios (flash crash, bull run, black swan, etc.)
 * without risking real or paper capital.
 */

import { v4 as uuid } from 'uuid';
import { z } from 'zod';
import { DomainError, ErrorCode } from '../errors/taxonomy.js';
import { eventBus } from '../infra/eventBus.js';
import { StateStore } from '../infra/storage/stateStore.js';
import { isoNow } from '../utils/time.js';

// ─── Schemas ────────────────────────────────────────────────────────────

export const createSandboxSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  virtualCapitalUsd: z.number().positive().default(10_000),
  symbol: z.string().min(1).max(20).default('SOL'),
  startPriceUsd: z.number().positive().default(100),
  timeAcceleration: z.number().positive().max(1000).default(1),
  strategyConfig: z.object({
    buyThresholdPct: z.number().min(-1).max(1).optional(),
    sellThresholdPct: z.number().min(-1).max(1).optional(),
    positionSizePct: z.number().min(0).max(1).optional(),
  }).optional(),
});

export const runSandboxSchema = z.object({
  scenarioId: z.string().min(1),
});

// ─── Types ──────────────────────────────────────────────────────────────

export type SandboxStatus = 'idle' | 'running' | 'completed' | 'failed';

export interface SandboxConfig {
  name: string;
  virtualCapitalUsd: number;
  symbol: string;
  startPriceUsd: number;
  timeAcceleration: number;
  strategyConfig: {
    buyThresholdPct: number;
    sellThresholdPct: number;
    positionSizePct: number;
  };
}

export interface SandboxTrade {
  tick: number;
  side: 'buy' | 'sell';
  priceUsd: number;
  quantity: number;
  notionalUsd: number;
  pnlUsd: number;
  reason: string;
}

export interface SandboxResults {
  scenarioId: string;
  scenarioName: string;
  pnlUsd: number;
  pnlPct: number;
  tradeCount: number;
  maxDrawdownPct: number;
  maxDrawdownUsd: number;
  recoveryTicks: number | null;
  riskBreaches: number;
  finalEquityUsd: number;
  peakEquityUsd: number;
  troughEquityUsd: number;
  trades: SandboxTrade[];
  priceHistory: number[];
  equityCurve: number[];
}

export interface Sandbox {
  id: string;
  config: SandboxConfig;
  status: SandboxStatus;
  results: SandboxResults | null;
  createdAt: string;
  completedAt: string | null;
  error: string | null;
}

export interface ScenarioDefinition {
  id: string;
  name: string;
  description: string;
  category: 'crash' | 'bull' | 'sideways' | 'extreme' | 'manipulation';
  ticks: number;
  generatePrices: (startPrice: number) => number[];
}

// ─── Built-in Scenarios ─────────────────────────────────────────────────

function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    return (s >>> 0) / 0xffffffff;
  };
}

const SCENARIOS: ScenarioDefinition[] = [
  {
    id: 'flash-crash',
    name: 'Flash Crash',
    description: 'Price drops 30% in 10 ticks then recovers 20%. Tests panic selling prevention and recovery detection.',
    category: 'crash',
    ticks: 30,
    generatePrices: (start) => {
      const prices: number[] = [start];
      // Drop 30% over 10 ticks
      for (let i = 1; i <= 10; i++) {
        const dropPerTick = 0.3 / 10;
        prices.push(prices[i - 1] * (1 - dropPerTick));
      }
      // Recover 20% over remaining ticks
      const bottom = prices[10];
      for (let i = 11; i < 30; i++) {
        const recoverPerTick = 0.2 / 19;
        prices.push(prices[i - 1] * (1 + recoverPerTick));
      }
      return prices;
    },
  },
  {
    id: 'steady-bull',
    name: 'Steady Bull',
    description: 'Linear 15% increase over 50 ticks. Tests trend-following and position scaling.',
    category: 'bull',
    ticks: 50,
    generatePrices: (start) => {
      const prices: number[] = [start];
      const stepPct = 0.15 / 49;
      for (let i = 1; i < 50; i++) {
        prices.push(prices[i - 1] * (1 + stepPct));
      }
      return prices;
    },
  },
  {
    id: 'sideways-chop',
    name: 'Sideways Chop',
    description: 'Random ±2% oscillation for 40 ticks. Tests overtrading prevention and fee awareness.',
    category: 'sideways',
    ticks: 40,
    generatePrices: (start) => {
      const rand = seededRandom(42);
      const prices: number[] = [start];
      for (let i = 1; i < 40; i++) {
        const change = (rand() * 0.04) - 0.02; // ±2%
        prices.push(prices[i - 1] * (1 + change));
      }
      return prices;
    },
  },
  {
    id: 'black-swan',
    name: 'Black Swan',
    description: '50% drop, brief 5% recovery, then another 20% drop. Tests multi-leg crash resilience.',
    category: 'extreme',
    ticks: 40,
    generatePrices: (start) => {
      const prices: number[] = [start];
      // Phase 1: 50% drop over 10 ticks
      for (let i = 1; i <= 10; i++) {
        const dropPerTick = 0.5 / 10;
        prices.push(prices[i - 1] * (1 - dropPerTick));
      }
      // Phase 2: 5% recovery over 10 ticks
      for (let i = 11; i <= 20; i++) {
        const recoverPerTick = 0.05 / 10;
        prices.push(prices[i - 1] * (1 + recoverPerTick));
      }
      // Phase 3: 20% drop over 10 ticks
      for (let i = 21; i <= 30; i++) {
        const dropPerTick = 0.2 / 10;
        prices.push(prices[i - 1] * (1 - dropPerTick));
      }
      // Phase 4: stabilize
      for (let i = 31; i < 40; i++) {
        prices.push(prices[i - 1] * 1.001);
      }
      return prices;
    },
  },
  {
    id: 'pump-dump',
    name: 'Pump & Dump',
    description: '40% spike followed by 45% crash. Tests FOMO resistance and exit timing.',
    category: 'manipulation',
    ticks: 40,
    generatePrices: (start) => {
      const prices: number[] = [start];
      // Pump: 40% spike over 15 ticks
      for (let i = 1; i <= 15; i++) {
        const pumpPerTick = 0.4 / 15;
        prices.push(prices[i - 1] * (1 + pumpPerTick));
      }
      // Dump: 45% crash over 15 ticks
      for (let i = 16; i <= 30; i++) {
        const dumpPerTick = 0.45 / 15;
        prices.push(prices[i - 1] * (1 - dumpPerTick));
      }
      // Flat aftermath
      for (let i = 31; i < 40; i++) {
        prices.push(prices[i - 1] * 0.999);
      }
      return prices;
    },
  },
];

const SCENARIO_MAP = new Map(SCENARIOS.map((s) => [s.id, s]));

// ─── Service ────────────────────────────────────────────────────────────

export class SandboxService {
  constructor(private readonly store: StateStore) {}

  /**
   * Create a new sandbox environment.
   */
  async createSandbox(input: z.infer<typeof createSandboxSchema>): Promise<Sandbox> {
    const config: SandboxConfig = {
      name: input.name ?? `sandbox-${Date.now()}`,
      virtualCapitalUsd: input.virtualCapitalUsd ?? 10_000,
      symbol: (input.symbol ?? 'SOL').toUpperCase(),
      startPriceUsd: input.startPriceUsd ?? 100,
      timeAcceleration: input.timeAcceleration ?? 1,
      strategyConfig: {
        buyThresholdPct: input.strategyConfig?.buyThresholdPct ?? -0.03,
        sellThresholdPct: input.strategyConfig?.sellThresholdPct ?? 0.05,
        positionSizePct: input.strategyConfig?.positionSizePct ?? 0.1,
      },
    };

    const sandbox: Sandbox = {
      id: uuid(),
      config,
      status: 'idle',
      results: null,
      createdAt: isoNow(),
      completedAt: null,
      error: null,
    };

    await this.store.transaction((state) => {
      state.sandboxes[sandbox.id] = sandbox;
    });

    eventBus.emit('sandbox.created', {
      sandboxId: sandbox.id,
      name: config.name,
    });

    return structuredClone(sandbox);
  }

  /**
   * Run a predefined market scenario against the sandbox's strategy config.
   */
  async runSandboxScenario(sandboxId: string, scenarioId: string): Promise<SandboxResults> {
    const state = this.store.snapshot();
    const sandbox = state.sandboxes[sandboxId];

    if (!sandbox) {
      throw new DomainError(ErrorCode.SandboxNotFound, 404, `Sandbox '${sandboxId}' not found.`);
    }

    if (sandbox.status === 'running') {
      throw new DomainError(ErrorCode.InvalidPayload, 400, 'Sandbox is already running a scenario.');
    }

    const scenario = SCENARIO_MAP.get(scenarioId);
    if (!scenario) {
      throw new DomainError(ErrorCode.InvalidPayload, 400, `Unknown scenario '${scenarioId}'. Use GET /sandbox/scenarios to list available scenarios.`);
    }

    // Mark as running
    await this.store.transaction((s) => {
      s.sandboxes[sandboxId].status = 'running';
    });

    try {
      const results = this.executeScenario(sandbox.config, scenario);

      await this.store.transaction((s) => {
        s.sandboxes[sandboxId].status = 'completed';
        s.sandboxes[sandboxId].results = results;
        s.sandboxes[sandboxId].completedAt = isoNow();
      });

      eventBus.emit('sandbox.completed', {
        sandboxId,
        scenarioId,
        pnlUsd: results.pnlUsd,
        tradeCount: results.tradeCount,
      });

      return results;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      await this.store.transaction((s) => {
        s.sandboxes[sandboxId].status = 'failed';
        s.sandboxes[sandboxId].error = errorMessage;
      });
      throw err;
    }
  }

  /**
   * Get sandbox with its results.
   */
  getSandboxResults(sandboxId: string): Sandbox | null {
    const state = this.store.snapshot();
    return state.sandboxes[sandboxId] ?? null;
  }

  /**
   * List all available built-in scenarios.
   */
  listScenarios(): Array<Omit<ScenarioDefinition, 'generatePrices'>> {
    return SCENARIOS.map(({ generatePrices, ...rest }) => rest);
  }

  /**
   * Destroy a sandbox and clean up.
   */
  async destroySandbox(sandboxId: string): Promise<{ ok: boolean }> {
    const state = this.store.snapshot();
    if (!state.sandboxes[sandboxId]) {
      throw new DomainError(ErrorCode.SandboxNotFound, 404, `Sandbox '${sandboxId}' not found.`);
    }

    await this.store.transaction((s) => {
      delete s.sandboxes[sandboxId];
    });

    return { ok: true };
  }

  // ─── Private: Scenario Execution Engine ─────────────────────────────

  private executeScenario(config: SandboxConfig, scenario: ScenarioDefinition): SandboxResults {
    const priceHistory = scenario.generatePrices(config.startPriceUsd);
    const trades: SandboxTrade[] = [];
    const equityCurve: number[] = [];

    let cashUsd = config.virtualCapitalUsd;
    let positionQty = 0;
    let avgEntryPrice = 0;
    let peakEquityUsd = config.virtualCapitalUsd;
    let troughEquityUsd = config.virtualCapitalUsd;
    let maxDrawdownPct = 0;
    let maxDrawdownUsd = 0;
    let riskBreaches = 0;
    let recoveryTicks: number | null = null;
    let drawdownStart: number | null = null;

    const { buyThresholdPct, sellThresholdPct, positionSizePct } = config.strategyConfig;

    for (let tick = 0; tick < priceHistory.length; tick++) {
      const price = priceHistory[tick];
      const posValue = positionQty * price;
      const equity = cashUsd + posValue;

      equityCurve.push(Number(equity.toFixed(4)));

      // Track peaks and drawdowns
      if (equity > peakEquityUsd) {
        peakEquityUsd = equity;
        if (drawdownStart !== null && recoveryTicks === null) {
          recoveryTicks = tick - drawdownStart;
        }
        drawdownStart = null;
      }
      if (equity < troughEquityUsd) {
        troughEquityUsd = equity;
      }

      const currentDrawdownPct = peakEquityUsd > 0
        ? ((peakEquityUsd - equity) / peakEquityUsd) * 100
        : 0;

      if (currentDrawdownPct > maxDrawdownPct) {
        maxDrawdownPct = currentDrawdownPct;
        maxDrawdownUsd = peakEquityUsd - equity;
        if (drawdownStart === null) drawdownStart = tick;
      }

      // Risk breach: drawdown exceeds 25%
      if (currentDrawdownPct > 25) {
        riskBreaches++;
      }

      // Skip trading on first tick (no prior price)
      if (tick === 0) continue;

      const prevPrice = priceHistory[tick - 1];
      const changePct = (price - prevPrice) / prevPrice;

      // Simple strategy: buy on dip, sell on rip
      if (changePct <= buyThresholdPct && cashUsd > 0) {
        // Buy signal: price dropped enough
        const investAmount = equity * positionSizePct;
        const actualInvest = Math.min(investAmount, cashUsd);
        if (actualInvest > 1) {
          const qty = actualInvest / price;
          const totalQty = positionQty + qty;
          avgEntryPrice = positionQty > 0
            ? (positionQty * avgEntryPrice + qty * price) / totalQty
            : price;
          positionQty = totalQty;
          cashUsd -= actualInvest;

          trades.push({
            tick,
            side: 'buy',
            priceUsd: Number(price.toFixed(4)),
            quantity: Number(qty.toFixed(8)),
            notionalUsd: Number(actualInvest.toFixed(4)),
            pnlUsd: 0,
            reason: `Price dip ${(changePct * 100).toFixed(2)}% ≤ threshold ${(buyThresholdPct * 100).toFixed(2)}%`,
          });
        }
      } else if (changePct >= sellThresholdPct && positionQty > 0) {
        // Sell signal: price pumped enough
        const sellQty = positionQty;
        const proceeds = sellQty * price;
        const pnl = (price - avgEntryPrice) * sellQty;
        cashUsd += proceeds;
        positionQty = 0;
        avgEntryPrice = 0;

        trades.push({
          tick,
          side: 'sell',
          priceUsd: Number(price.toFixed(4)),
          quantity: Number(sellQty.toFixed(8)),
          notionalUsd: Number(proceeds.toFixed(4)),
          pnlUsd: Number(pnl.toFixed(4)),
          reason: `Price pump ${(changePct * 100).toFixed(2)}% ≥ threshold ${(sellThresholdPct * 100).toFixed(2)}%`,
        });
      }
    }

    // Compute final equity
    const finalPrice = priceHistory[priceHistory.length - 1];
    const finalEquity = cashUsd + positionQty * finalPrice;
    const pnlUsd = finalEquity - config.virtualCapitalUsd;
    const pnlPct = (pnlUsd / config.virtualCapitalUsd) * 100;

    return {
      scenarioId: scenario.id,
      scenarioName: scenario.name,
      pnlUsd: Number(pnlUsd.toFixed(4)),
      pnlPct: Number(pnlPct.toFixed(4)),
      tradeCount: trades.length,
      maxDrawdownPct: Number(maxDrawdownPct.toFixed(4)),
      maxDrawdownUsd: Number(maxDrawdownUsd.toFixed(4)),
      recoveryTicks,
      riskBreaches,
      finalEquityUsd: Number(finalEquity.toFixed(4)),
      peakEquityUsd: Number(peakEquityUsd.toFixed(4)),
      troughEquityUsd: Number(troughEquityUsd.toFixed(4)),
      trades,
      priceHistory: priceHistory.map((p) => Number(p.toFixed(4))),
      equityCurve,
    };
  }
}
