import Fastify from 'fastify';
import fastifyWebSocket from '@fastify/websocket';
import { registerRoutes } from './api/routes.js';
import { registerWebSocket } from './api/websocket.js';
import { AppConfig } from './config.js';
import { FeeEngine } from './domain/fee/feeEngine.js';
import { SkillRegistry } from './domain/skills/skillRegistry.js';
import { StrategyRegistry } from './domain/strategy/strategyRegistry.js';
import { EventLogger } from './infra/logger.js';
import { StateStore } from './infra/storage/stateStore.js';
import { ClawpumpClient } from './integrations/clawpump/client.js';
import { AgentService } from './services/agentService.js';
import { AnalyticsService } from './services/analyticsService.js';
import { ArbitrageService } from './services/arbitrageService.js';
import { AutonomousService } from './services/autonomousService.js';
import { CoordinationService } from './services/coordinationService.js';
import { LendingMonitorService } from './services/lendingMonitorService.js';
import { ExecutionService } from './services/executionService.js';
import { x402PaymentGate } from './services/paymentGate.js';
import { TokenRevenueService } from './services/tokenRevenueService.js';
import { TradeIntentService } from './services/tradeIntentService.js';
import { SimulationService } from './services/simulationService.js';
import { WebhookService } from './services/webhookService.js';
import { ExecutionWorker } from './services/worker.js';
import { loadX402Policy } from './services/x402Policy.js';
import { ReputationService } from './services/reputationService.js';
import { ProofAnchorService } from './services/proofAnchorService.js';
import { GovernanceService } from './services/governanceService.js';
import { OrderBookService } from './services/orderBookService.js';
import { BacktestService } from './services/backtestService.js';
import { MarketplaceService } from './services/marketplaceService.js';
import { AdvancedOrderService } from './services/advancedOrderService.js';
import { MessagingService } from './services/messagingService.js';
import { MevProtectionService } from './services/mevProtectionService.js';
import { JournalService } from './services/journalService.js';
import { StrategyCompareService } from './services/strategyCompareService.js';
import { PriceOracleService } from './services/priceOracleService.js';
import { RebalanceService } from './services/rebalanceService.js';
import { AlertService } from './services/alertService.js';
import { CopyTradingService } from './services/copyTradingService.js';
import { CreditRatingService } from './services/creditRatingService.js';
import { RateLimiter } from './api/rateLimiter.js';
import { StagedPipeline } from './domain/execution/stagedPipeline.js';

export interface AppContext {
  app: ReturnType<typeof Fastify>;
  worker: ExecutionWorker;
  autonomousService: AutonomousService;
  arbitrageService: ArbitrageService;
  stateStore: StateStore;
  logger: EventLogger;
}

export async function buildApp(config: AppConfig): Promise<AppContext> {
  const app = Fastify({
    logger: false,
  });

  // Register WebSocket plugin first so routes can use { websocket: true }.
  await app.register(fastifyWebSocket);

  const stateStore = new StateStore(config.paths.stateFile);
  await stateStore.init();

  const logger = new EventLogger(config.paths.logFile);
  await logger.init();

  const strategyRegistry = new StrategyRegistry();
  const feeEngine = new FeeEngine(config.trading);
  const agentService = new AgentService(stateStore, config, strategyRegistry);
  const intentService = new TradeIntentService(stateStore);
  const executionService = new ExecutionService(stateStore, logger, feeEngine, config);
  const clawpumpClient = new ClawpumpClient({
    baseUrl: config.tokenRevenue.baseUrl,
    apiKey: config.tokenRevenue.apiKey,
    timeoutMs: config.tokenRevenue.timeoutMs,
    healthPath: config.tokenRevenue.healthPath,
    launchPath: config.tokenRevenue.launchPath,
    earningsPath: config.tokenRevenue.earningsPath,
    maxImageBytes: config.tokenRevenue.maxImageBytes,
  });
  const tokenRevenueService = new TokenRevenueService(stateStore, logger, clawpumpClient, config);

  const worker = new ExecutionWorker(
    stateStore,
    executionService,
    logger,
    config.worker.intervalMs,
    config.worker.maxBatchSize,
  );

  const autonomousService = new AutonomousService(
    stateStore,
    logger,
    strategyRegistry,
    config,
  );

  const arbitrageService = new ArbitrageService();

  const coordinationService = new CoordinationService(stateStore);
  const analyticsService = new AnalyticsService(stateStore);

  const lendingMonitorService = new LendingMonitorService(stateStore, config);
  const skillRegistry = new SkillRegistry();

  const simulationService = new SimulationService(stateStore, feeEngine, config);
  const webhookService = new WebhookService(logger);
  const rateLimiter = new RateLimiter({ intentsPerMinute: config.rateLimit.intentsPerMinute });
  const stagedPipeline = new StagedPipeline();
  const reputationService = new ReputationService(stateStore);
  const proofAnchorService = new ProofAnchorService(stateStore, config.trading.liveEnabled);
  const governanceService = new GovernanceService(stateStore);
  const orderBookService = new OrderBookService(stateStore);
  const backtestService = new BacktestService(strategyRegistry);
  const marketplaceService = new MarketplaceService(stateStore);
  const advancedOrderService = new AdvancedOrderService(stateStore);
  const messagingService = new MessagingService(stateStore);
  const mevProtectionService = new MevProtectionService(stateStore);
  const journalService = new JournalService();
  const strategyCompareService = new StrategyCompareService(backtestService);
  const priceOracleService = new PriceOracleService(stateStore);
  const rebalanceService = new RebalanceService(stateStore);
  const alertService = new AlertService(stateStore);
  const copyTradingService = new CopyTradingService(stateStore);
  const creditRatingService = new CreditRatingService(stateStore);

  // Wire messaging service to coordination service for squad member lookup
  messagingService.setSquadMemberLookup((squadId: string) => {
    const squad = coordinationService.getSquad(squadId);
    return squad ? squad.memberIds : null;
  });

  const x402Policy = await loadX402Policy(config.payments.x402PolicyFile, config.payments.x402RequiredPaths);
  app.addHook('preHandler', x402PaymentGate(config.payments, stateStore, x402Policy));

  const startedAt = Date.now();
  await registerRoutes(app, {
    config,
    store: stateStore,
    agentService,
    intentService,
    executionService,
    feeEngine,
    strategyRegistry,
    tokenRevenueService,
    autonomousService,
    arbitrageService,
    coordinationService,
    analyticsService,
    lendingMonitorService,
    skillRegistry,
    simulationService,
    webhookService,
    rateLimiter,
    stagedPipeline,
    reputationService,
    proofAnchorService,
    governanceService,
    orderBookService,
    backtestService,
    marketplaceService,
    advancedOrderService,
    messagingService,
    mevProtectionService,
    journalService,
    strategyCompareService,
    priceOracleService,
    rebalanceService,
    alertService,
    copyTradingService,
    creditRatingService,
    x402Policy,
    getRuntimeMetrics: () => {
      const state = stateStore.snapshot();
      return {
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        pendingIntents: Object.values(state.tradeIntents).filter((intent) => intent.status === 'pending').length,
        processPid: process.pid,
      };
    },
  });

  // Register WebSocket live event feed endpoint.
  await registerWebSocket(app);

  return {
    app,
    worker,
    autonomousService,
    arbitrageService,
    stateStore,
    logger,
  };
}
