import { v4 as uuid } from 'uuid';
import { AppConfig } from '../config.js';
import {
  AutonomousGuard,
  AutonomousAgentState,
  createDefaultAgentAutonomousState,
} from '../domain/autonomous/autonomousGuard.js';
import { StrategyRegistry } from '../domain/strategy/strategyRegistry.js';
import { RiskEngine } from '../domain/risk/riskEngine.js';
import { eventBus } from '../infra/eventBus.js';
import { EventLogger } from '../infra/logger.js';
import { StateStore } from '../infra/storage/stateStore.js';
import { Agent, AutonomousLoopState, TradeIntent } from '../types.js';
import { isoNow } from '../utils/time.js';

export class AutonomousService {
  private timer?: NodeJS.Timeout;
  private running = false;
  private inFlight = false;
  private readonly guard: AutonomousGuard;
  private readonly riskEngine = new RiskEngine();

  constructor(
    private readonly store: StateStore,
    private readonly logger: EventLogger,
    private readonly strategyRegistry: StrategyRegistry,
    private readonly config: AppConfig,
  ) {
    this.guard = new AutonomousGuard({
      maxDrawdownStopPct: config.autonomous.maxDrawdownStopPct,
      cooldownMs: config.autonomous.cooldownMs,
      cooldownAfterConsecutiveFailures: config.autonomous.cooldownAfterFailures,
    });
  }

  async start(): Promise<void> {
    if (this.running) return;

    const enabled = this.config.autonomous.enabled;

    await this.store.transaction((state) => {
      state.autonomous.enabled = enabled;
      state.autonomous.intervalMs = this.config.autonomous.intervalMs;
      return undefined;
    });

    if (!enabled) {
      await this.logger.log('info', 'autonomous.disabled', {
        reason: 'AUTONOMOUS_ENABLED=false',
      });
      return;
    }

    this.running = true;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.config.autonomous.intervalMs);

    await this.logger.log('info', 'autonomous.started', {
      intervalMs: this.config.autonomous.intervalMs,
      maxDrawdownStopPct: this.config.autonomous.maxDrawdownStopPct,
      cooldownMs: this.config.autonomous.cooldownMs,
      cooldownAfterFailures: this.config.autonomous.cooldownAfterFailures,
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }

    while (this.inFlight) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    await this.logger.log('info', 'autonomous.stopped', {});
  }

  async toggle(enabled: boolean): Promise<AutonomousLoopState> {
    if (enabled && !this.running) {
      this.running = true;
      await this.store.transaction((state) => {
        state.autonomous.enabled = true;
        return undefined;
      });
      this.timer = setInterval(() => {
        void this.tick();
      }, this.config.autonomous.intervalMs);
      await this.logger.log('info', 'autonomous.toggled', { enabled: true });
    } else if (!enabled && this.running) {
      await this.stop();
      await this.store.transaction((state) => {
        state.autonomous.enabled = false;
        return undefined;
      });
    }

    return this.getStatus();
  }

  getStatus(): AutonomousLoopState {
    return structuredClone(this.store.snapshot().autonomous);
  }

  private async tick(): Promise<void> {
    if (!this.running || this.inFlight) return;
    this.inFlight = true;

    try {
      const snapshot = this.store.snapshot();
      const agents = Object.values(snapshot.agents);
      const nowMs = Date.now();
      const now = isoNow();

      const decisions: Array<{
        agentId: string;
        action: string;
        reason: string;
        intentId?: string;
      }> = [];

      for (const agent of agents) {
        const result = await this.evaluateAgent(agent, snapshot.marketPricesUsd, snapshot.marketPriceHistoryUsd, nowMs);
        decisions.push(result);
      }

      await this.store.transaction((state) => {
        state.autonomous.loopCount += 1;
        state.autonomous.lastRunAt = now;
        return undefined;
      });

      eventBus.emit('autonomous.tick', {
        agentsEvaluated: decisions.length,
        intentsCreated: decisions.filter((d) => d.action !== 'skip').length,
        loopCount: this.store.snapshot().autonomous.loopCount,
      });

      // Log summary
      const acted = decisions.filter((d) => d.action !== 'skip');
      if (acted.length > 0 || decisions.length > 0) {
        await this.logger.log('info', 'autonomous.tick', {
          agentsEvaluated: decisions.length,
          intentsCreated: acted.length,
          decisions: decisions.map((d) => ({
            agentId: d.agentId,
            action: d.action,
            reason: d.reason,
            intentId: d.intentId,
          })),
        });
      }
    } catch (error) {
      await this.logger.log('error', 'autonomous.tick.error', {
        error: String(error),
      });
    } finally {
      this.inFlight = false;
    }
  }

