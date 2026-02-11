import { v4 as uuid } from 'uuid';
import { AppConfig } from '../config.js';
import { FeeEngine } from '../domain/fee/feeEngine.js';
import { ReceiptEngine } from '../domain/receipt/receiptEngine.js';
import { RiskEngine } from '../domain/risk/riskEngine.js';
import { StrategyRegistry } from '../domain/strategy/strategyRegistry.js';
import { eventBus } from '../infra/eventBus.js';
import { JupiterClient } from '../infra/live/jupiterClient.js';
import { EventLogger } from '../infra/logger.js';
import { StateStore } from '../infra/storage/stateStore.js';
import {
  Agent,
  AppState,
  ExecutionMode,
  ExecutionRecord,
  ExecutionReceipt,
  RiskTelemetry,
  TradeIntent,
} from '../types.js';
import { retryWithBackoff } from '../utils/retry.js';
import { dayKey, isoNow } from '../utils/time.js';

const DECIMALS_BY_SYMBOL: Record<string, number> = {
  USDC: 6,
  SOL: 9,
  BONK: 5,
  JUP: 6,
};

type ExecutionBase = Omit<ExecutionRecord, 'status' | 'netUsd' | 'realizedPnlUsd' | 'pnlSnapshotUsd'>;

export class ExecutionService {
  private readonly riskEngine = new RiskEngine();
  private readonly receiptEngine = new ReceiptEngine();
  private readonly strategyRegistry = new StrategyRegistry();
  private readonly jupiterClient: JupiterClient;

  constructor(
    private readonly store: StateStore,
    private readonly logger: EventLogger,
    private readonly feeEngine: FeeEngine,
    private readonly config: AppConfig,
  ) {
    this.jupiterClient = new JupiterClient(
      config.trading.jupiterQuoteUrl,
      config.trading.jupiterSwapUrl,
      config.trading.solanaRpcUrl,
      config.trading.solanaPrivateKeyB58,
      config.trading.liveBroadcastEnabled,
    );
  }

  async setMarketPrice(symbol: string, priceUsd: number): Promise<void> {
    await this.store.transaction((state) => {
      const normalizedSymbol = symbol.toUpperCase();
      state.marketPricesUsd[normalizedSymbol] = Number(priceUsd.toFixed(8));

      const currentHistory = state.marketPriceHistoryUsd[normalizedSymbol] ?? [];
      const nextHistory = [
        ...currentHistory,
        {
          ts: isoNow(),
          priceUsd: Number(priceUsd.toFixed(8)),
        },
      ].slice(-this.config.trading.marketHistoryLimit);

      state.marketPriceHistoryUsd[normalizedSymbol] = nextHistory;
      return undefined;
    });
  }

  getMarketPrices(): Record<string, number> {
    return this.store.snapshot().marketPricesUsd;
  }

  getExecutionById(executionId: string): ExecutionRecord | undefined {
    return this.store.snapshot().executions[executionId];
  }

  getReceiptByExecutionId(executionId: string): ExecutionReceipt | undefined {
    return this.store.snapshot().executionReceipts[executionId];
  }

  verifyReceipt(executionId: string): {
    ok: boolean;
    receipt: ExecutionReceipt;
    execution: ExecutionRecord;
    expectedPayloadHash: string;
    expectedReceiptHash: string;
    expectedSignaturePayloadHash: string;
  } | undefined {
    const snapshot = this.store.snapshot();
    const execution = snapshot.executions[executionId];
    const receipt = snapshot.executionReceipts[executionId];
    if (!execution || !receipt) return undefined;

    const verification = this.receiptEngine.verifyReceipt(execution, receipt);

    return {
      ok: verification.ok,
      receipt,
      execution,
      expectedPayloadHash: verification.expectedPayloadHash,
      expectedReceiptHash: verification.expectedReceiptHash,
      expectedSignaturePayloadHash: verification.expectedSignaturePayloadHash,
    };
  }

