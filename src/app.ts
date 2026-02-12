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
import { WatchlistService } from './services/watchlistService.js';
import { TradeHistoryService } from './services/tradeHistoryService.js';
import { DiagnosticsService } from './services/diagnosticsService.js';
import { SelfImproveService } from './services/selfImproveService.js';
import { InferenceBudgetService } from './services/inferenceBudgetService.js';
import { ImprovementLoopService } from './services/improvementLoopService.js';
import { TournamentService } from './services/tournamentService.js';
import { SocialTradingService } from './services/socialTradingService.js';
import { PythOracleService } from './services/pythOracleService.js';
import { BenchmarkService } from './services/benchmarkService.js';
import { TimeframeService } from './services/timeframeService.js';
import { NotificationService } from './services/notificationService.js';
import { SentimentService } from './services/sentimentService.js';
import { SandboxService } from './services/sandboxService.js';
import { SkillsMarketplaceService } from './services/skillsMarketplaceService.js';
import { ExecutionAnalyticsService } from './services/executionAnalyticsService.js';
import { CollaborationService } from './services/collaborationService.js';
import { StressTestService } from './services/stressTestService.js';
import { DefiHealthScoreService } from './services/defiHealthScoreService.js';
import { BacktestV2Service } from './services/backtestV2Service.js';
import { AgentLearningService } from './services/agentLearningService.js';
import { AgentPersonalityService } from './services/agentPersonalityService.js';
import { GasOptimizationService } from './services/gasOptimizationService.js';
import { LiquidityAnalysisService } from './services/liquidityAnalysisService.js';
import { AgentMarketplaceService } from './services/agentMarketplaceService.js';
import { PortfolioAnalyticsService } from './services/portfolioAnalyticsService.js';
import { ComplianceService } from './services/complianceService.js';
import { BridgeMonitorService } from './services/bridgeMonitorService.js';
import { SmartOrderRouterService } from './services/smartOrderRouterService.js';
import { TelemetryService } from './services/telemetryService.js';
import { TokenLaunchService } from './services/tokenLaunchService.js';
import { AgentCommService } from './services/agentCommService.js';
import { RiskScenarioService } from './services/riskScenarioService.js';
import { StrategyGeneratorService } from './services/strategyGeneratorService.js';
import { OnChainGovernanceService } from './services/onChainGovernanceService.js';
import { YieldFarmingService } from './services/yieldFarmingService.js';
import { PositionSizingService } from './services/positionSizingService.js';
import { InsuranceService } from './services/insuranceService.js';
import { MicrostructureService } from './services/microstructureService.js';
import { MarketMakingService } from './services/marketMakingService.js';
import { TokenAnalyticsService } from './services/tokenAnalyticsService.js';
import { TrustGraphService } from './services/trustGraphService.js';
import { OrchestrationService } from './services/orchestrationService.js';
import { ProtocolAggregatorService } from './services/protocolAggregatorService.js';
import { PerformanceAttributionService } from './services/performanceAttributionService.js';
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
  const watchlistService = new WatchlistService(stateStore);
  const tradeHistoryService = new TradeHistoryService(stateStore);
  const diagnosticsService = new DiagnosticsService(stateStore, agentService, intentService);
  const selfImproveService = new SelfImproveService(stateStore);
  const inferenceBudgetService = new InferenceBudgetService(stateStore);
  const improvementLoopService = new ImprovementLoopService(stateStore, selfImproveService, inferenceBudgetService);
  const tournamentService = new TournamentService(stateStore, backtestService);
  const socialTradingService = new SocialTradingService(stateStore);
  const pythOracleService = new PythOracleService(stateStore, executionService);
  const benchmarkService = new BenchmarkService(stateStore);
  const timeframeService = new TimeframeService(stateStore);
  const notificationService = new NotificationService(stateStore);
  const sentimentService = new SentimentService(stateStore);
  const sandboxService = new SandboxService(stateStore);
  const skillsMarketplaceService = new SkillsMarketplaceService(stateStore);
  const executionAnalyticsService = new ExecutionAnalyticsService(stateStore);
  const collaborationService = new CollaborationService(stateStore);
  const stressTestService = new StressTestService(stateStore);
  const defiHealthScoreService = new DefiHealthScoreService(stateStore);
  const backtestV2Service = new BacktestV2Service(strategyRegistry);
  const agentLearningService = new AgentLearningService(stateStore);
  const agentPersonalityService = new AgentPersonalityService(stateStore);
  const gasOptimizationService = new GasOptimizationService(stateStore);
  const liquidityAnalysisService = new LiquidityAnalysisService(stateStore);
  const portfolioAnalyticsService = new PortfolioAnalyticsService(stateStore);
  const agentMarketplaceService = new AgentMarketplaceService(stateStore);
  const complianceService = new ComplianceService(stateStore);
  const bridgeMonitorService = new BridgeMonitorService();
  const smartOrderRouterService = new SmartOrderRouterService(stateStore);
  const telemetryService = new TelemetryService(stateStore);
  const tokenLaunchService = new TokenLaunchService();
  const agentCommService = new AgentCommService(stateStore, config.privacy.serverSecret);
  const riskScenarioService = new RiskScenarioService(stateStore);
  const strategyGeneratorService = new StrategyGeneratorService(stateStore);
  const onChainGovernanceService = new OnChainGovernanceService(stateStore);
  const yieldFarmingService = new YieldFarmingService();
  const positionSizingService = new PositionSizingService();
  const insuranceService = new InsuranceService(stateStore);
  const microstructureService = new MicrostructureService(stateStore);
  const marketMakingService = new MarketMakingService(stateStore);
  const tokenAnalyticsService = new TokenAnalyticsService(stateStore);
  const trustGraphService = new TrustGraphService();
  const orchestrationService = new OrchestrationService();
  const performanceAttributionService = new PerformanceAttributionService(stateStore);
  const protocolAggregatorService = new ProtocolAggregatorService();

  // Start notification listener
  notificationService.startListening();

  // Start listeners for trade history and diagnostics
  tradeHistoryService.startListening();
  diagnosticsService.startListening();

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
    watchlistService,
    tradeHistoryService,
    diagnosticsService,
    selfImproveService,
    inferenceBudgetService,
    improvementLoopService,
    tournamentService,
    socialTradingService,
    pythOracleService,
    benchmarkService,
    timeframeService,
    notificationService,
    sentimentService,
    sandboxService,
    skillsMarketplaceService,
    executionAnalyticsService,
    collaborationService,
    stressTestService,
    defiHealthScoreService,
    backtestV2Service,
    agentLearningService,
    agentPersonalityService,
    gasOptimizationService,
    liquidityAnalysisService,
    portfolioAnalyticsService,
    agentMarketplaceService,
    complianceService,
    bridgeMonitorService,
    smartOrderRouterService,
    telemetryService,
    tokenLaunchService,
    agentCommService,
    riskScenarioService,
    strategyGeneratorService,
    onChainGovernanceService,
    yieldFarmingService,
    positionSizingService,
    insuranceService,
    microstructureService,
    marketMakingService,
    tokenAnalyticsService,
    trustGraphService,
    orchestrationService,
    performanceAttributionService,
    protocolAggregatorService,
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