  private async evaluateAgent(
    agent: Agent,
    marketPrices: Record<string, number>,
    marketHistory: Record<string, Array<{ ts: string; priceUsd: number }>>,
    nowMs: number,
  ): Promise<{ agentId: string; action: string; reason: string; intentId?: string }> {
    // Ensure agent has autonomous state
    const agentAutoState = await this.store.transaction((state) => {
      if (!state.autonomous.agentStates[agent.id]) {
        state.autonomous.agentStates[agent.id] = createDefaultAgentAutonomousState();
      }
      const agentState = state.autonomous.agentStates[agent.id];
      agentState.totalEvaluations += 1;
      agentState.lastEvaluationAt = isoNow();
      return { ...agentState };
    });

    // Compute drawdown for the guard
    const equityUsd = this.riskEngine.computeEquityUsd(agent, (symbol) => marketPrices[symbol]);
    const drawdownPct = agent.peakEquityUsd > 0
      ? ((agent.peakEquityUsd - equityUsd) / agent.peakEquityUsd) * 100
      : 0;

    // Guard check — mutable state updated in place then persisted
    const mutableState: AutonomousAgentState = { ...agentAutoState };
    const guardDecision = this.guard.evaluate({
      nowMs,
      drawdownPct,
      agentState: mutableState,
    });

    // Persist guard state mutations
    await this.store.transaction((state) => {
      state.autonomous.agentStates[agent.id] = { ...mutableState };
      return undefined;
    });

    if (!guardDecision.allowTrading) {
      await this.store.transaction((state) => {
        state.autonomous.agentStates[agent.id].totalSkipped += 1;
        return undefined;
      });
      return {
        agentId: agent.id,
        action: 'skip',
        reason: `guard: ${guardDecision.reason ?? 'blocked'}`,
      };
    }

    // Evaluate strategy for each supported symbol with a market price
    const symbols = Object.keys(marketPrices);
    let bestSignal: {
      symbol: string;
      action: 'buy' | 'sell';
      confidence: number;
      rationale: string;
    } | null = null;

    for (const symbol of symbols) {
      if (symbol === 'USDC') continue; // Skip stablecoins

      const price = marketPrices[symbol];
      if (!price || price <= 0) continue;

      const history = (marketHistory[symbol] ?? []).map((p) => p.priceUsd);

      const signal = this.strategyRegistry.evaluate(agent.strategyId, {
        symbol,
        currentPriceUsd: price,
        priceHistoryUsd: history,
      });

      if (signal.action === 'hold') continue;
      if (signal.confidence < this.config.autonomous.minConfidence) continue;

      // For sell, check we actually have a position
      if (signal.action === 'sell') {
        const pos = agent.positions[symbol];
        if (!pos || pos.quantity <= 0) continue;
      }

      if (!bestSignal || signal.confidence > bestSignal.confidence) {
        bestSignal = {
          symbol,
          action: signal.action,
          confidence: signal.confidence,
          rationale: signal.rationale,
        };
      }
    }

    if (!bestSignal) {
      await this.store.transaction((state) => {
        state.autonomous.agentStates[agent.id].totalSkipped += 1;
        return undefined;
      });
      return {
        agentId: agent.id,
        action: 'skip',
        reason: 'no actionable signal from strategy',
      };
    }

    // Create a TradeIntent automatically
    const intentId = uuid();
    const intentNow = isoNow();
    const notionalUsd = this.config.autonomous.defaultNotionalUsd;

    const intent: TradeIntent = {
      id: intentId,
      agentId: agent.id,
      symbol: bestSignal.symbol,
      side: bestSignal.action,
      notionalUsd,
      createdAt: intentNow,
      updatedAt: intentNow,
      status: 'pending',
      meta: {
        source: 'autonomous',
        strategyId: agent.strategyId,
        confidence: bestSignal.confidence,
        rationale: bestSignal.rationale,
      },
    };

    await this.store.transaction((state) => {
      state.tradeIntents[intentId] = intent;
      state.metrics.intentsReceived += 1;
      state.autonomous.agentStates[agent.id].totalIntentsCreated += 1;
      state.autonomous.agentStates[agent.id].lastIntentCreatedAt = intentNow;
      return undefined;
    });

    return {
      agentId: agent.id,
      action: bestSignal.action,
      reason: `${bestSignal.symbol} ${bestSignal.action} confidence=${bestSignal.confidence.toFixed(4)} (${bestSignal.rationale})`,
      intentId,
    };
  }

  /**
   * Called by the execution worker when an intent from the autonomous loop
   * completes. Updates consecutive failure tracking.
   */
  async recordOutcome(agentId: string, success: boolean): Promise<void> {
    await this.store.transaction((state) => {
      const agentState = state.autonomous.agentStates[agentId];
      if (!agentState) return undefined;

      if (success) {
        agentState.consecutiveFailures = 0;
      } else {
        agentState.consecutiveFailures += 1;
      }
      return undefined;
    });
  }
}