  getRiskTelemetry(agentId: string): RiskTelemetry | undefined {
    const snapshot = this.store.snapshot();
    const agent = snapshot.agents[agentId];
    if (!agent) return undefined;

    const asOfDate = new Date();
    const asOf = isoNow();

    const equityUsd = this.riskEngine.computeEquityUsd(agent, (symbol) => snapshot.marketPricesUsd[symbol]);
    const grossExposureUsd = this.riskEngine.computeGrossExposureUsd(agent, (symbol) => snapshot.marketPricesUsd[symbol]);
    const drawdownPct = agent.peakEquityUsd > 0
      ? Number(((agent.peakEquityUsd - equityUsd) / agent.peakEquityUsd).toFixed(8))
      : 0;

    const cooldownMs = agent.riskLimits.cooldownSeconds * 1000;
    const lastTradeMs = agent.lastTradeAt ? new Date(agent.lastTradeAt).getTime() : undefined;
    const remainingMs = lastTradeMs !== undefined
      ? Math.max(0, (lastTradeMs + cooldownMs) - asOfDate.getTime())
      : 0;

    const cooldown = {
      active: remainingMs > 0,
      cooldownSeconds: agent.riskLimits.cooldownSeconds,
      remainingSeconds: Number((remainingMs / 1000).toFixed(3)),
      lastTradeAt: agent.lastTradeAt,
      cooldownUntil: lastTradeMs !== undefined ? new Date(lastTradeMs + cooldownMs).toISOString() : undefined,
    };

    return {
      agentId,
      asOf,
      strategyId: agent.strategyId,
      cashUsd: agent.cashUsd,
      equityUsd,
      grossExposureUsd,
      realizedPnlUsd: agent.realizedPnlUsd,
      dailyPnlUsd: agent.dailyRealizedPnlUsd[dayKey(asOfDate)] ?? 0,
      peakEquityUsd: agent.peakEquityUsd,
      drawdownPct,
      rejectCountersByReason: { ...agent.riskRejectionsByReason },
      globalRejectCountersByReason: { ...snapshot.metrics.riskRejectionsByReason },
      cooldown,
      limits: agent.riskLimits,
    };
  }

  async processIntent(intentId: string): Promise<void> {
    const claim = await this.store.transaction((state) => {
      const intent = state.tradeIntents[intentId];
      if (!intent || intent.status !== 'pending') return undefined;
      intent.status = 'processing';
      intent.updatedAt = isoNow();
      return { ...intent };
    });

    if (!claim) return;

    const snapshot = this.store.snapshot();
    const agent = snapshot.agents[claim.agentId];
    if (!agent) {
      await this.markIntentFailed(claim.id, 'unknown_agent');
      return;
    }

    const marketPrice = snapshot.marketPricesUsd[claim.symbol];
    if (!marketPrice) {
      await this.markIntentRejected(claim.id, 'market_price_missing');
      return;
    }

    const strategySignal = this.strategyRegistry.evaluate(agent.strategyId, {
      symbol: claim.symbol,
      currentPriceUsd: marketPrice,
      priceHistoryUsd: (snapshot.marketPriceHistoryUsd[claim.symbol] ?? []).map((point) => point.priceUsd),
    });

    if (strategySignal.action === 'hold') {
      await this.markIntentRejected(claim.id, `strategy_hold:${agent.strategyId}`);
      return;
    }

    if (strategySignal.action !== claim.side) {
      await this.markIntentRejected(claim.id, `strategy_side_mismatch:${agent.strategyId}:${strategySignal.action}`);
      return;
    }

    const decision = this.riskEngine.evaluate({
      agent,
      intent: claim,
      priceUsd: marketPrice,
      now: new Date(),
    });

    if (!decision.approved) {
      await this.markIntentRejected(claim.id, decision.reason ?? 'risk_rejected');
      return;
    }

    const mode = this.resolveMode(claim);
    if (mode === 'live' && !this.canRunLiveMode()) {
      await this.markIntentRejected(claim.id, 'live_mode_not_configured');
      return;
    }

    const executionId = uuid();
    const executionBase: ExecutionBase = {
      id: executionId,
      intentId: claim.id,
      agentId: claim.agentId,
      symbol: claim.symbol,
      side: claim.side,
      quantity: decision.computedQuantity,
      priceUsd: marketPrice,
      grossNotionalUsd: decision.computedNotionalUsd,
      feeUsd: this.feeEngine.calculateExecutionFeeUsd(decision.computedNotionalUsd),
      mode,
      createdAt: isoNow(),
    };

    if (mode === 'paper') {
      await this.applyPaperExecution(claim, executionBase);
      return;
    }

    await this.applyLiveExecution(claim, executionBase);
  }

