import { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { AppConfig } from '../config.js';
import { renderExperimentPage } from './experimentPage.js';
import { renderDocsPage } from './docsPage.js';
import { connectedClients } from './websocket.js';
import { FeeEngine } from '../domain/fee/feeEngine.js';
import { redactReceipt } from '../domain/privacy/receiptRedaction.js';
import { SkillRegistry } from '../domain/skills/skillRegistry.js';
import { StrategyRegistry } from '../domain/strategy/strategyRegistry.js';
import { DomainError, ErrorCode, toErrorEnvelope } from '../errors/taxonomy.js';
import { eventBus } from '../infra/eventBus.js';
import { StateStore } from '../infra/storage/stateStore.js';
import { AgentService } from '../services/agentService.js';
import { AnalyticsService } from '../services/analyticsService.js';
import { AutonomousService } from '../services/autonomousService.js';
import { CoordinationService } from '../services/coordinationService.js';
import { resolveAgentFromKey } from '../services/auth.js';
import { ExecutionService } from '../services/executionService.js';
import { LendingMonitorService } from '../services/lendingMonitorService.js';
import { TokenRevenueService } from '../services/tokenRevenueService.js';
import { TradeIntentService } from '../services/tradeIntentService.js';
import { X402Policy } from '../services/x402Policy.js';
import { SimulationService } from '../services/simulationService.js';
import { WebhookService } from '../services/webhookService.js';
import { ArbitrageService } from '../services/arbitrageService.js';
import { ReputationService } from '../services/reputationService.js';
import { ProofAnchorService } from '../services/proofAnchorService.js';
import { GovernanceService } from '../services/governanceService.js';
import { OrderBookService } from '../services/orderBookService.js';
import { BacktestService } from '../services/backtestService.js';
import { MarketplaceService } from '../services/marketplaceService.js';
import { AdvancedOrderService } from '../services/advancedOrderService.js';
import { MessagingService } from '../services/messagingService.js';
import { MevProtectionService } from '../services/mevProtectionService.js';
import { JournalService } from '../services/journalService.js';
import { StrategyCompareService } from '../services/strategyCompareService.js';
import { PriceOracleService } from '../services/priceOracleService.js';
import { RebalanceService } from '../services/rebalanceService.js';
import { AlertService } from '../services/alertService.js';
import { CopyTradingService } from '../services/copyTradingService.js';
import { CreditRatingService } from '../services/creditRatingService.js';
import { WatchlistService } from '../services/watchlistService.js';
import { TradeHistoryService } from '../services/tradeHistoryService.js';
import { DiagnosticsService } from '../services/diagnosticsService.js';
import { SelfImproveService } from '../services/selfImproveService.js';
import { InferenceBudgetService } from '../services/inferenceBudgetService.js';
import { ImprovementLoopService } from '../services/improvementLoopService.js';
import { TournamentService } from '../services/tournamentService.js';
import { SocialTradingService } from '../services/socialTradingService.js';
import { PythOracleService } from '../services/pythOracleService.js';
import { BenchmarkService } from '../services/benchmarkService.js';
import { TimeframeService } from '../services/timeframeService.js';
import { NotificationService, subscribeSchema as notificationSubscribeSchema } from '../services/notificationService.js';
import { SentimentService } from '../services/sentimentService.js';
import { SandboxService, createSandboxSchema, runSandboxSchema } from '../services/sandboxService.js';
import { SkillsMarketplaceService, SKILL_CATEGORIES } from '../services/skillsMarketplaceService.js';
import { ExecutionAnalyticsService } from '../services/executionAnalyticsService.js';
import { CollaborationService } from '../services/collaborationService.js';
import { StressTestService } from '../services/stressTestService.js';
import { DefiHealthScoreService } from '../services/defiHealthScoreService.js';
import { BacktestV2Service } from '../services/backtestV2Service.js';
import { AgentLearningService } from '../services/agentLearningService.js';
import { AgentPersonalityService } from '../services/agentPersonalityService.js';
import { GasOptimizationService } from '../services/gasOptimizationService.js';
import { LiquidityAnalysisService } from '../services/liquidityAnalysisService.js';
import { PortfolioAnalyticsService } from '../services/portfolioAnalyticsService.js';
import { AgentMarketplaceService } from '../services/agentMarketplaceService.js';
import { ComplianceService } from '../services/complianceService.js';
import { SmartOrderRouterService } from '../services/smartOrderRouterService.js';
import { BridgeMonitorService } from '../services/bridgeMonitorService.js';
import { TelemetryService } from '../services/telemetryService.js';
import { RateLimiter } from './rateLimiter.js';
import { StagedPipeline } from '../domain/execution/stagedPipeline.js';
import { RuntimeMetrics } from '../types.js';

interface RouteDeps {
  config: AppConfig;
  store: StateStore;
  agentService: AgentService;
  intentService: TradeIntentService;
  executionService: ExecutionService;
  feeEngine: FeeEngine;
  strategyRegistry: StrategyRegistry;
  tokenRevenueService: TokenRevenueService;
  autonomousService: AutonomousService;
  x402Policy: X402Policy;
  arbitrageService: ArbitrageService;
  coordinationService: CoordinationService;
  analyticsService: AnalyticsService;
  lendingMonitorService: LendingMonitorService;
  skillRegistry: SkillRegistry;
  simulationService: SimulationService;
  webhookService: WebhookService;
  rateLimiter: RateLimiter;
  stagedPipeline: StagedPipeline;
  reputationService: ReputationService;
  proofAnchorService: ProofAnchorService;
  governanceService: GovernanceService;
  orderBookService: OrderBookService;
  backtestService: BacktestService;
  marketplaceService: MarketplaceService;
  advancedOrderService: AdvancedOrderService;
  messagingService: MessagingService;
  mevProtectionService: MevProtectionService;
  journalService: JournalService;
  strategyCompareService: StrategyCompareService;
  priceOracleService: PriceOracleService;
  rebalanceService: RebalanceService;
  alertService: AlertService;
  copyTradingService: CopyTradingService;
  creditRatingService: CreditRatingService;
  watchlistService: WatchlistService;
  tradeHistoryService: TradeHistoryService;
  diagnosticsService: DiagnosticsService;
  selfImproveService: SelfImproveService;
  inferenceBudgetService: InferenceBudgetService;
  improvementLoopService: ImprovementLoopService;
  tournamentService: TournamentService;
  socialTradingService: SocialTradingService;
  pythOracleService: PythOracleService;
  benchmarkService: BenchmarkService;
  timeframeService: TimeframeService;
  notificationService: NotificationService;
  sentimentService: SentimentService;
  sandboxService: SandboxService;
  skillsMarketplaceService: SkillsMarketplaceService;
  executionAnalyticsService: ExecutionAnalyticsService;
  collaborationService: CollaborationService;
  stressTestService: StressTestService;
  defiHealthScoreService: DefiHealthScoreService;
  backtestV2Service: BacktestV2Service;
  agentLearningService: AgentLearningService;
  agentPersonalityService: AgentPersonalityService;
  gasOptimizationService: GasOptimizationService;
  liquidityAnalysisService: LiquidityAnalysisService;
  portfolioAnalyticsService: PortfolioAnalyticsService;
  agentMarketplaceService: AgentMarketplaceService;
  complianceService: ComplianceService;
  smartOrderRouterService: SmartOrderRouterService;
  bridgeMonitorService: BridgeMonitorService;
  telemetryService: TelemetryService;
  getRuntimeMetrics: () => RuntimeMetrics;
}

const registerAgentSchema = z.object({
  name: z.string().min(2).max(120),
  startingCapitalUsd: z.number().positive().optional(),
  strategyId: z.enum(['momentum-v1', 'mean-reversion-v1', 'arbitrage-v1', 'dca-v1', 'twap-v1']).optional(),
  webhookUrl: z.string().url().optional(),
  riskOverrides: z.object({
    maxPositionSizePct: z.number().positive().max(1).optional(),
    maxOrderNotionalUsd: z.number().positive().optional(),
    maxGrossExposureUsd: z.number().positive().optional(),
    dailyLossCapUsd: z.number().positive().optional(),
    maxDrawdownPct: z.number().positive().max(1).optional(),
    cooldownSeconds: z.number().nonnegative().optional(),
  }).partial().optional(),
});

const simulateSchema = z.object({
  agentId: z.string().min(2),
  symbol: z.string().min(2).max(20),
  side: z.enum(['buy', 'sell']),
  quantity: z.number().positive().optional(),
  notionalUsd: z.number().positive().optional(),
  hypotheticalPriceUsd: z.number().positive().optional(),
}).refine((payload) => payload.quantity || payload.notionalUsd, {
  message: 'quantity or notionalUsd required',
});

const tradeIntentSchema = z.object({
  agentId: z.string().min(2),
  symbol: z.string().min(2).max(20),
  side: z.enum(['buy', 'sell']),
  quantity: z.number().positive().optional(),
  notionalUsd: z.number().positive().optional(),
  requestedMode: z.enum(['paper', 'live']).optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
}).refine((payload) => payload.quantity || payload.notionalUsd, {
  message: 'quantity or notionalUsd required',
});

const marketUpdateSchema = z.object({
  symbol: z.string().min(2).max(20),
  priceUsd: z.number().positive(),
});

const strategyUpdateSchema = z.object({
  strategyId: z.enum(['momentum-v1', 'mean-reversion-v1', 'arbitrage-v1', 'dca-v1', 'twap-v1']),
});

const clawpumpLaunchSchema = z.object({
  name: z.string().min(2).max(80),
  symbol: z.string().min(2).max(12).transform((value) => value.toUpperCase()),
  description: z.string().min(10).max(280),
  website: z.string().url().optional(),
  twitter: z.string().url().optional(),
  telegram: z.string().url().optional(),
  imagePath: z.string().min(1).max(512).optional(),
});

const clawpumpEarningsQuerySchema = z.object({
  agentId: z.string().min(2),
});

const sendDomainError = (reply: FastifyReply, error: unknown): void => {
  if (error instanceof DomainError) {
    void reply.code(error.statusCode).send(toErrorEnvelope(error.code, error.message, error.details));
    return;
  }

  void reply.code(500).send(toErrorEnvelope(
    ErrorCode.InternalError,
    'Unexpected internal error',
    { error: String(error) },
  ));
};

export async function registerRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  app.get('/', async () => ({
    name: deps.config.app.name,
    version: '0.4.0',
    status: 'ok',
    mode: deps.config.trading.defaultMode,
  }));

  app.get('/experiment', async (_request, reply) => reply
    .type('text/html; charset=utf-8')
    .send(renderExperimentPage()));

  app.get('/agents', async () => {
    const state = deps.store.snapshot();
    const agents = Object.values(state.agents)
      .map((agent) => ({
        id: agent.id,
        name: agent.name,
        createdAt: agent.createdAt,
        updatedAt: agent.updatedAt,
        strategyId: agent.strategyId,
      }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    return { agents };
  });

  app.get('/strategies', async () => ({
    strategies: deps.strategyRegistry.list().map((strategy) => ({
      id: strategy.id,
      name: strategy.name,
      description: strategy.description,
    })),
  }));

  app.get('/paid-plan/policy', async () => deps.x402Policy);

  app.get('/integrations/clawpump/health', async (_request, reply) => {
    try {
      return await deps.tokenRevenueService.health();
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  app.get('/integrations/clawpump/earnings', async (request, reply) => {
    const parse = clawpumpEarningsQuerySchema.safeParse(request.query);
    if (!parse.success) {
      return reply.code(400).send(toErrorEnvelope(
        ErrorCode.InvalidPayload,
        'Invalid query params.',
        parse.error.flatten(),
      ));
    }

    try {
      return await deps.tokenRevenueService.earnings(parse.data.agentId);
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  app.post('/integrations/clawpump/launch', async (request, reply) => {
    const parse = clawpumpLaunchSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.code(400).send(toErrorEnvelope(
        ErrorCode.InvalidPayload,
        'Invalid request payload.',
        parse.error.flatten(),
      ));
    }

    try {
      const launched = await deps.tokenRevenueService.launch(parse.data);
      return reply.code(201).send(launched);
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  app.get('/integrations/clawpump/launch-attempts', async (request) => {
    const query = request.query as { limit?: string };
    const limit = Math.min(Math.max(Number(query.limit ?? 20), 1), 200);

    return {
      attempts: deps.tokenRevenueService.listLaunchAttempts(limit),
    };
  });

  app.post('/agents/register', async (request, reply) => {
    const parse = registerAgentSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.code(400).send(toErrorEnvelope(
        ErrorCode.InvalidPayload,
        'Invalid request payload.',
        parse.error.flatten(),
      ));
    }

    try {
      const agent = await deps.agentService.register(parse.data);

      // Register webhook if provided
      if (parse.data.webhookUrl) {
        deps.webhookService.register(agent.id, parse.data.webhookUrl);
      }

      eventBus.emit('agent.registered', {
        agentId: agent.id,
        name: agent.name,
        strategyId: agent.strategyId,
      });

      return reply.code(201).send({
        agent: {
          id: agent.id,
          name: agent.name,
          createdAt: agent.createdAt,
          startingCapitalUsd: agent.startingCapitalUsd,
          riskLimits: agent.riskLimits,
          strategyId: agent.strategyId,
          webhookUrl: parse.data.webhookUrl ?? null,
        },
        apiKey: agent.apiKey,
        note: 'Store apiKey securely. It is required for trade-intent API access.',
      });
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  app.patch('/agents/:agentId/strategy', async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    const parse = strategyUpdateSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.code(400).send(toErrorEnvelope(
        ErrorCode.InvalidPayload,
        'Invalid request payload.',
        parse.error.flatten(),
      ));
    }

    try {
      const agent = await deps.agentService.setStrategy(agentId, parse.data.strategyId);
      return {
        agentId: agent.id,
        strategyId: agent.strategyId,
        updatedAt: agent.updatedAt,
      };
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  app.get('/agents/:agentId', async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    const agent = deps.agentService.getById(agentId);
    if (!agent) {
      return reply.code(404).send(toErrorEnvelope(ErrorCode.AgentNotFound, 'Agent not found.'));
    }

    return {
      id: agent.id,
      name: agent.name,
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt,
      startingCapitalUsd: agent.startingCapitalUsd,
      cashUsd: agent.cashUsd,
      realizedPnlUsd: agent.realizedPnlUsd,
      peakEquityUsd: agent.peakEquityUsd,
      riskLimits: agent.riskLimits,
      positions: Object.values(agent.positions),
      strategyId: agent.strategyId,
      lastTradeAt: agent.lastTradeAt,
    };
  });

  app.get('/agents/:agentId/portfolio', async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    const state = deps.store.snapshot();
    const agent = state.agents[agentId];
    if (!agent) {
      return reply.code(404).send(toErrorEnvelope(ErrorCode.AgentNotFound, 'Agent not found.'));
    }

    const markedValue = Object.values(agent.positions).reduce((sum, position) => {
      const px = state.marketPricesUsd[position.symbol] ?? position.avgEntryPriceUsd;
      return sum + (position.quantity * px);
    }, 0);

    return {
      agentId,
      cashUsd: agent.cashUsd,
      inventoryValueUsd: Number(markedValue.toFixed(8)),
      equityUsd: Number((agent.cashUsd + markedValue).toFixed(8)),
      realizedPnlUsd: agent.realizedPnlUsd,
      positions: Object.values(agent.positions),
      marketPricesUsd: state.marketPricesUsd,
      strategyId: agent.strategyId,
    };
  });

  const serveRiskTelemetry = async (request: { params: { agentId: string } }, reply: FastifyReply) => {
    const { agentId } = request.params;
    const telemetry = deps.executionService.getRiskTelemetry(agentId);

    if (!telemetry) {
      return reply.code(404).send(toErrorEnvelope(ErrorCode.AgentNotFound, 'Agent not found.'));
    }

    return telemetry;
  };

  app.get('/agents/:agentId/risk', async (request, reply) => serveRiskTelemetry(request as { params: { agentId: string } }, reply));
  app.get('/agents/:agentId/risk-telemetry', async (request, reply) => serveRiskTelemetry(request as { params: { agentId: string } }, reply));

  app.post('/trade-intents', async (request, reply) => {
    const auth = resolveAgentFromKey(request, reply, deps.agentService);
    if (!auth) return;

    // Rate limit check
    const rateResult = deps.rateLimiter.check(auth.id);
    if (!rateResult.allowed) {
      await deps.store.transaction((state) => {
        state.metrics.rateLimitDenials += 1;
        return undefined;
      });

      return reply
        .code(429)
        .header('Retry-After', String(rateResult.retryAfterSeconds))
        .header('X-RateLimit-Limit', String(rateResult.limit))
        .header('X-RateLimit-Remaining', '0')
        .send(toErrorEnvelope(
          ErrorCode.RateLimited,
          'Rate limit exceeded for trade intent submission.',
          {
            retryAfterSeconds: rateResult.retryAfterSeconds,
            limit: rateResult.limit,
          },
        ));
    }

    const parse = tradeIntentSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.code(400).send(toErrorEnvelope(
        ErrorCode.InvalidPayload,
        'Invalid request payload.',
        parse.error.flatten(),
      ));
    }

    if (auth.id !== parse.data.agentId) {
      return reply.code(403).send(toErrorEnvelope(
        ErrorCode.AgentKeyMismatch,
        'Provided API key does not belong to the requested agentId.',
      ));
    }

    const symbol = parse.data.symbol.toUpperCase();
    if (!deps.config.trading.supportedSymbols.includes(symbol)) {
      return reply.code(400).send(toErrorEnvelope(
        ErrorCode.UnsupportedSymbol,
        `Unsupported symbol '${symbol}'.`,
        {
          supportedSymbols: deps.config.trading.supportedSymbols,
        },
      ));
    }

    const rawIdempotency = request.headers['x-idempotency-key'] ?? request.headers['idempotency-key'];
    const idempotencyKey = typeof rawIdempotency === 'string' ? rawIdempotency.trim() : undefined;

    if (idempotencyKey && idempotencyKey.length > 128) {
      return reply.code(400).send(toErrorEnvelope(
        ErrorCode.InvalidPayload,
        'x-idempotency-key header must be <= 128 characters.',
      ));
    }

    try {
      const result = await deps.intentService.create({
        ...parse.data,
        symbol,
      }, {
        idempotencyKey,
      });

      if (!result.replayed) {
        eventBus.emit('intent.created', {
          intentId: result.intent.id,
          agentId: result.intent.agentId,
          symbol: result.intent.symbol,
          side: result.intent.side,
          notionalUsd: result.intent.notionalUsd,
        });
      }

      return reply.code(result.replayed ? 200 : 202).send({
        message: result.replayed ? 'intent_replayed' : 'intent_queued',
        replayed: result.replayed,
        intent: result.intent,
      });
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  app.get('/trade-intents/:intentId', async (request, reply) => {
    const { intentId } = request.params as { intentId: string };
    const intent = deps.intentService.getById(intentId);
    if (!intent) {
      return reply.code(404).send(toErrorEnvelope(ErrorCode.IntentNotFound, 'Trade intent not found.'));
    }
    return intent;
  });

  app.get('/executions', async (request) => {
    const query = request.query as { agentId?: string; limit?: string };
    const limit = Math.min(Number(query.limit ?? 50), 200);

    const executions = Object.values(deps.store.snapshot().executions)
      .filter((ex) => (query.agentId ? ex.agentId === query.agentId : true))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);

    return {
      executions,
    };
  });

  app.get('/executions/:id/receipt', async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = request.query as { redacted?: string };
    const receipt = deps.executionService.getReceiptByExecutionId(id);
    if (!receipt) {
      return reply.code(404).send(toErrorEnvelope(ErrorCode.ReceiptNotFound, 'Execution receipt not found.'));
    }

    if (query.redacted === 'true') {
      return {
        executionId: id,
        receipt: redactReceipt(receipt),
      };
    }

    return {
      executionId: id,
      receipt,
    };
  });

  app.get('/receipts/verify/:executionId', async (request, reply) => {
    const { executionId } = request.params as { executionId: string };
    const verification = deps.executionService.verifyReceipt(executionId);

    if (!verification) {
      return reply.code(404).send(toErrorEnvelope(ErrorCode.ExecutionNotFound, 'Execution or receipt not found.'));
    }

    return verification;
  });

  app.post('/market/prices', async (request, reply) => {
    const parse = marketUpdateSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.code(400).send(toErrorEnvelope(
        ErrorCode.InvalidPayload,
        'Invalid request payload.',
        parse.error.flatten(),
      ));
    }

    const normalizedSymbol = parse.data.symbol.toUpperCase();
    await deps.executionService.setMarketPrice(normalizedSymbol, parse.data.priceUsd);

    eventBus.emit('price.updated', {
      symbol: normalizedSymbol,
      priceUsd: parse.data.priceUsd,
    });

    return {
      ok: true,
      marketPricesUsd: deps.executionService.getMarketPrices(),
    };
  });

  app.get('/health', async () => {
    const state = deps.store.snapshot();
    const runtime = deps.getRuntimeMetrics();

    return {
      status: 'ok',
      env: deps.config.app.env,
      uptimeSeconds: runtime.uptimeSeconds,
      pendingIntents: runtime.pendingIntents,
      processPid: runtime.processPid,
      defaultMode: deps.config.trading.defaultMode,
      liveModeEnabled: deps.config.trading.liveEnabled,
      wsClients: connectedClients(),
      stateSummary: {
        agents: Object.keys(state.agents).length,
        intents: Object.keys(state.tradeIntents).length,
        executions: Object.keys(state.executions).length,
        receipts: Object.keys(state.executionReceipts).length,
      },
    };
  });

  app.get('/metrics', async () => {
    const state = deps.store.snapshot();
    const runtime = deps.getRuntimeMetrics();

    return {
      runtime,
      metrics: state.metrics,
      treasury: state.treasury,
      monetization: {
        ...deps.feeEngine.describeMonetizationModel(),
        x402PolicyVersion: deps.x402Policy.version,
        paidEndpoints: deps.x402Policy.paidEndpoints,
      },
    };
  });

  // ─── Autonomous loop endpoints ───────────────────────────────────────

  app.get('/autonomous/status', async () => deps.autonomousService.getStatus());

  const autonomousToggleSchema = z.object({
    enabled: z.boolean(),
  });

  app.post('/autonomous/toggle', async (request, reply) => {
    const parse = autonomousToggleSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.code(400).send(toErrorEnvelope(
        ErrorCode.InvalidPayload,
        'Invalid request payload.',
        parse.error.flatten(),
      ));
    }

    try {
      const status = await deps.autonomousService.toggle(parse.data.enabled);
      return { ok: true, autonomous: status };
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  // ─── Arbitrage endpoints ──────────────────────────────────────────────

  app.get('/arbitrage/opportunities', async () => ({
    opportunities: deps.arbitrageService.getOpportunities(),
  }));

  app.get('/arbitrage/status', async () => deps.arbitrageService.getStatus());

  // ─── Lending monitor endpoints ─────────────────────────────────────────

  const registerPositionSchema = z.object({
    agentId: z.string().min(2),
    protocol: z.enum(['kamino', 'marginfi', 'solend']),
    market: z.string().min(1).max(120),
    suppliedUsd: z.number().nonnegative(),
    borrowedUsd: z.number().nonnegative(),
    healthFactor: z.number().nonnegative(),
    ltv: z.number().min(0).max(1),
    wallet: z.string().min(1).max(120),
  });

  app.get('/lending/positions', async () => ({
    positions: deps.lendingMonitorService.getPositions(),
  }));

  app.get('/lending/alerts', async () => ({
    alerts: deps.lendingMonitorService.getAlerts(),
  }));

  app.post('/lending/positions', async (request, reply) => {
    const parse = registerPositionSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.code(400).send(toErrorEnvelope(
        ErrorCode.InvalidPayload,
        'Invalid request payload.',
        parse.error.flatten(),
      ));
    }

    try {
      const position = await deps.lendingMonitorService.registerPosition(parse.data);
      return reply.code(201).send({ position });
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  // ─── Privacy endpoints ────────────────────────────────────────────────

  app.get('/privacy/policy', async () => ({
    encryptionEnabled: deps.config.privacy.encryptionEnabled,
    algorithm: 'aes-256-gcm',
    keyDerivation: 'hkdf-sha256(agentApiKey + serverSecret)',
    redactedReceipts: true,
    description: 'Trade intents can be encrypted before storage. Receipts can be requested in redacted form hiding exact amounts and prices while preserving hash-chain integrity.',
  }));

  // ─── Skills endpoints ─────────────────────────────────────────────────

  // Note: GET /skills is registered below with marketplace filtering support

  app.get('/agents/:agentId/skills', async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    const agent = deps.agentService.getById(agentId);
    if (!agent) {
      return reply.code(404).send(toErrorEnvelope(ErrorCode.AgentNotFound, 'Agent not found.'));
    }

    return {
      agentId,
      skills: deps.skillRegistry.getAgentSkills(agentId),
    };
  });

  // ─── Squad / Coordination endpoints ────────────────────────────────

  const createSquadSchema = z.object({
    name: z.string().min(2).max(120),
    leaderId: z.string().min(2),
    sharedLimits: z.object({
      maxSquadExposureUsd: z.number().positive().optional(),
      maxMemberPositionPct: z.number().positive().max(1).optional(),
    }).optional(),
  });

  app.post('/squads', async (request, reply) => {
    const parse = createSquadSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.code(400).send(toErrorEnvelope(
        ErrorCode.InvalidPayload,
        'Invalid request payload.',
        parse.error.flatten(),
      ));
    }

    try {
      const squad = deps.coordinationService.createSquad(parse.data);
      return reply.code(201).send({ squad });
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  app.get('/squads', async () => ({
    squads: deps.coordinationService.listSquads(),
  }));

  app.get('/squads/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const squad = deps.coordinationService.getSquad(id);
    if (!squad) {
      return reply.code(404).send(toErrorEnvelope(ErrorCode.SquadNotFound, 'Squad not found.'));
    }
    return { squad };
  });

  const joinSquadSchema = z.object({
    agentId: z.string().min(2),
  });

  app.post('/squads/:id/join', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parse = joinSquadSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.code(400).send(toErrorEnvelope(
        ErrorCode.InvalidPayload,
        'Invalid request payload.',
        parse.error.flatten(),
      ));
    }

    try {
      const squad = deps.coordinationService.joinSquad(id, parse.data);
      return { squad };
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  app.get('/squads/:id/positions', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const positions = deps.coordinationService.getSquadPositions(id);
      return { squadId: id, positions };
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  // ─── Analytics endpoint ────────────────────────────────────────────

  app.get('/agents/:agentId/analytics', async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    const analytics = deps.analyticsService.computeAnalytics(agentId);
    if (!analytics) {
      return reply.code(404).send(toErrorEnvelope(ErrorCode.AgentNotFound, 'Agent not found.'));
    }
    return analytics;
  });

  // ─── Simulation endpoint ─────────────────────────────────────────────

  app.post('/simulate', async (request, reply) => {
    const parse = simulateSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.code(400).send(toErrorEnvelope(
        ErrorCode.InvalidPayload,
        'Invalid simulation payload.',
        parse.error.flatten(),
      ));
    }

    try {
      const result = deps.simulationService.simulate({
        ...parse.data,
        symbol: parse.data.symbol.toUpperCase(),
      });

      await deps.store.transaction((state) => {
        state.metrics.simulationsRun += 1;
        return undefined;
      });

      return result;
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  // ─── Pipeline introspection endpoint ───────────────────────────────────

  app.get('/executions/:id/pipeline', async (request, reply) => {
    const { id } = request.params as { id: string };
    const pipeline = deps.stagedPipeline.getPipeline(id);

    if (!pipeline) {
      return reply.code(404).send(toErrorEnvelope(
        ErrorCode.PipelineNotFound,
        'Execution pipeline not found.',
      ));
    }

    return { pipeline };
  });

  // ─── Webhook delivery history endpoint ─────────────────────────────────

  app.get('/agents/:agentId/webhook-deliveries', async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    const agent = deps.agentService.getById(agentId);
    if (!agent) {
      return reply.code(404).send(toErrorEnvelope(ErrorCode.AgentNotFound, 'Agent not found.'));
    }

    const query = request.query as { limit?: string };
    const limit = Math.min(Math.max(Number(query.limit ?? 50), 1), 200);

    return {
      agentId,
      deliveries: deps.webhookService.getDeliveries(agentId, limit),
    };
  });

  // ─── Rate limiter metrics endpoint ─────────────────────────────────────

  app.get('/rate-limit/metrics', async () => deps.rateLimiter.getMetrics());

  // ─── Pipeline stage metrics endpoint ───────────────────────────────────

  app.get('/pipeline/metrics', async () => deps.stagedPipeline.getGlobalStageMetrics());

  // ─── Reputation endpoints ────────────────────────────────────────────

  app.get('/agents/:agentId/reputation', async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    const reputation = deps.reputationService.calculate(agentId);
    if (!reputation) {
      return reply.code(404).send(toErrorEnvelope(ErrorCode.AgentNotFound, 'Agent not found.'));
    }
    return reputation;
  });

  app.get('/reputation/leaderboard', async (request) => {
    const query = request.query as { limit?: string };
    const limit = Math.min(Math.max(Number(query.limit ?? 50), 1), 200);
    return deps.reputationService.leaderboard(limit);
  });

  // ─── On-chain proof anchoring endpoints ─────────────────────────────

  app.get('/proofs/anchors', async (request) => {
    const query = request.query as { limit?: string };
    const limit = Math.min(Math.max(Number(query.limit ?? 50), 1), 200);
    return { anchors: deps.proofAnchorService.listAnchors(limit) };
  });

  app.post('/proofs/anchor', async (_request, reply) => {
    try {
      const anchor = await deps.proofAnchorService.createAnchor();
      if (!anchor) {
        return { message: 'no_new_receipts', anchor: null };
      }
      return reply.code(201).send({ anchor });
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  app.get('/proofs/verify/:receiptId', async (request, reply) => {
    const { receiptId } = request.params as { receiptId: string };
    const proof = deps.proofAnchorService.verifyReceipt(receiptId);
    if (!proof) {
      return reply.code(404).send(toErrorEnvelope(ErrorCode.ProofNotFound, 'Receipt not found in any proof anchor.'));
    }
    return proof;
  });

  // ─── Governance endpoints ──────────────────────────────────────────

  const createProposalSchema = z.object({
    proposerId: z.string().min(2),
    type: z.enum(['strategy_change', 'risk_parameter', 'fee_adjustment', 'general']),
    title: z.string().min(2).max(200),
    description: z.string().min(2).max(2000),
    params: z.record(z.string(), z.unknown()),
    expiresInMs: z.number().positive().optional(),
  });

  app.post('/governance/proposals', async (request, reply) => {
    const parse = createProposalSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.code(400).send(toErrorEnvelope(
        ErrorCode.InvalidPayload,
        'Invalid proposal payload.',
        parse.error.flatten(),
      ));
    }

    try {
      const proposal = deps.governanceService.createProposal(parse.data);
      return reply.code(201).send({ proposal });
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  const castVoteSchema = z.object({
    agentId: z.string().min(2),
    value: z.enum(['for', 'against']),
  });

  app.post('/governance/proposals/:id/vote', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parse = castVoteSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.code(400).send(toErrorEnvelope(
        ErrorCode.InvalidPayload,
        'Invalid vote payload.',
        parse.error.flatten(),
      ));
    }

    try {
      const proposal = deps.governanceService.vote(id, parse.data);
      return { proposal };
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  app.get('/governance/proposals', async (request) => {
    const query = request.query as { status?: string };
    const validStatuses = ['active', 'approved', 'rejected', 'expired'];
    const statusFilter = query.status && validStatuses.includes(query.status)
      ? query.status as 'active' | 'approved' | 'rejected' | 'expired'
      : undefined;

    return { proposals: deps.governanceService.listProposals(statusFilter) };
  });

  // ─── Order Book endpoints ──────────────────────────────────────────

  app.get('/orderbook/:symbol', async (request) => {
    const { symbol } = request.params as { symbol: string };
    return deps.orderBookService.getDepth(symbol);
  });

  app.get('/orderbook/flow', async () => deps.orderBookService.getFlow());

  // ─── Backtest endpoint ────────────────────────────────────────────

  const backtestSchema = z.object({
    strategyId: z.string().min(1),
    symbol: z.string().min(2).max(20),
    priceHistory: z.array(z.number()),
    startingCapitalUsd: z.number().positive(),
    riskOverrides: z.object({
      maxPositionSizePct: z.number().positive().max(1).optional(),
      maxOrderNotionalUsd: z.number().positive().optional(),
      maxGrossExposureUsd: z.number().positive().optional(),
      dailyLossCapUsd: z.number().positive().optional(),
      maxDrawdownPct: z.number().positive().max(1).optional(),
      cooldownSeconds: z.number().nonnegative().optional(),
    }).partial().optional(),
  });

  app.post('/backtest', async (request, reply) => {
    const parse = backtestSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.code(400).send(toErrorEnvelope(
        ErrorCode.InvalidPayload,
        'Invalid backtest payload.',
        parse.error.flatten(),
      ));
    }

    try {
      const result = deps.backtestService.run(parse.data);
      return result;
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  // ─── Marketplace endpoints ────────────────────────────────────────

  const createListingSchema = z.object({
    agentId: z.string().min(2),
    strategyId: z.string().min(1),
    description: z.string().min(2).max(2000),
    performanceStats: z.object({
      totalReturnPct: z.number(),
      maxDrawdownPct: z.number(),
      sharpeRatio: z.number(),
      tradeCount: z.number().int().nonnegative(),
      winRate: z.number().min(0).max(100),
    }),
    fee: z.number().nonnegative(),
  });

  app.post('/marketplace/listings', async (request, reply) => {
    const parse = createListingSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.code(400).send(toErrorEnvelope(
        ErrorCode.InvalidPayload,
        'Invalid listing payload.',
        parse.error.flatten(),
      ));
    }

    try {
      const listing = deps.marketplaceService.createListing(parse.data);
      return reply.code(201).send({ listing });
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  app.get('/marketplace/listings', async () => ({
    listings: deps.marketplaceService.listAll(),
  }));

  app.get('/marketplace/listings/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const listing = deps.marketplaceService.getListingWithStats(id);
    if (!listing) {
      return reply.code(404).send(toErrorEnvelope(ErrorCode.ListingNotFound, 'Listing not found.'));
    }
    return { listing };
  });

  const subscribeSchema = z.object({
    subscriberId: z.string().min(2),
  });

  app.post('/marketplace/listings/:id/subscribe', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parse = subscribeSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.code(400).send(toErrorEnvelope(
        ErrorCode.InvalidPayload,
        'Invalid subscribe payload.',
        parse.error.flatten(),
      ));
    }

    try {
      const subscription = deps.marketplaceService.subscribe(id, parse.data.subscriberId);
      return reply.code(201).send({ subscription });
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  // ─── Advanced Orders endpoints ──────────────────────────────────────

  const limitOrderSchema = z.object({
    agentId: z.string().min(2),
    symbol: z.string().min(2).max(20),
    side: z.enum(['buy', 'sell']),
    price: z.number().positive(),
    notionalUsd: z.number().positive(),
    expiry: z.string().datetime().optional(),
  });

  app.post('/orders/limit', async (request, reply) => {
    const parse = limitOrderSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.code(400).send(toErrorEnvelope(
        ErrorCode.InvalidPayload,
        'Invalid limit order payload.',
        parse.error.flatten(),
      ));
    }

    try {
      const order = deps.advancedOrderService.placeLimitOrder(parse.data);
      return reply.code(201).send({ order });
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  const stopLossSchema = z.object({
    agentId: z.string().min(2),
    symbol: z.string().min(2).max(20),
    triggerPrice: z.number().positive(),
    notionalUsd: z.number().positive(),
  });

  app.post('/orders/stop-loss', async (request, reply) => {
    const parse = stopLossSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.code(400).send(toErrorEnvelope(
        ErrorCode.InvalidPayload,
        'Invalid stop-loss payload.',
        parse.error.flatten(),
      ));
    }

    try {
      const order = deps.advancedOrderService.placeStopLoss(parse.data);
      return reply.code(201).send({ order });
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  app.get('/orders/:agentId', async (request) => {
    const { agentId } = request.params as { agentId: string };
    return deps.advancedOrderService.getOrders(agentId);
  });

  app.delete('/orders/:orderId', async (request, reply) => {
    const { orderId } = request.params as { orderId: string };
    try {
      const result = deps.advancedOrderService.cancelOrder(orderId);
      return result;
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  // ─── Messaging endpoints ──────────────────────────────────────────

  const sendMessageSchema = z.object({
    from: z.string().min(2),
    to: z.string().min(2),
    type: z.enum(['trade-signal', 'risk-alert', 'strategy-update', 'general']),
    payload: z.record(z.string(), z.unknown()),
  });

  app.post('/messages', async (request, reply) => {
    const parse = sendMessageSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.code(400).send(toErrorEnvelope(
        ErrorCode.InvalidPayload,
        'Invalid message payload.',
        parse.error.flatten(),
      ));
    }

    try {
      const message = deps.messagingService.sendMessage(parse.data);
      return reply.code(201).send({ message });
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  app.get('/messages/:agentId', async (request) => {
    const { agentId } = request.params as { agentId: string };
    const query = request.query as { limit?: string };
    const limit = Math.min(Math.max(Number(query.limit ?? 50), 1), 200);
    return { messages: deps.messagingService.getInbox(agentId, limit) };
  });

  const squadMessageSchema = z.object({
    from: z.string().min(2),
    type: z.enum(['trade-signal', 'risk-alert', 'strategy-update', 'general']),
    payload: z.record(z.string(), z.unknown()),
  });

  app.post('/squads/:id/messages', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parse = squadMessageSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.code(400).send(toErrorEnvelope(
        ErrorCode.InvalidPayload,
        'Invalid squad message payload.',
        parse.error.flatten(),
      ));
    }

    try {
      const message = deps.messagingService.broadcastToSquad({
        ...parse.data,
        squadId: id,
      });
      return reply.code(201).send({ message });
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  app.get('/squads/:id/messages', async (request) => {
    const { id } = request.params as { id: string };
    const query = request.query as { limit?: string };
    const limit = Math.min(Math.max(Number(query.limit ?? 50), 1), 200);
    return { messages: deps.messagingService.getSquadMessages(id, limit) };
  });

  // ─── MEV Protection endpoints ─────────────────────────────────────

  const mevAnalyzeSchema = z.object({
    symbol: z.string().min(2).max(20),
    side: z.enum(['buy', 'sell']),
    notionalUsd: z.number().positive(),
    slippageTolerance: z.number().min(0).max(1).optional(),
    poolLiquidityUsd: z.number().positive().optional(),
    recentPoolTxCount: z.number().nonnegative().int().optional(),
  });

  app.post('/mev/analyze', async (request, reply) => {
    const parse = mevAnalyzeSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.code(400).send(toErrorEnvelope(
        ErrorCode.InvalidPayload,
        'Invalid MEV analysis payload.',
        parse.error.flatten(),
      ));
    }

    try {
      const report = deps.mevProtectionService.analyze(parse.data);
      return { report };
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  app.get('/mev/stats', async () => deps.mevProtectionService.getMevStats());

  // ─── Journal endpoints ─────────────────────────────────────────────

  app.get('/agents/:agentId/journal', async (request) => {
    const { agentId } = request.params as { agentId: string };
    const query = request.query as { type?: string; limit?: string; offset?: string };

    const opts: { type?: string; limit?: number; offset?: number } = {};
    if (query.type) opts.type = query.type;
    if (query.limit) opts.limit = Number(query.limit);
    if (query.offset) opts.offset = Number(query.offset);

    const result = deps.journalService.getJournal(agentId, opts as any);
    return result;
  });

  app.get('/agents/:agentId/journal/stats', async (request) => {
    const { agentId } = request.params as { agentId: string };
    return deps.journalService.getJournalStats(agentId);
  });

  app.get('/agents/:agentId/journal/export', async (request) => {
    const { agentId } = request.params as { agentId: string };
    return { entries: deps.journalService.exportJournal(agentId) };
  });

  // ─── Strategy Comparison endpoints ────────────────────────────────

  const strategyCompareSchema = z.object({
    strategyIds: z.array(z.string().min(1)).min(2),
    priceHistory: z.array(z.number()).min(2),
    capitalUsd: z.number().positive(),
  });

  app.post('/strategies/compare', async (request, reply) => {
    const parse = strategyCompareSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.code(400).send(toErrorEnvelope(
        ErrorCode.InvalidPayload,
        'Invalid comparison payload.',
        parse.error.flatten(),
      ));
    }

    try {
      const result = deps.strategyCompareService.compareStrategies(parse.data);
      return result;
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  // ─── Price Oracle endpoints ─────────────────────────────────────────

  app.get('/oracle/prices', async () => ({
    prices: deps.priceOracleService.getAllPrices(),
  }));

  app.get('/oracle/prices/:symbol', async (request) => {
    const { symbol } = request.params as { symbol: string };
    const query = request.query as { limit?: string };
    const limit = query.limit ? Math.min(Math.max(Number(query.limit), 1), 100) : undefined;
    const price = deps.priceOracleService.getCurrentPrice(symbol);
    return {
      price,
      history: deps.priceOracleService.getPriceHistory(symbol, limit),
    };
  });

  app.get('/oracle/status', async () => deps.priceOracleService.getOracleStatus());

  // ─── Pyth Oracle endpoints ────────────────────────────────────────────

  const pythStartSchema = z.object({
    symbols: z.array(z.string().min(1).max(10)).min(1).max(20),
    intervalMs: z.number().int().min(1000).max(600_000).optional(),
  });

  app.get('/oracle/pyth/prices', async () => ({
    prices: deps.pythOracleService.getAllPrices(),
    supportedSymbols: PythOracleService.getSupportedSymbols(),
  }));

  app.post('/oracle/pyth/start', async (request, reply) => {
    const parse = pythStartSchema.safeParse(request.body);
    if (!parse.success) return reply.status(400).send({ error: parse.error.flatten() });

    try {
      await deps.pythOracleService.startPythFeed(parse.data.symbols, parse.data.intervalMs);
      return { ok: true, status: deps.pythOracleService.getPythStatus() };
    } catch (err) {
      return reply.status(400).send({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.post('/oracle/pyth/stop', async () => {
    deps.pythOracleService.stopPythFeed();
    return { ok: true, status: deps.pythOracleService.getPythStatus() };
  });

  app.get('/oracle/pyth/status', async () => deps.pythOracleService.getPythStatus());

  // ─── Rebalance endpoints ──────────────────────────────────────────────

  const targetAllocationSchema = z.object({
    allocations: z.record(z.string(), z.number().min(0).max(1)),
  });

  app.post('/agents/:agentId/rebalance/target', async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    const parse = targetAllocationSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.code(400).send(toErrorEnvelope(
        ErrorCode.InvalidPayload,
        'Invalid target allocation payload.',
        parse.error.flatten(),
      ));
    }

    try {
      const allocation = deps.rebalanceService.setTargetAllocation(agentId, parse.data.allocations);
      return { agentId, allocation };
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  app.get('/agents/:agentId/rebalance/status', async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    try {
      return deps.rebalanceService.getRebalanceStatus(agentId);
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  app.post('/agents/:agentId/rebalance/execute', async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    try {
      return deps.rebalanceService.executeRebalance(agentId);
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  // ─── Alert endpoints ──────────────────────────────────────────────────

  const createAlertSchema = z.object({
    agentId: z.string().min(2),
    type: z.enum(['price-above', 'price-below', 'drawdown-exceeded', 'execution-completed', 'risk-breach']),
    config: z.object({
      symbol: z.string().min(1).optional(),
      priceUsd: z.number().positive().optional(),
      drawdownPct: z.number().min(0).max(1).optional(),
      executionId: z.string().min(1).optional(),
      riskMetric: z.string().min(1).optional(),
      riskThreshold: z.number().optional(),
    }),
  });

  app.post('/alerts', async (request, reply) => {
    const parse = createAlertSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.code(400).send(toErrorEnvelope(
        ErrorCode.InvalidPayload,
        'Invalid alert payload.',
        parse.error.flatten(),
      ));
    }

    try {
      const alert = deps.alertService.createAlert(
        parse.data.agentId,
        parse.data.type,
        parse.data.config,
      );
      return reply.code(201).send({ alert });
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  app.get('/alerts/:agentId', async (request) => {
    const { agentId } = request.params as { agentId: string };
    return { alerts: deps.alertService.getAlerts(agentId) };
  });

  app.delete('/alerts/:alertId', async (request, reply) => {
    const { alertId } = request.params as { alertId: string };
    try {
      return deps.alertService.deleteAlert(alertId);
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  app.get('/alerts/:agentId/history', async (request) => {
    const { agentId } = request.params as { agentId: string };
    return { history: deps.alertService.getHistory(agentId) };
  });

  // ─── Copy Trading endpoints ──────────────────────────────────────────

  const followAgentSchema = z.object({
    targetAgentId: z.string().min(2),
    copyRatio: z.number().min(0.1).max(1.0),
    maxNotionalUsd: z.number().positive(),
  });

  app.post('/agents/:agentId/follow', async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    const parse = followAgentSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.code(400).send(toErrorEnvelope(
        ErrorCode.InvalidPayload,
        'Invalid follow payload.',
        parse.error.flatten(),
      ));
    }

    try {
      const relation = deps.copyTradingService.followAgent(
        agentId,
        parse.data.targetAgentId,
        { copyRatio: parse.data.copyRatio, maxNotionalUsd: parse.data.maxNotionalUsd },
      );
      return reply.code(201).send({ relation });
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  app.delete('/agents/:agentId/follow/:targetId', async (request, reply) => {
    const { agentId, targetId } = request.params as { agentId: string; targetId: string };
    try {
      const result = deps.copyTradingService.unfollowAgent(agentId, targetId);
      return result;
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  app.get('/agents/:agentId/followers', async (request) => {
    const { agentId } = request.params as { agentId: string };
    return { followers: deps.copyTradingService.getFollowers(agentId) };
  });

  app.get('/agents/:agentId/following', async (request) => {
    const { agentId } = request.params as { agentId: string };
    return { following: deps.copyTradingService.getFollowing(agentId) };
  });

  // ─── Credit Rating endpoints ──────────────────────────────────────────

  app.get('/agents/:agentId/credit-rating', async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    const rating = deps.creditRatingService.getRatingBreakdown(agentId);
    if (!rating) {
      return reply.code(404).send(toErrorEnvelope(ErrorCode.AgentNotFound, 'Agent not found.'));
    }
    return rating;
  });

  app.get('/credit-ratings', async () => deps.creditRatingService.getAllRatings());

  // ─── Watchlist endpoints ──────────────────────────────────────────────

  const addWatchlistSchema = z.object({
    symbol: z.string().min(1).max(20),
    notes: z.string().max(500).optional(),
  });

  app.post('/agents/:agentId/watchlist', async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    const parse = addWatchlistSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.code(400).send(toErrorEnvelope(
        ErrorCode.InvalidPayload,
        'Invalid watchlist payload.',
        parse.error.flatten(),
      ));
    }

    try {
      const entry = deps.watchlistService.addToWatchlist(agentId, parse.data.symbol, parse.data.notes);
      return reply.code(201).send({ entry });
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  app.delete('/agents/:agentId/watchlist/:symbol', async (request, reply) => {
    const { agentId, symbol } = request.params as { agentId: string; symbol: string };
    try {
      return deps.watchlistService.removeFromWatchlist(agentId, symbol);
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  app.get('/agents/:agentId/watchlist', async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    try {
      return { watchlist: deps.watchlistService.getWatchlist(agentId) };
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  app.get('/watchlist/trending', async () => ({
    trending: deps.watchlistService.getTrending(),
  }));

  // ─── Trade History endpoints ──────────────────────────────────────────

  app.get('/agents/:agentId/trades', async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    const query = request.query as {
      symbol?: string;
      side?: string;
      startDate?: string;
      endDate?: string;
      limit?: string;
      offset?: string;
    };

    try {
      return deps.tradeHistoryService.getTradeHistory(agentId, {
        symbol: query.symbol,
        side: query.side === 'buy' || query.side === 'sell' ? query.side : undefined,
        startDate: query.startDate,
        endDate: query.endDate,
        limit: query.limit ? Number(query.limit) : undefined,
        offset: query.offset ? Number(query.offset) : undefined,
      });
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  app.get('/agents/:agentId/performance', async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    try {
      return deps.tradeHistoryService.getPerformanceSummary(agentId);
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  app.get('/agents/:agentId/streaks', async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    try {
      return deps.tradeHistoryService.getStreaks(agentId);
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  // ─── Diagnostics endpoints ────────────────────────────────────────────

  app.get('/diagnostics/health', async () => deps.diagnosticsService.getSystemHealth());

  app.get('/diagnostics/services', async () => ({
    services: deps.diagnosticsService.getServiceStatus(),
  }));

  app.get('/diagnostics/errors', async (request) => {
    const query = request.query as { limit?: string };
    const limit = query.limit ? Number(query.limit) : undefined;
    return { errors: deps.diagnosticsService.getErrorLog(limit) };
  });

  app.post('/diagnostics/self-test', async () => deps.diagnosticsService.runSelfTest());

  // ─── Self-Improving System endpoints ─────────────────────────────────

  app.post('/agents/:agentId/improve/analyze', async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    try {
      const analysis = deps.selfImproveService.analyzePerformance(agentId);
      return analysis;
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  app.get('/agents/:agentId/improve/recommendations', async (request) => {
    const { agentId } = request.params as { agentId: string };
    return { recommendations: deps.selfImproveService.getRecommendations(agentId) };
  });

  app.post('/agents/:agentId/improve/apply/:recId', async (request, reply) => {
    const { agentId, recId } = request.params as { agentId: string; recId: string };
    try {
      const record = await deps.selfImproveService.applyRecommendation(agentId, recId);
      return { improvement: record };
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  app.post('/agents/:agentId/improve/cycle', async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    try {
      const cycle = await deps.improvementLoopService.runImprovementCycle(agentId);
      return { cycle };
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  app.get('/agents/:agentId/improve/history', async (request) => {
    const { agentId } = request.params as { agentId: string };
    return { history: deps.selfImproveService.getImprovementHistory(agentId) };
  });

  app.get('/agents/:agentId/improve/status', async (request) => {
    const { agentId } = request.params as { agentId: string };
    return deps.improvementLoopService.getLoopStatus(agentId);
  });

  app.get('/agents/:agentId/inference/budget', async (request) => {
    const { agentId } = request.params as { agentId: string };
    return deps.inferenceBudgetService.getInferenceBudget(agentId);
  });

  app.get('/agents/:agentId/inference/history', async (request) => {
    const { agentId } = request.params as { agentId: string };
    return { history: deps.inferenceBudgetService.getInferenceHistory(agentId) };
  });

  app.get('/agents/:agentId/inference/roi', async (request) => {
    const { agentId } = request.params as { agentId: string };
    return deps.inferenceBudgetService.getROI(agentId);
  });

  // ─── Tournament endpoints ──────────────────────────────────────────

  const createTournamentSchema = z.object({
    name: z.string().min(2).max(200),
    strategyIds: z.array(z.string().min(1)).min(2),
    symbol: z.string().min(2).max(20).optional(),
    priceHistory: z.array(z.number()).min(2),
    startingCapitalUsd: z.number().positive(),
  });

  app.post('/tournaments', async (request, reply) => {
    const parse = createTournamentSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.code(400).send(toErrorEnvelope(
        ErrorCode.InvalidPayload,
        'Invalid tournament payload.',
        parse.error.flatten(),
      ));
    }

    try {
      const tournament = await deps.tournamentService.createTournament(parse.data);
      return reply.code(201).send({ tournament });
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  app.post('/tournaments/:id/run', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const tournament = await deps.tournamentService.runTournament(id);
      return { tournament };
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  app.get('/tournaments/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const tournament = deps.tournamentService.getTournamentResults(id);
    if (!tournament) {
      return reply.code(404).send(toErrorEnvelope(ErrorCode.TournamentNotFound, 'Tournament not found.'));
    }
    return { tournament };
  });

  app.get('/tournaments', async () => ({
    tournaments: deps.tournamentService.listTournaments(),
  }));

  // ─── Social Trading endpoints ─────────────────────────────────────

  app.post('/agents/:agentId/social/follow/:targetId', async (request, reply) => {
    const { agentId, targetId } = request.params as { agentId: string; targetId: string };
    try {
      const relation = deps.socialTradingService.followAgent(agentId, targetId);
      return reply.code(201).send({ relation });
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  app.delete('/agents/:agentId/social/follow/:targetId', async (request, reply) => {
    const { agentId, targetId } = request.params as { agentId: string; targetId: string };
    try {
      const result = deps.socialTradingService.unfollowAgent(agentId, targetId);
      return result;
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  app.get('/agents/:agentId/social/followers', async (request) => {
    const { agentId } = request.params as { agentId: string };
    return { followers: deps.socialTradingService.getFollowers(agentId) };
  });

  app.get('/agents/:agentId/social/following', async (request) => {
    const { agentId } = request.params as { agentId: string };
    return { following: deps.socialTradingService.getFollowing(agentId) };
  });

  app.get('/agents/:agentId/social/feed', async (request) => {
    const { agentId } = request.params as { agentId: string };
    const query = request.query as { limit?: string };
    const limit = query.limit ? Math.min(Math.max(Number(query.limit), 1), 200) : 50;
    return { feed: deps.socialTradingService.getFeed(agentId, limit) };
  });

  // ─── Notification / Webhook Subscription endpoints ──────────────────────

  app.post('/agents/:agentId/notifications/subscribe', async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    const parse = notificationSubscribeSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.code(400).send(toErrorEnvelope(
        ErrorCode.InvalidPayload,
        'Invalid subscription payload.',
        parse.error.flatten(),
      ));
    }

    try {
      const subscription = deps.notificationService.subscribe(
        agentId,
        parse.data.eventType,
        parse.data.webhookUrl,
      );
      return reply.code(201).send({ subscription });
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  app.delete('/agents/:agentId/notifications/:subId', async (request, reply) => {
    const { agentId, subId } = request.params as { agentId: string; subId: string };
    try {
      return deps.notificationService.unsubscribe(agentId, subId);
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  app.get('/agents/:agentId/notifications', async (request) => {
    const { agentId } = request.params as { agentId: string };
    return {
      subscriptions: deps.notificationService.listSubscriptions(agentId),
      stats: deps.notificationService.getDeliveryStats(agentId),
    };
  });

  app.get('/agents/:agentId/notifications/log', async (request) => {
    const { agentId } = request.params as { agentId: string };
    const query = request.query as { limit?: string };
    const limit = query.limit ? Math.min(Math.max(Number(query.limit), 1), 200) : 50;
    return { deliveries: deps.notificationService.getDeliveryLog(agentId, limit) };
  });

  // ─── Sentiment Analysis endpoints ─────────────────────────────────────

  app.get('/sentiment/:symbol', async (request) => {
    const { symbol } = request.params as { symbol: string };
    return deps.sentimentService.analyzeSentiment(symbol);
  });

  app.get('/sentiment/:symbol/history', async (request) => {
    const { symbol } = request.params as { symbol: string };
    const query = request.query as { limit?: string };
    const limit = query.limit ? Math.min(Math.max(Number(query.limit), 1), 500) : 50;
    return { history: deps.sentimentService.getSentimentHistory(symbol, limit) };
  });

  app.get('/sentiment/overview', async () => ({
    overview: deps.sentimentService.getOverview(),
  }));

  // ─── Benchmark endpoints ──────────────────────────────────────────────

  app.post('/agents/:agentId/benchmark', async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    try {
      const benchmark = deps.benchmarkService.runBenchmark(agentId);
      if (!benchmark) {
        return reply.code(404).send(toErrorEnvelope(ErrorCode.AgentNotFound, 'Agent not found.'));
      }
      return reply.code(201).send({ benchmark });
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  app.get('/agents/:agentId/report', async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    const report = deps.benchmarkService.getAgentReport(agentId);
    if (!report) {
      return reply.code(404).send(toErrorEnvelope(ErrorCode.AgentNotFound, 'Agent not found.'));
    }
    return report;
  });

  app.get('/benchmarks', async () => deps.benchmarkService.getSystemBenchmarks());

  // ─── Multi-Timeframe Analysis endpoints ────────────────────────────────

  const timeframeAnalyzeSchema = z.object({
    symbol: z.string().min(1).max(20),
    priceHistory: z.array(z.number()).min(1),
  });

  app.post('/analysis/timeframes', async (request, reply) => {
    const parse = timeframeAnalyzeSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.code(400).send(toErrorEnvelope(
        ErrorCode.InvalidPayload,
        'Invalid timeframe analysis payload.',
        parse.error.flatten(),
      ));
    }

    try {
      const analysis = deps.timeframeService.analyzeTimeframes(parse.data.symbol, parse.data.priceHistory);
      return reply.code(201).send({ analysis });
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  app.get('/analysis/timeframes/:symbol/signals', async (request, reply) => {
    const { symbol } = request.params as { symbol: string };
    const signals = deps.timeframeService.getTimeframeSignals(symbol);
    if (!signals) {
      return reply.code(404).send(toErrorEnvelope(ErrorCode.AgentNotFound, `No timeframe analysis found for ${symbol}.`));
    }
    return signals;
  });

  app.get('/analysis/timeframes/:symbol/alignment', async (request, reply) => {
    const { symbol } = request.params as { symbol: string };
    const alignment = deps.timeframeService.getTimeframeAlignment(symbol);
    if (!alignment) {
      return reply.code(404).send(toErrorEnvelope(ErrorCode.AgentNotFound, `No timeframe analysis found for ${symbol}.`));
    }
    return alignment;
  });

  // ─── Skills Marketplace V2 endpoints ────────────────────────────────

  const publishSkillSchema = z.object({
    agentId: z.string().min(2),
    name: z.string().min(2).max(200),
    description: z.string().min(2).max(2000),
    category: z.enum(['entry-signal', 'exit-signal', 'risk-management', 'position-sizing', 'timing', 'portfolio']),
    version: z.string().min(1).max(20).optional(),
    priceUsd: z.number().nonnegative(),
    tags: z.array(z.string().max(50)).max(20).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  });

  app.post('/skills/publish', async (request, reply) => {
    const parse = publishSkillSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.code(400).send(toErrorEnvelope(
        ErrorCode.InvalidPayload,
        'Invalid skill payload.',
        parse.error.flatten(),
      ));
    }

    try {
      const skill = deps.skillsMarketplaceService.publishSkill(parse.data.agentId, {
        name: parse.data.name,
        description: parse.data.description,
        category: parse.data.category,
        version: parse.data.version ?? '1.0.0',
        priceUsd: parse.data.priceUsd,
        tags: parse.data.tags ?? [],
        config: parse.data.config,
      });
      return reply.code(201).send({ skill });
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  app.get('/skills/marketplace', async (request) => {
    const query = request.query as {
      category?: string;
      minRating?: string;
      maxPrice?: string;
      tag?: string;
      search?: string;
      sortBy?: string;
      limit?: string;
      offset?: string;
    };

    const filters: Record<string, unknown> = {};
    if (query.category && SKILL_CATEGORIES.includes(query.category as any)) {
      filters.category = query.category;
    }
    if (query.minRating) filters.minRating = Number(query.minRating);
    if (query.maxPrice) filters.maxPrice = Number(query.maxPrice);
    if (query.tag) filters.tag = query.tag;
    if (query.search) filters.search = query.search;
    if (query.sortBy) filters.sortBy = query.sortBy;
    if (query.limit) filters.limit = Number(query.limit);
    if (query.offset) filters.offset = Number(query.offset);

    return { skills: deps.skillsMarketplaceService.listSkills(filters as any) };
  });

  const purchaseSkillSchema = z.object({
    buyerAgentId: z.string().min(2),
  });

  app.post('/skills/:id/purchase', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parse = purchaseSkillSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.code(400).send(toErrorEnvelope(
        ErrorCode.InvalidPayload,
        'Invalid purchase payload.',
        parse.error.flatten(),
      ));
    }

    try {
      const purchase = deps.skillsMarketplaceService.purchaseSkill(parse.data.buyerAgentId, id);
      return reply.code(201).send({ purchase });
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  const rateSkillSchema = z.object({
    agentId: z.string().min(2),
    rating: z.number().int().min(1).max(5),
    review: z.string().min(1).max(1000),
  });

  app.post('/skills/:id/rate', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parse = rateSkillSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.code(400).send(toErrorEnvelope(
        ErrorCode.InvalidPayload,
        'Invalid rating payload.',
        parse.error.flatten(),
      ));
    }

    try {
      const rating = deps.skillsMarketplaceService.rateSkill(
        parse.data.agentId,
        id,
        parse.data.rating,
        parse.data.review,
      );
      return reply.code(201).send({ rating });
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  app.get('/skills/:id/stats', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const stats = deps.skillsMarketplaceService.getSkillStats(id);
      return stats;
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  // ─── Execution Analytics Dashboard endpoints ──────────────────────────

  app.get('/agents/:agentId/analytics/timeline', async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    try {
      return deps.executionAnalyticsService.getExecutionTimeline(agentId);
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  app.get('/agents/:agentId/analytics/slippage', async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    try {
      return deps.executionAnalyticsService.getSlippageAnalysis(agentId);
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  app.get('/analytics/volume/:symbol', async (request) => {
    const { symbol } = request.params as { symbol: string };
    return deps.executionAnalyticsService.getVolumeProfile(symbol);
  });

  app.get('/agents/:agentId/analytics/quality', async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    try {
      return deps.executionAnalyticsService.getExecutionQuality(agentId);
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  app.get('/analytics/latency', async () =>
    deps.executionAnalyticsService.getLatencyMetrics(),
  );

  // ─── Collaboration endpoints ────────────────────────────────────────

  const proposeCollaborationSchema = z.object({
    initiatorId: z.string().min(2),
    targetId: z.string().min(2),
    terms: z.object({
      type: z.enum(['signal-sharing', 'co-trading', 'strategy-exchange']),
      durationMs: z.number().positive(),
      profitSplitPct: z.number().min(0).max(100),
    }),
  });

  app.post('/collaborations', async (request, reply) => {
    const parse = proposeCollaborationSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.code(400).send(toErrorEnvelope(
        ErrorCode.InvalidPayload,
        'Invalid collaboration payload.',
        parse.error.flatten(),
      ));
    }

    try {
      const collab = deps.collaborationService.proposeCollaboration(
        parse.data.initiatorId,
        parse.data.targetId,
        parse.data.terms,
      );
      return reply.code(201).send({ collaboration: collab });
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  const collabAgentSchema = z.object({
    agentId: z.string().min(2),
  });

  app.post('/collaborations/:id/accept', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parse = collabAgentSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.code(400).send(toErrorEnvelope(
        ErrorCode.InvalidPayload,
        'Invalid accept payload.',
        parse.error.flatten(),
      ));
    }

    try {
      const collab = deps.collaborationService.acceptCollaboration(id, parse.data.agentId);
      return { collaboration: collab };
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  app.post('/collaborations/:id/reject', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parse = collabAgentSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.code(400).send(toErrorEnvelope(
        ErrorCode.InvalidPayload,
        'Invalid reject payload.',
        parse.error.flatten(),
      ));
    }

    try {
      const collab = deps.collaborationService.rejectCollaboration(id, parse.data.agentId);
      return { collaboration: collab };
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  app.get('/collaborations', async (request) => {
    const query = request.query as { agentId?: string };
    if (query.agentId) {
      return { collaborations: deps.collaborationService.getActiveCollaborations(query.agentId) };
    }
    return { collaborations: [] };
  });

  const shareSignalSchema = z.object({
    symbol: z.string().min(1).max(20),
    side: z.enum(['buy', 'sell']),
    confidence: z.number().min(0).max(1),
    priceTarget: z.number().positive().optional(),
    notes: z.string().max(500).optional(),
  });

  app.post('/collaborations/:id/signals', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parse = shareSignalSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.code(400).send(toErrorEnvelope(
        ErrorCode.InvalidPayload,
        'Invalid signal payload.',
        parse.error.flatten(),
      ));
    }

    try {
      const signal = deps.collaborationService.shareSignal(id, parse.data);
      return reply.code(201).send({ signal });
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  app.get('/collaborations/:id/signals', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return { signals: deps.collaborationService.getSharedSignals(id) };
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  app.delete('/collaborations/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = request.query as { agentId?: string };
    if (!query.agentId) {
      return reply.code(400).send(toErrorEnvelope(
        ErrorCode.InvalidPayload,
        'agentId query parameter is required to terminate a collaboration.',
      ));
    }

    try {
      const collab = deps.collaborationService.terminateCollaboration(id, query.agentId);
      return { collaboration: collab };
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  // ─── Stress Test endpoints ────────────────────────────────────────────

  const runStressTestSchema = z.object({
    scenarios: z.array(z.string().min(1)).optional(),
  });

  app.post('/agents/:agentId/stress-test', async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    const parse = runStressTestSchema.safeParse(request.body ?? {});
    if (!parse.success) {
      return reply.code(400).send(toErrorEnvelope(
        ErrorCode.InvalidPayload,
        'Invalid stress test payload.',
        parse.error.flatten(),
      ));
    }

    try {
      const result = deps.stressTestService.runStressTest(agentId, parse.data.scenarios);
      return reply.code(201).send({ result });
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  app.get('/agents/:agentId/stress-test/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = deps.stressTestService.getStressTestResults(id);
    if (!result) {
      return reply.code(404).send(toErrorEnvelope(ErrorCode.StressTestNotFound, 'Stress test result not found.'));
    }
    return { result };
  });

  app.get('/stress-test/scenarios', async () => ({
    scenarios: deps.stressTestService.listScenarios(),
  }));

  // ─── DeFi Health Score endpoints ──────────────────────────────────────

  app.get('/agents/:agentId/health-score', async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    const breakdown = deps.defiHealthScoreService.getHealthScoreBreakdown(agentId);
    if (!breakdown) {
      return reply.code(404).send(toErrorEnvelope(ErrorCode.AgentNotFound, 'Agent not found.'));
    }
    return breakdown;
  });

  app.get('/agents/:agentId/health-score/history', async (request) => {
    const { agentId } = request.params as { agentId: string };
    const query = request.query as { limit?: string };
    const limit = query.limit ? Math.min(Math.max(Number(query.limit), 1), 500) : 50;
    return { agentId, history: deps.defiHealthScoreService.getHealthHistory(agentId, limit) };
  });

  // ─── Backtest V2 endpoints ──────────────────────────────────────────

  const backtestV2Schema = z.object({
    strategyId: z.string().min(1),
    symbol: z.string().min(2).max(20),
    priceHistory: z.array(z.number()),
    startingCapitalUsd: z.number().positive(),
    riskOverrides: z.object({
      maxPositionSizePct: z.number().positive().max(1).optional(),
      maxOrderNotionalUsd: z.number().positive().optional(),
      maxGrossExposureUsd: z.number().positive().optional(),
      dailyLossCapUsd: z.number().positive().optional(),
      maxDrawdownPct: z.number().positive().max(1).optional(),
      cooldownSeconds: z.number().nonnegative().optional(),
    }).partial().optional(),
  });

  app.post('/backtest/v2', async (request, reply) => {
    const parse = backtestV2Schema.safeParse(request.body);
    if (!parse.success) {
      return reply.code(400).send(toErrorEnvelope(
        ErrorCode.InvalidPayload,
        'Invalid backtest V2 payload.',
        parse.error.flatten(),
      ));
    }

    try {
      const result = deps.backtestV2Service.run(parse.data);
      return result;
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  const backtestV2OptimizeSchema = z.object({
    strategyId: z.string().min(1),
    symbol: z.string().min(2).max(20),
    priceHistory: z.array(z.number()),
    startingCapitalUsd: z.number().positive(),
    parameterRanges: z.array(z.object({
      name: z.string().min(1),
      min: z.number(),
      max: z.number(),
      step: z.number().positive(),
    })).min(1),
    optimizeFor: z.enum(['sharpe', 'return', 'calmar']).optional(),
    riskOverrides: z.object({
      maxPositionSizePct: z.number().positive().max(1).optional(),
      maxOrderNotionalUsd: z.number().positive().optional(),
      maxGrossExposureUsd: z.number().positive().optional(),
      dailyLossCapUsd: z.number().positive().optional(),
      maxDrawdownPct: z.number().positive().max(1).optional(),
      cooldownSeconds: z.number().nonnegative().optional(),
    }).partial().optional(),
  });

  app.post('/backtest/v2/optimize', async (request, reply) => {
    const parse = backtestV2OptimizeSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.code(400).send(toErrorEnvelope(
        ErrorCode.InvalidPayload,
        'Invalid optimization payload.',
        parse.error.flatten(),
      ));
    }

    try {
      const result = deps.backtestV2Service.optimize(parse.data);
      return result;
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  const backtestV2MonteCarloSchema = z.object({
    strategyId: z.string().min(1),
    symbol: z.string().min(2).max(20),
    priceHistory: z.array(z.number()),
    startingCapitalUsd: z.number().positive(),
    simulations: z.number().int().min(10).max(100_000).optional(),
    confidenceLevel: z.number().min(0.01).max(0.99).optional(),
    riskOverrides: z.object({
      maxPositionSizePct: z.number().positive().max(1).optional(),
      maxOrderNotionalUsd: z.number().positive().optional(),
      maxGrossExposureUsd: z.number().positive().optional(),
      dailyLossCapUsd: z.number().positive().optional(),
      maxDrawdownPct: z.number().positive().max(1).optional(),
      cooldownSeconds: z.number().nonnegative().optional(),
    }).partial().optional(),
  });

  app.post('/backtest/v2/monte-carlo', async (request, reply) => {
    const parse = backtestV2MonteCarloSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.code(400).send(toErrorEnvelope(
        ErrorCode.InvalidPayload,
        'Invalid Monte Carlo payload.',
        parse.error.flatten(),
      ));
    }

    try {
      const result = deps.backtestV2Service.monteCarlo(parse.data);
      return result;
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  const backtestV2CompareSchema = z.object({
    strategyA: z.object({
      strategyId: z.string().min(1),
      label: z.string().max(100).optional(),
    }),
    strategyB: z.object({
      strategyId: z.string().min(1),
      label: z.string().max(100).optional(),
    }),
    symbol: z.string().min(2).max(20),
    priceHistory: z.array(z.number()),
    startingCapitalUsd: z.number().positive(),
    riskOverrides: z.object({
      maxPositionSizePct: z.number().positive().max(1).optional(),
      maxOrderNotionalUsd: z.number().positive().optional(),
      maxGrossExposureUsd: z.number().positive().optional(),
      dailyLossCapUsd: z.number().positive().optional(),
      maxDrawdownPct: z.number().positive().max(1).optional(),
      cooldownSeconds: z.number().nonnegative().optional(),
    }).partial().optional(),
  });

  app.post('/backtest/v2/compare', async (request, reply) => {
    const parse = backtestV2CompareSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.code(400).send(toErrorEnvelope(
        ErrorCode.InvalidPayload,
        'Invalid comparison payload.',
        parse.error.flatten(),
      ));
    }

    try {
      const result = deps.backtestV2Service.compare(parse.data);
      return result;
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  // ─── Agent Learning & Memory endpoints ─────────────────────────────────

  app.get('/agents/:agentId/learning/patterns', async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    try {
      return deps.agentLearningService.analyzePatterns(agentId);
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  app.get('/agents/:agentId/learning/regime', async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    const query = request.query as { symbol?: string };
    const symbol = query.symbol ?? 'SOL';
    try {
      return deps.agentLearningService.detectRegime(symbol);
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  app.post('/agents/:agentId/learning/adapt', async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    try {
      return deps.agentLearningService.adaptParameters(agentId);
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  app.get('/agents/:agentId/learning/confidence/:symbol', async (request, reply) => {
    const { agentId, symbol } = request.params as { agentId: string; symbol: string };
    try {
      return deps.agentLearningService.scoreConfidence(agentId, symbol);
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  app.get('/agents/:agentId/learning/metrics', async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    try {
      return deps.agentLearningService.getLearningMetrics(agentId);
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  // ─── Gas Optimization endpoints ──────────────────────────────────────

  app.get('/gas/estimate', async () =>
    deps.gasOptimizationService.estimatePriorityFees(),
  );

  const gasOptimizeSchema = z.object({
    agentId: z.string().min(2),
    instructions: z.array(z.object({
      programId: z.string().min(1),
      computeUnits: z.number().int().positive().optional(),
      description: z.string().max(500).optional(),
    })).min(1),
    priorityTier: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
    enableJitoTip: z.boolean().optional(),
    maxFeeLamports: z.number().int().positive().optional(),
  });

  app.post('/gas/optimize', async (request, reply) => {
    const parse = gasOptimizeSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.code(400).send(toErrorEnvelope(
        ErrorCode.InvalidPayload,
        'Invalid gas optimization payload.',
        parse.error.flatten(),
      ));
    }

    try {
      const result = deps.gasOptimizationService.optimizeTransaction(parse.data);
      return result;
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  app.get('/agents/:agentId/gas/history', async (request) => {
    const { agentId } = request.params as { agentId: string };
    const query = request.query as { limit?: string };
    const limit = query.limit ? Math.min(Math.max(Number(query.limit), 1), 500) : 50;
    return deps.gasOptimizationService.getGasHistory(agentId, limit);
  });

  app.get('/gas/savings/:agentId', async (request) => {
    const { agentId } = request.params as { agentId: string };
    return deps.gasOptimizationService.getSavingsReport(agentId);
  });

  // ─── Liquidity Analysis endpoints ──────────────────────────────────

  app.get('/liquidity/:pair/depth', async (request) => {
    const { pair } = request.params as { pair: string };
    const query = request.query as { sizes?: string };
    const tradeSizes = query.sizes
      ? query.sizes.split(',').map(Number).filter((n) => n > 0)
      : undefined;
    return deps.liquidityAnalysisService.analyzeDepth(pair, tradeSizes);
  });

  app.get('/liquidity/:pair/heatmap', async (request) => {
    const { pair } = request.params as { pair: string };
    const query = request.query as { levels?: string };
    const levels = query.levels ? Math.min(Math.max(Number(query.levels), 4), 100) : undefined;
    return deps.liquidityAnalysisService.getHeatmap(pair, levels);
  });

  const impermanentLossSchema = z.object({
    initialPriceRatio: z.number().positive(),
    currentPriceRatio: z.number().positive(),
    depositValueUsd: z.number().positive(),
    feeAprPct: z.number().nonnegative().optional(),
  });

  app.post('/liquidity/impermanent-loss', async (request, reply) => {
    const parse = impermanentLossSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.code(400).send(toErrorEnvelope(
        ErrorCode.InvalidPayload,
        'Invalid impermanent loss payload.',
        parse.error.flatten(),
      ));
    }

    return deps.liquidityAnalysisService.calculateImpermanentLoss(parse.data);
  });

  app.get('/liquidity/:pair/apr', async (request) => {
    const { pair } = request.params as { pair: string };
    return deps.liquidityAnalysisService.estimateApr(pair);
  });

  const routeSchema = z.object({
    inputToken: z.string().min(1).max(20),
    outputToken: z.string().min(1).max(20),
    amountUsd: z.number().positive(),
    maxSlippagePct: z.number().min(0).max(100).optional(),
  });

  app.post('/liquidity/route', async (request, reply) => {
    const parse = routeSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.code(400).send(toErrorEnvelope(
        ErrorCode.InvalidPayload,
        'Invalid route payload.',
        parse.error.flatten(),
      ));
    }

    return deps.liquidityAnalysisService.findBestRoute(parse.data);
  });

  app.get('/liquidity/:pair/history', async (request) => {
    const { pair } = request.params as { pair: string };
    const query = request.query as { limit?: string };
    const limit = query.limit ? Math.min(Math.max(Number(query.limit), 1), 500) : 50;
    return { history: deps.liquidityAnalysisService.getHistory(pair, limit) };
  });

  // ─── Agent Personality & Communication endpoints ─────────────────────

  const personalityUpdateSchema = z.object({
    personality: z.enum(['risk-taker', 'conservative', 'balanced', 'aggressive-scalper', 'long-term-holder']).optional(),
    communicationStyle: z.enum(['formal', 'casual', 'technical']).optional(),
  });

  app.get('/agents/:agentId/personality', async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    try {
      return deps.agentPersonalityService.getProfile(agentId);
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  app.put('/agents/:agentId/personality', async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    const parse = personalityUpdateSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.code(400).send(toErrorEnvelope(
        ErrorCode.InvalidPayload,
        'Invalid personality update payload.',
        parse.error.flatten(),
      ));
    }

    try {
      const profile = deps.agentPersonalityService.setProfile(agentId, parse.data);
      return profile;
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  app.get('/agents/:agentId/personality/reasoning/:intentId', async (request, reply) => {
    const { agentId, intentId } = request.params as { agentId: string; intentId: string };
    try {
      return deps.agentPersonalityService.generateTradeReasoning(agentId, intentId);
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  app.get('/agents/:agentId/personality/mood', async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    try {
      return deps.agentPersonalityService.getMood(agentId);
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  app.get('/agents/:agentId/personality/strategy', async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    try {
      return deps.agentPersonalityService.getPreferredStrategy(agentId);
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  const personalityMessageSchema = z.object({
    from: z.string().min(2),
    message: z.string().min(1).max(2000),
  });

  app.post('/agents/:agentId/personality/messages', async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    const parse = personalityMessageSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.code(400).send(toErrorEnvelope(
        ErrorCode.InvalidPayload,
        'Invalid personality message payload.',
        parse.error.flatten(),
      ));
    }

    try {
      const msg = deps.agentPersonalityService.sendPersonalityMessage(
        parse.data.from,
        agentId,
        parse.data.message,
      );
      return reply.code(201).send({ message: msg });
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  app.get('/agents/:agentId/personality/messages', async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    const query = request.query as { limit?: string };
    const limit = query.limit ? Math.min(Math.max(Number(query.limit), 1), 200) : 50;
    try {
      return { messages: deps.agentPersonalityService.getMessages(agentId, limit) };
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  // ─── Portfolio Analytics Dashboard endpoints ──────────────────────

  app.get('/agents/:agentId/analytics/var', async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    const query = request.query as { confidence?: string };
    const confidence = query.confidence ? Number(query.confidence) : 0.95;
    try {
      return deps.portfolioAnalyticsService.computeVaR(agentId, confidence);
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  app.get('/agents/:agentId/analytics/greeks', async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    try {
      return deps.portfolioAnalyticsService.computeGreeks(agentId);
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  app.get('/agents/:agentId/analytics/correlation', async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    try {
      return deps.portfolioAnalyticsService.computeCorrelation(agentId);
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  app.get('/agents/:agentId/analytics/attribution', async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    try {
      return deps.portfolioAnalyticsService.computeAttribution(agentId);
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  app.get('/agents/:agentId/analytics/rolling-sharpe', async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    const query = request.query as { window?: string };
    const windowDays = query.window ? Math.max(2, Math.min(365, Number(query.window))) : 30;
    try {
      return deps.portfolioAnalyticsService.computeRollingSharpe(agentId, windowDays);
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  // ── Agent Marketplace & Reputation V2 ─────────────────────────────

  app.get('/agent-marketplace/services', async (request) => {
    const query = request.query as {
      category?: string;
      agentId?: string;
      minReputation?: string;
    };
    return {
      services: deps.agentMarketplaceService.listServices({
        category: query.category as any,
        agentId: query.agentId,
        minReputation: query.minReputation ? Number(query.minReputation) : undefined,
      }),
    };
  });

  const createAgentMarketplaceServiceSchema = z.object({
    agentId: z.string().min(1),
    name: z.string().min(1).max(200),
    description: z.string().min(1).max(2000),
    category: z.enum([
      'signal-provider', 'strategy-execution', 'market-analysis',
      'risk-assessment', 'portfolio-management', 'data-feed',
      'arbitrage-detection', 'sentiment-analysis',
    ]),
    capabilities: z.array(z.object({
      name: z.string().min(1),
      description: z.string().min(1),
      category: z.enum([
        'signal-provider', 'strategy-execution', 'market-analysis',
        'risk-assessment', 'portfolio-management', 'data-feed',
        'arbitrage-detection', 'sentiment-analysis',
      ]),
    })).min(1),
    priceUsd: z.number(),
    pricingModel: z.enum(['per-signal', 'subscription', 'performance-fee']),
    performanceFeePct: z.number().min(0).max(100).optional(),
    collaborators: z.array(z.object({
      agentId: z.string().min(1),
      splitPct: z.number().min(0).max(100),
    })).optional(),
  });

  app.post('/agent-marketplace/services', async (request, reply) => {
    const parse = createAgentMarketplaceServiceSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.code(400).send(toErrorEnvelope(
        ErrorCode.InvalidPayload,
        'Invalid agent marketplace service payload.',
        parse.error.flatten(),
      ));
    }
    try {
      const service = deps.agentMarketplaceService.registerService(parse.data);
      return reply.code(201).send({ service });
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  const agentMarketplaceReviewSchema = z.object({
    reviewerId: z.string().min(1),
    rating: z.number().int().min(1).max(5),
    comment: z.string().min(1).max(2000),
  });

  app.post('/agent-marketplace/services/:id/review', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parse = agentMarketplaceReviewSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.code(400).send(toErrorEnvelope(
        ErrorCode.InvalidPayload,
        'Invalid review payload.',
        parse.error.flatten(),
      ));
    }
    try {
      const review = deps.agentMarketplaceService.reviewService(id, parse.data);
      return reply.code(201).send({ review });
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  app.get('/agent-marketplace/disputes', async (request) => {
    const query = request.query as {
      serviceId?: string;
      status?: string;
      agentId?: string;
    };
    return {
      disputes: deps.agentMarketplaceService.listDisputes({
        serviceId: query.serviceId,
        status: query.status as any,
        agentId: query.agentId,
      }),
    };
  });

  const createAgentMarketplaceDisputeSchema = z.object({
    serviceId: z.string().min(1),
    complainantId: z.string().min(1),
    reason: z.string().min(1).max(2000),
    evidence: z.string().max(5000).optional(),
  });

  app.post('/agent-marketplace/disputes', async (request, reply) => {
    const parse = createAgentMarketplaceDisputeSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.code(400).send(toErrorEnvelope(
        ErrorCode.InvalidPayload,
        'Invalid dispute payload.',
        parse.error.flatten(),
      ));
    }
    try {
      const dispute = deps.agentMarketplaceService.raiseDispute(parse.data);
      return reply.code(201).send({ dispute });
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  const resolveAgentMarketplaceDisputeSchema = z.object({
    resolution: z.string().min(1).max(2000),
    refundPct: z.number().min(0).max(100).optional(),
  });

  app.post('/agent-marketplace/disputes/:id/resolve', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parse = resolveAgentMarketplaceDisputeSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.code(400).send(toErrorEnvelope(
        ErrorCode.InvalidPayload,
        'Invalid resolve payload.',
        parse.error.flatten(),
      ));
    }
    try {
      const dispute = deps.agentMarketplaceService.resolveDispute(id, parse.data);
      return reply.code(200).send({ dispute });
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  app.get('/agent-marketplace/leaderboard', async (request) => {
    const query = request.query as { sortBy?: string; limit?: string };
    const sortBy = (query.sortBy as any) || 'overall';
    const limit = query.limit ? Math.min(Math.max(Number(query.limit), 1), 200) : 50;
    return { leaderboard: deps.agentMarketplaceService.leaderboard(sortBy, limit) };
  });

  // ─── Compliance & Audit endpoints ─────────────────────────────────────

  app.get('/compliance/audit-log', async (request) => {
    const query = request.query as {
      agentId?: string;
      action?: string;
      startDate?: string;
      endDate?: string;
      limit?: string;
      offset?: string;
    };

    return deps.complianceService.getAuditLog({
      agentId: query.agentId,
      action: query.action,
      startDate: query.startDate,
      endDate: query.endDate,
      limit: query.limit ? Math.min(Math.max(Number(query.limit), 1), 500) : undefined,
      offset: query.offset ? Number(query.offset) : undefined,
    });
  });

  app.get('/compliance/audit-log/verify', async () =>
    deps.complianceService.verifyAuditIntegrity(),
  );

  app.get('/compliance/report/:agentId', async (request) => {
    const { agentId } = request.params as { agentId: string };
    const query = request.query as { period?: string };
    const period = query.period === 'weekly' ? 'weekly' : 'daily';
    return deps.complianceService.generateReport(agentId, period);
  });

  const complianceRuleSchema = z.object({
    type: z.enum(['max-daily-volume', 'restricted-token', 'trading-hours', 'max-single-trade', 'max-daily-trades', 'custom']),
    name: z.string().min(2).max(200),
    description: z.string().min(2).max(2000),
    params: z.record(z.string(), z.unknown()),
    enabled: z.boolean().optional(),
  });

  app.post('/compliance/rules', async (request, reply) => {
    const parse = complianceRuleSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.code(400).send(toErrorEnvelope(
        ErrorCode.InvalidPayload,
        'Invalid compliance rule payload.',
        parse.error.flatten(),
      ));
    }

    try {
      const rule = deps.complianceService.addRule(parse.data);
      return reply.code(201).send({ rule });
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  app.get('/compliance/rules', async () => ({
    rules: deps.complianceService.listRules(),
  }));

  app.get('/compliance/suspicious/:agentId', async (request) => {
    const { agentId } = request.params as { agentId: string };
    const query = request.query as { detect?: string };

    if (query.detect === 'true') {
      const detected = deps.complianceService.detectSuspiciousActivity(agentId);
      return { agentId, newlyDetected: detected, all: deps.complianceService.getSuspiciousActivities(agentId) };
    }

    return { agentId, activities: deps.complianceService.getSuspiciousActivities(agentId) };
  });

  app.get('/compliance/export/:agentId', async (request) => {
    const { agentId } = request.params as { agentId: string };
    const query = request.query as { format?: string };
    const format = query.format === 'csv' ? 'csv' : 'json';
    return deps.complianceService.exportRegulatoryData(agentId, format);
  });

  app.get('/agents/:agentId/kyc', async (request) => {
    const { agentId } = request.params as { agentId: string };
    return deps.complianceService.getKycStatus(agentId);
  });

  const kycUpdateSchema = z.object({
    status: z.enum(['pending', 'verified', 'rejected', 'expired', 'not_started']).optional(),
    level: z.number().int().min(0).max(3).optional(),
    documents: z.array(z.string()).optional(),
    rejectionReason: z.string().nullable().optional(),
  });

  app.put('/agents/:agentId/kyc', async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    const parse = kycUpdateSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.code(400).send(toErrorEnvelope(
        ErrorCode.InvalidPayload,
        'Invalid KYC update payload.',
        parse.error.flatten(),
      ));
    }

    try {
      const record = deps.complianceService.updateKycStatus(agentId, parse.data);
      return record;
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  const complianceCheckSchema = z.object({
    agentId: z.string().min(2),
    symbol: z.string().min(1).max(20),
    side: z.enum(['buy', 'sell']),
    notionalUsd: z.number().positive(),
  });

  app.post('/compliance/check', async (request, reply) => {
    const parse = complianceCheckSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.code(400).send(toErrorEnvelope(
        ErrorCode.InvalidPayload,
        'Invalid compliance check payload.',
        parse.error.flatten(),
      ));
    }

    const violations = deps.complianceService.evaluateRules(parse.data.agentId, {
      symbol: parse.data.symbol,
      side: parse.data.side,
      notionalUsd: parse.data.notionalUsd,
    });

    return {
      compliant: violations.length === 0,
      violations,
    };
  });

  // ─── Bridge Monitor endpoints ────────────────────────────────────────

  app.get('/bridge/status', async () => ({
    bridges: deps.bridgeMonitorService.getAllBridgeHealth(),
  }));

  const trackBridgeTxSchema = z.object({
    provider: z.enum(['wormhole', 'debridge', 'allbridge']),
    sourceTxHash: z.string().min(1).max(256),
    sourceChain: z.enum(['solana', 'ethereum', 'bsc', 'polygon', 'avalanche', 'arbitrum', 'optimism']),
    destChain: z.enum(['solana', 'ethereum', 'bsc', 'polygon', 'avalanche', 'arbitrum', 'optimism']),
    token: z.string().min(1).max(20),
    amountUsd: z.number().positive(),
    agentId: z.string().min(1).optional(),
  });

  app.post('/bridge/track', async (request, reply) => {
    const parse = trackBridgeTxSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.code(400).send(toErrorEnvelope(
        ErrorCode.InvalidPayload,
        'Invalid bridge tracking payload.',
        parse.error.flatten(),
      ));
    }

    try {
      const tx = deps.bridgeMonitorService.trackTransaction(parse.data);
      return reply.code(201).send({ transaction: tx });
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  app.get('/bridge/opportunities', async (request) => {
    const query = request.query as { viableOnly?: string };
    const viableOnly = query.viableOnly === 'true';
    return {
      opportunities: deps.bridgeMonitorService.getOpportunities(viableOnly),
    };
  });

  app.get('/bridge/fees/:pair', async (request) => {
    const { pair } = request.params as { pair: string };
    const query = request.query as { token?: string; amount?: string };
    const [sourceChain, destChain] = pair.split('-') as [string, string];
    const token = query.token ?? 'USDC';
    const amount = query.amount ? Number(query.amount) : 1000;
    return deps.bridgeMonitorService.compareFees(
      sourceChain as any,
      destChain as any,
      token,
      amount,
    );
  });

  app.get('/bridge/risk', async () => ({
    riskScores: deps.bridgeMonitorService.getRiskScores(),
  }));

  app.get('/state', async () => deps.store.snapshot());

  // ─── Smart Order Router endpoints ────────────────────────────────────

  const sorRouteSchema = z.object({
    symbol: z.string().min(1).max(20),
    side: z.enum(['buy', 'sell']),
    notionalUsd: z.number().positive(),
    maxSlippagePct: z.number().min(0).max(100).optional(),
  });

  app.post('/sor/route', async (request, reply) => {
    const parse = sorRouteSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.code(400).send(toErrorEnvelope(
        ErrorCode.InvalidPayload,
        'Invalid SOR route payload.',
        parse.error.flatten(),
      ));
    }

    try {
      const route = deps.smartOrderRouterService.routeOrder(parse.data);
      return { route };
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  const sorTwapSchema = z.object({
    symbol: z.string().min(1).max(20),
    side: z.enum(['buy', 'sell']),
    notionalUsd: z.number().positive(),
    durationMs: z.number().positive(),
    intervalMs: z.number().positive().optional(),
  });

  app.post('/sor/twap', async (request, reply) => {
    const parse = sorTwapSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.code(400).send(toErrorEnvelope(
        ErrorCode.InvalidPayload,
        'Invalid TWAP payload.',
        parse.error.flatten(),
      ));
    }

    try {
      const order = deps.smartOrderRouterService.startTwap(parse.data);
      return reply.code(201).send({ order });
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  const sorVwapSchema = z.object({
    symbol: z.string().min(1).max(20),
    side: z.enum(['buy', 'sell']),
    notionalUsd: z.number().positive(),
    durationMs: z.number().positive(),
    buckets: z.number().int().min(2).max(100).optional(),
  });

  app.post('/sor/vwap', async (request, reply) => {
    const parse = sorVwapSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.code(400).send(toErrorEnvelope(
        ErrorCode.InvalidPayload,
        'Invalid VWAP payload.',
        parse.error.flatten(),
      ));
    }

    try {
      const order = deps.smartOrderRouterService.startVwap(parse.data);
      return reply.code(201).send({ order });
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  const sorIcebergSchema = z.object({
    symbol: z.string().min(1).max(20),
    side: z.enum(['buy', 'sell']),
    totalNotionalUsd: z.number().positive(),
    visiblePct: z.number().min(0.01).max(1).optional(),
    chunkSize: z.number().positive().optional(),
  });

  app.post('/sor/iceberg', async (request, reply) => {
    const parse = sorIcebergSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.code(400).send(toErrorEnvelope(
        ErrorCode.InvalidPayload,
        'Invalid iceberg order payload.',
        parse.error.flatten(),
      ));
    }

    try {
      const order = deps.smartOrderRouterService.startIceberg(parse.data);
      return reply.code(201).send({ order });
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  app.get('/sor/quality/:intentId', async (request, reply) => {
    const { intentId } = request.params as { intentId: string };
    const quality = deps.smartOrderRouterService.scoreExecution(intentId);
    if (!quality) {
      return reply.code(404).send(toErrorEnvelope(
        ErrorCode.IntentNotFound,
        'Trade intent not found or not yet executed.',
      ));
    }
    return { quality };
  });

  const sorSlippageSchema = z.object({
    symbol: z.string().min(1).max(20),
    side: z.enum(['buy', 'sell']),
    notionalUsd: z.number().positive(),
  });

  app.get('/sor/slippage-estimate', async (request, reply) => {
    const query = request.query as { symbol?: string; side?: string; notionalUsd?: string };
    const parsed = sorSlippageSchema.safeParse({
      symbol: query.symbol,
      side: query.side,
      notionalUsd: query.notionalUsd ? Number(query.notionalUsd) : undefined,
    });
    if (!parsed.success) {
      return reply.code(400).send(toErrorEnvelope(
        ErrorCode.InvalidPayload,
        'Invalid slippage estimate query. Required: symbol, side, notionalUsd.',
        parsed.error.flatten(),
      ));
    }

    try {
      const estimate = deps.smartOrderRouterService.predictSlippage(parsed.data);
      return { estimate };
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  // ─── Telemetry & Observability endpoints ─────────────────────────────

  app.get('/telemetry/metrics', async () =>
    deps.telemetryService.getSystemMetrics(),
  );

  app.get('/telemetry/agents/:agentId/heartbeat', async (request) => {
    const { agentId } = request.params as { agentId: string };
    return deps.telemetryService.getAgentHeartbeat(agentId);
  });

  app.get('/telemetry/anomalies', async () => ({
    anomalies: deps.telemetryService.getAnomalies(),
  }));

  app.get('/telemetry/sla', async () =>
    deps.telemetryService.getSlaReport(),
  );

  app.get('/telemetry/incidents', async () => ({
    incidents: deps.telemetryService.getIncidents(),
  }));

  const telemetryRecordSchema = z.object({
    endpoint: z.string().min(1),
    method: z.string().min(1).max(10),
    latencyMs: z.number().nonnegative(),
    statusCode: z.number().int().min(100).max(599),
    agentId: z.string().min(1).optional(),
  });

  app.post('/telemetry/record', async (request, reply) => {
    const parse = telemetryRecordSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.code(400).send(toErrorEnvelope(
        ErrorCode.InvalidPayload,
        'Invalid telemetry record payload.',
        parse.error.flatten(),
      ));
    }

    const record = deps.telemetryService.recordMetric(parse.data);
    return reply.code(201).send({ record });
  });
}
