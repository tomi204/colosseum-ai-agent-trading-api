import { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { AppConfig } from '../config.js';
import { renderExperimentPage } from './experimentPage.js';
import { FeeEngine } from '../domain/fee/feeEngine.js';
import { redactReceipt } from '../domain/privacy/receiptRedaction.js';
import { SkillRegistry } from '../domain/skills/skillRegistry.js';
import { StrategyRegistry } from '../domain/strategy/strategyRegistry.js';
import { DomainError, ErrorCode, toErrorEnvelope } from '../errors/taxonomy.js';
import { StateStore } from '../infra/storage/stateStore.js';
import { AgentService } from '../services/agentService.js';
import { AutonomousService } from '../services/autonomousService.js';
import { resolveAgentFromKey } from '../services/auth.js';
import { ExecutionService } from '../services/executionService.js';
import { LendingMonitorService } from '../services/lendingMonitorService.js';
import { TokenRevenueService } from '../services/tokenRevenueService.js';
import { TradeIntentService } from '../services/tradeIntentService.js';
import { X402Policy } from '../services/x402Policy.js';
import { ArbitrageService } from '../services/arbitrageService.js';
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
  lendingMonitorService: LendingMonitorService;
  skillRegistry: SkillRegistry;
  getRuntimeMetrics: () => RuntimeMetrics;
}

const registerAgentSchema = z.object({
  name: z.string().min(2).max(120),
  startingCapitalUsd: z.number().positive().optional(),
  strategyId: z.enum(['momentum-v1', 'mean-reversion-v1', 'arbitrage-v1', 'dca-v1', 'twap-v1']).optional(),
  riskOverrides: z.object({
    maxPositionSizePct: z.number().positive().max(1).optional(),
    maxOrderNotionalUsd: z.number().positive().optional(),
    maxGrossExposureUsd: z.number().positive().optional(),
    dailyLossCapUsd: z.number().positive().optional(),
    maxDrawdownPct: z.number().positive().max(1).optional(),
    cooldownSeconds: z.number().nonnegative().optional(),
  }).partial().optional(),
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

      return reply.code(201).send({
        agent: {
          id: agent.id,
          name: agent.name,
          createdAt: agent.createdAt,
          startingCapitalUsd: agent.startingCapitalUsd,
          riskLimits: agent.riskLimits,
          strategyId: agent.strategyId,
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

    await deps.executionService.setMarketPrice(parse.data.symbol.toUpperCase(), parse.data.priceUsd);

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

  app.get('/state', async () => deps.store.snapshot());
}