  private async applyPaperExecution(
    intent: TradeIntent,
    executionBase: ExecutionBase,
  ): Promise<void> {
    await this.store.transaction((state) => {
      const agent = state.agents[intent.agentId];
      const trackedIntent = state.tradeIntents[intent.id];
      if (!agent || !trackedIntent) return undefined;

      const applyResult = this.applyAccountingTrade(agent, {
        symbol: executionBase.symbol,
        side: executionBase.side,
        quantity: executionBase.quantity,
        priceUsd: executionBase.priceUsd,
        feeUsd: executionBase.feeUsd,
      }, state.marketPricesUsd);

      if (!applyResult.ok) {
        const failed: ExecutionRecord = {
          ...executionBase,
          status: 'failed',
          failureReason: applyResult.reason,
          netUsd: 0,
          realizedPnlUsd: 0,
          pnlSnapshotUsd: agent.realizedPnlUsd,
        };

        this.persistExecutionWithReceipt(state, failed);

        trackedIntent.status = 'failed';
        trackedIntent.statusReason = applyResult.reason;
        trackedIntent.executionId = failed.id;
        trackedIntent.updatedAt = isoNow();
        state.metrics.intentsFailed += 1;
        return undefined;
      }

      const execution: ExecutionRecord = {
        ...executionBase,
        status: 'filled',
        netUsd: applyResult.netUsd,
        realizedPnlUsd: applyResult.realizedPnlUsd,
        pnlSnapshotUsd: agent.realizedPnlUsd,
      };

      this.persistExecutionWithReceipt(state, execution);

      trackedIntent.status = 'executed';
      trackedIntent.executionId = execution.id;
      trackedIntent.updatedAt = isoNow();

      state.treasury.totalFeesUsd = Number((state.treasury.totalFeesUsd + execution.feeUsd).toFixed(8));
      state.treasury.entries.unshift({
        id: uuid(),
        source: 'execution-fee',
        amountUsd: execution.feeUsd,
        refId: execution.id,
        createdAt: isoNow(),
        notes: 'paper execution fee',
      });

      state.metrics.intentsExecuted += 1;
      return undefined;
    });

    eventBus.emit('intent.executed', {
      intentId: intent.id,
      agentId: intent.agentId,
      symbol: intent.symbol,
      side: intent.side,
      mode: 'paper',
    });

    await this.logger.log('info', 'intent.executed.paper', {
      intentId: intent.id,
      agentId: intent.agentId,
      symbol: intent.symbol,
      side: intent.side,
    });
  }

