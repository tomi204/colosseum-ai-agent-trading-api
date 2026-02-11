import { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { AppConfig } from '../config.js';
import { renderExperimentPage } from './experimentPage.js';
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

  app.get('/skills', async () => ({
    skills: deps.skillRegistry.listAll(),
  }));

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

  app.get('/state', async () => deps.store.snapshot());
}