  private async applyLiveExecution(
    intent: TradeIntent,
    executionBase: ExecutionBase,
  ): Promise<void> {
    const symbolMint = this.config.trading.symbolToMint[intent.symbol];
    const usdcMint = this.config.trading.symbolToMint.USDC;

    if (!symbolMint || !usdcMint) {
      await this.markIntentFailed(intent.id, 'mint_config_missing');
      return;
    }

    const isBuy = intent.side === 'buy';
    const feeParams = this.feeEngine.buildJupiterFeeParams();

    const quote = await retryWithBackoff(
      () => this.jupiterClient.quote({
        inputMint: isBuy ? usdcMint : symbolMint,
        outputMint: isBuy ? symbolMint : usdcMint,
        amount: this.toChainAmount(
          isBuy ? 'USDC' : intent.symbol,
          executionBase.grossNotionalUsd / (isBuy ? 1 : executionBase.priceUsd),
        ),
        slippageBps: 50,
        platformFeeBps: feeParams.platformFeeBps,
      }),
      {
        maxAttempts: this.config.trading.quoteRetryAttempts,
        baseDelayMs: this.config.trading.quoteRetryBaseDelayMs,
        maxDelayMs: 2_000,
        onRetry: async ({ attempt, nextDelayMs, error }) => {
          await this.store.transaction((state) => {
            state.metrics.quoteRetries += 1;
            return undefined;
          });

          await this.logger.log('warn', 'jupiter.quote.retry', {
            intentId: intent.id,
            attempt,
            nextDelayMs,
            error: String(error),
          });
        },
      },
    ).catch(async (error: unknown) => {
      await this.markIntentFailed(intent.id, `jupiter_quote_error:${String(error)}`);
      return undefined;
    });

    if (!quote) return;

    const swap = await this.jupiterClient.swapFromQuote(quote, feeParams.feeAccount).catch(async (error: unknown) => {
      await this.markIntentFailed(intent.id, `jupiter_swap_error:${String(error)}`);
      return undefined;
    });

    if (!swap) return;

    await this.store.transaction((state) => {
      const agent = state.agents[intent.agentId];
      const trackedIntent = state.tradeIntents[intent.id];
      if (!agent || !trackedIntent) return undefined;

      const applyResult = this.applyAccountingTrade(agent, {
        symbol: executionBase.symbol,
        side: executionBase.side,
        quantity: executionBase.quantity,
        priceUsd: executionBase.priceUsd,
        feeUsd: executionBase.feeUsd,
      }, state.marketPricesUsd);

      if (!applyResult.ok) {
        const failed: ExecutionRecord = {
          ...executionBase,
          status: 'failed',
          failureReason: applyResult.reason,
          netUsd: 0,
          realizedPnlUsd: 0,
          pnlSnapshotUsd: agent.realizedPnlUsd,
        };

        this.persistExecutionWithReceipt(state, failed);

        trackedIntent.status = 'failed';
        trackedIntent.statusReason = applyResult.reason;
        trackedIntent.executionId = failed.id;
        trackedIntent.updatedAt = isoNow();
        state.metrics.intentsFailed += 1;
        return undefined;
      }

      const filled: ExecutionRecord = {
        ...executionBase,
        status: 'filled',
        netUsd: applyResult.netUsd,
        realizedPnlUsd: applyResult.realizedPnlUsd,
        pnlSnapshotUsd: agent.realizedPnlUsd,
        txSignature: swap.txSignature,
      };

      this.persistExecutionWithReceipt(state, filled);

      trackedIntent.status = 'executed';
      trackedIntent.executionId = filled.id;
      trackedIntent.updatedAt = isoNow();

      state.treasury.totalFeesUsd = Number((state.treasury.totalFeesUsd + filled.feeUsd).toFixed(8));
      state.treasury.entries.unshift({
        id: uuid(),
        source: 'execution-fee',
        amountUsd: filled.feeUsd,
        refId: filled.id,
        createdAt: isoNow(),
        notes: swap.simulated ? 'live/simulated execution fee' : 'live on-chain execution fee',
      });

      state.metrics.intentsExecuted += 1;
      return undefined;
    });

    eventBus.emit('intent.executed', {
      intentId: intent.id,
      agentId: intent.agentId,
      symbol: intent.symbol,
      side: intent.side,
      mode: 'live',
      txSignature: swap.txSignature,
    });

    await this.logger.log('info', 'intent.executed.live', {
      intentId: intent.id,
      agentId: intent.agentId,
      simulated: swap.simulated,
      txSignature: swap.txSignature,
    });
  }

  private resolveMode(intent: TradeIntent): ExecutionMode {
    const requested = intent.requestedMode ?? this.config.trading.defaultMode;
    return requested === 'live' ? 'live' : 'paper';
  }

  private canRunLiveMode(): boolean {
    return this.config.trading.liveEnabled && this.jupiterClient.isReadyForLive();
  }

  private toChainAmount(symbol: string, units: number): number {
    const decimals = DECIMALS_BY_SYMBOL[symbol] ?? 6;
    return Math.floor(units * 10 ** decimals);
  }

  private persistExecutionWithReceipt(state: AppState, execution: ExecutionRecord): void {
    const receipt = this.receiptEngine.createReceipt(execution, state.latestReceiptHash);
    execution.receiptHash = receipt.receiptHash;

    state.executions[execution.id] = execution;
    state.executionReceipts[execution.id] = receipt;
    state.latestReceiptHash = receipt.receiptHash;
    state.metrics.receiptCount += 1;
  }

  private applyAccountingTrade(
    agent: Agent,
    input: {
      symbol: string;
      side: 'buy' | 'sell';
      quantity: number;
      priceUsd: number;
      feeUsd: number;
    },
    market: Record<string, number>,
  ):
    | { ok: true; netUsd: number; realizedPnlUsd: number }
    | { ok: false; reason: string } {
    const gross = Number((input.quantity * input.priceUsd).toFixed(8));

    if (input.side === 'buy') {
      const totalCost = Number((gross + input.feeUsd).toFixed(8));
      if (agent.cashUsd < totalCost) {
        return { ok: false, reason: 'insufficient_cash_for_buy' };
      }

      const existing = agent.positions[input.symbol] ?? {
        symbol: input.symbol,
        quantity: 0,
        avgEntryPriceUsd: input.priceUsd,
      };

      const newQty = Number((existing.quantity + input.quantity).toFixed(8));
      const newAvg = Number((((existing.quantity * existing.avgEntryPriceUsd) + gross) / newQty).toFixed(8));

      agent.positions[input.symbol] = {
        symbol: input.symbol,
        quantity: newQty,
        avgEntryPriceUsd: newAvg,
      };

      agent.cashUsd = Number((agent.cashUsd - totalCost).toFixed(8));
      agent.updatedAt = isoNow();
      agent.lastTradeAt = isoNow();
      this.refreshEquity(agent, market);

      return {
        ok: true,
        netUsd: Number((-totalCost).toFixed(8)),
        realizedPnlUsd: 0,
      };
    }

    const existing = agent.positions[input.symbol];
    if (!existing || existing.quantity < input.quantity) {
      return { ok: false, reason: 'insufficient_inventory_for_sell' };
    }

    const proceeds = Number((gross - input.feeUsd).toFixed(8));
    const realizedPnl = Number(((input.priceUsd - existing.avgEntryPriceUsd) * input.quantity).toFixed(8));

    agent.cashUsd = Number((agent.cashUsd + proceeds).toFixed(8));
    agent.realizedPnlUsd = Number((agent.realizedPnlUsd + realizedPnl).toFixed(8));

    const remainingQty = Number((existing.quantity - input.quantity).toFixed(8));
    if (remainingQty <= 0) {
      delete agent.positions[input.symbol];
    } else {
      agent.positions[input.symbol] = {
        ...existing,
        quantity: remainingQty,
      };
    }

    const key = dayKey();
    agent.dailyRealizedPnlUsd[key] = Number(((agent.dailyRealizedPnlUsd[key] ?? 0) + realizedPnl).toFixed(8));
    agent.updatedAt = isoNow();
    agent.lastTradeAt = isoNow();
    this.refreshEquity(agent, market);

    return {
      ok: true,
      netUsd: proceeds,
      realizedPnlUsd: realizedPnl,
    };
  }

  private refreshEquity(agent: Agent, market: Record<string, number>): void {
    const equity = this.riskEngine.computeEquityUsd(agent, (symbol) => market[symbol]);
    agent.peakEquityUsd = Math.max(agent.peakEquityUsd, equity);
  }

  private async markIntentRejected(intentId: string, reason: string): Promise<void> {
    await this.store.transaction((state) => {
      const intent = state.tradeIntents[intentId];
      if (!intent) return undefined;
      intent.status = 'rejected';
      intent.statusReason = reason;
      intent.updatedAt = isoNow();
      state.metrics.intentsRejected += 1;
      state.metrics.riskRejectionsByReason[reason] = (state.metrics.riskRejectionsByReason[reason] ?? 0) + 1;

      const agent = state.agents[intent.agentId];
      if (agent) {
        agent.riskRejectionsByReason[reason] = (agent.riskRejectionsByReason[reason] ?? 0) + 1;
      }

      return undefined;
    });

    eventBus.emit('intent.rejected', { intentId, reason });

    await this.logger.log('warn', 'intent.rejected', { intentId, reason });
  }

  private async markIntentFailed(intentId: string, reason: string): Promise<void> {
    await this.store.transaction((state) => {
      const intent = state.tradeIntents[intentId];
      if (!intent) return undefined;
      intent.status = 'failed';
      intent.statusReason = reason;
      intent.updatedAt = isoNow();
      state.metrics.intentsFailed += 1;
      return undefined;
    });

    await this.logger.log('error', 'intent.failed', { intentId, reason });
  }
}
