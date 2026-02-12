import { describe, expect, it, beforeEach } from 'vitest';
import { buildApp, AppContext } from '../src/app.js';

const testConfig = {
  app: { name: 'test', env: 'test', port: 0 },
  paths: {
    dataDir: '/tmp/colosseum-test-agent-marketplace',
    stateFile: `/tmp/colosseum-test-agent-marketplace/state-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
    logFile: `/tmp/colosseum-test-agent-marketplace/events-${Date.now()}.ndjson`,
  },
  worker: { intervalMs: 60_000, maxBatchSize: 10 },
  trading: {
    defaultStartingCapitalUsd: 10_000,
    defaultMode: 'paper' as const,
    liveEnabled: false,
    liveBroadcastEnabled: false,
    solanaRpcUrl: undefined,
    solanaPrivateKeyB58: undefined,
    jupiterQuoteUrl: 'https://lite-api.jup.ag/swap/v1/quote',
    jupiterSwapUrl: 'https://lite-api.jup.ag/swap/v1/swap',
    jupiterReferralAccount: undefined,
    jupiterPlatformFeeBps: 8,
    platformFeeBps: 8,
    supportedSymbols: ['SOL', 'USDC', 'BONK', 'JUP'],
    symbolToMint: {} as Record<string, string>,
    quoteRetryAttempts: 3,
    quoteRetryBaseDelayMs: 150,
    marketHistoryLimit: 100,
  },
  risk: {
    maxPositionSizePct: 0.25,
    maxOrderNotionalUsd: 2500,
    maxGrossExposureUsd: 7500,
    dailyLossCapUsd: 1000,
    maxDrawdownPct: 0.2,
    cooldownSeconds: 3,
  },
  rateLimit: { intentsPerMinute: 100 },
  payments: {
    x402PolicyFile: '',
    x402RequiredPaths: [] as string[],
    x402Enabled: false,
  },
  privacy: { encryptionEnabled: false, serverSecret: 'test-secret' },
  tokenRevenue: {
    baseUrl: 'http://localhost:9999',
    apiKey: 'test',
    timeoutMs: 5000,
    healthPath: '/health',
    launchPath: '/launch',
    earningsPath: '/earnings',
    maxImageBytes: 1_000_000,
  },
  autonomous: {
    intervalMs: 30_000,
    maxConsecutiveFailures: 3,
    cooldownMs: 60_000,
  },
  lending: {
    healthFactorWarning: 1.3,
    healthFactorCritical: 1.1,
    scanIntervalMs: 60_000,
  },
};

async function registerAgent(ctx: AppContext, name: string): Promise<{ id: string; apiKey: string }> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/agents/register',
    payload: { name, startingCapitalUsd: 10_000 },
  });
  const body = res.json();
  return { id: body.agent.id, apiKey: body.apiKey };
}

describe('AgentMarketplaceService', () => {
  let ctx: AppContext;

  beforeEach(async () => {
    testConfig.paths.stateFile = `/tmp/colosseum-test-agent-marketplace/state-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
    ctx = await buildApp(testConfig as any);
  });

  // ── Service Registration ──────────────────────────────────────────

  it('should register a new agent service', async () => {
    const agent = await registerAgent(ctx, 'SignalBot');
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/agent-marketplace/services',
      payload: {
        agentId: agent.id,
        name: 'Premium SOL Signals',
        description: 'High-quality SOL trading signals with 80% hit rate',
        category: 'signal-provider',
        capabilities: [
          { name: 'SOL Analysis', description: 'Deep SOL market analysis', category: 'signal-provider' },
        ],
        priceUsd: 49.99,
        pricingModel: 'subscription',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.service.name).toBe('Premium SOL Signals');
    expect(body.service.priceUsd).toBe(49.99);
    expect(body.service.reputationScore).toBe(500);
    expect(body.service.isActive).toBe(true);
  });

  it('should reject service registration for unknown agent', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/agent-marketplace/services',
      payload: {
        agentId: 'nonexistent-agent',
        name: 'Fake Service',
        description: 'Should fail',
        category: 'signal-provider',
        capabilities: [
          { name: 'Test', description: 'Test', category: 'signal-provider' },
        ],
        priceUsd: 10,
        pricingModel: 'subscription',
      },
    });
    expect(res.statusCode).toBe(404);
  });

  it('should reject service with negative price', async () => {
    const agent = await registerAgent(ctx, 'BadPriceBot');
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/agent-marketplace/services',
      payload: {
        agentId: agent.id,
        name: 'Bad Price Service',
        description: 'Negative price test',
        category: 'signal-provider',
        capabilities: [
          { name: 'Test', description: 'Test', category: 'signal-provider' },
        ],
        priceUsd: -5,
        pricingModel: 'subscription',
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('should reject service without capabilities', async () => {
    const agent = await registerAgent(ctx, 'NoCapsBot');
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/agent-marketplace/services',
      payload: {
        agentId: agent.id,
        name: 'No Capabilities',
        description: 'Missing capabilities',
        category: 'signal-provider',
        capabilities: [],
        priceUsd: 10,
        pricingModel: 'subscription',
      },
    });
    expect(res.statusCode).toBe(400);
  });

  // ── Browse Services ───────────────────────────────────────────────

  it('should list all active services', async () => {
    const agent = await registerAgent(ctx, 'ListBot');
    await ctx.app.inject({
      method: 'POST',
      url: '/agent-marketplace/services',
      payload: {
        agentId: agent.id,
        name: 'Service A',
        description: 'First service',
        category: 'signal-provider',
        capabilities: [{ name: 'Sig', description: 'Signals', category: 'signal-provider' }],
        priceUsd: 10,
        pricingModel: 'per-signal',
      },
    });
    await ctx.app.inject({
      method: 'POST',
      url: '/agent-marketplace/services',
      payload: {
        agentId: agent.id,
        name: 'Service B',
        description: 'Second service',
        category: 'market-analysis',
        capabilities: [{ name: 'Analysis', description: 'Market analysis', category: 'market-analysis' }],
        priceUsd: 25,
        pricingModel: 'subscription',
      },
    });

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/agent-marketplace/services',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.services.length).toBe(2);
  });

  it('should filter services by category', async () => {
    const agent = await registerAgent(ctx, 'FilterBot');
    await ctx.app.inject({
      method: 'POST',
      url: '/agent-marketplace/services',
      payload: {
        agentId: agent.id,
        name: 'Signal Service',
        description: 'Signals',
        category: 'signal-provider',
        capabilities: [{ name: 'Sig', description: 'Signals', category: 'signal-provider' }],
        priceUsd: 10,
        pricingModel: 'per-signal',
      },
    });
    await ctx.app.inject({
      method: 'POST',
      url: '/agent-marketplace/services',
      payload: {
        agentId: agent.id,
        name: 'Risk Service',
        description: 'Risk',
        category: 'risk-assessment',
        capabilities: [{ name: 'Risk', description: 'Risk analysis', category: 'risk-assessment' }],
        priceUsd: 30,
        pricingModel: 'subscription',
      },
    });

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/agent-marketplace/services?category=signal-provider',
    });

    const body = res.json();
    expect(body.services.length).toBe(1);
    expect(body.services[0].category).toBe('signal-provider');
  });

  // ── Reviews & Reputation V2 ───────────────────────────────────────

  it('should submit a review and update reputation', async () => {
    const provider = await registerAgent(ctx, 'ProviderBot');
    const reviewer = await registerAgent(ctx, 'ReviewerBot');

    const serviceRes = await ctx.app.inject({
      method: 'POST',
      url: '/agent-marketplace/services',
      payload: {
        agentId: provider.id,
        name: 'Review Target',
        description: 'Service to review',
        category: 'signal-provider',
        capabilities: [{ name: 'Sig', description: 'Signals', category: 'signal-provider' }],
        priceUsd: 15,
        pricingModel: 'per-signal',
      },
    });
    const serviceId = serviceRes.json().service.id;

    const reviewRes = await ctx.app.inject({
      method: 'POST',
      url: `/agent-marketplace/services/${serviceId}/review`,
      payload: {
        reviewerId: reviewer.id,
        rating: 5,
        comment: 'Excellent signals, very accurate!',
      },
    });

    expect(reviewRes.statusCode).toBe(201);
    const reviewBody = reviewRes.json();
    expect(reviewBody.review.rating).toBe(5);
    expect(reviewBody.review.weight).toBeGreaterThan(0);
  });

  it('should reject self-reviews', async () => {
    const agent = await registerAgent(ctx, 'SelfReviewBot');
    const serviceRes = await ctx.app.inject({
      method: 'POST',
      url: '/agent-marketplace/services',
      payload: {
        agentId: agent.id,
        name: 'Self Review Service',
        description: 'Testing self review prevention',
        category: 'signal-provider',
        capabilities: [{ name: 'Sig', description: 'Signals', category: 'signal-provider' }],
        priceUsd: 10,
        pricingModel: 'per-signal',
      },
    });
    const serviceId = serviceRes.json().service.id;

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/agent-marketplace/services/${serviceId}/review`,
      payload: {
        reviewerId: agent.id,
        rating: 5,
        comment: 'I am the best!',
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('should reject invalid ratings', async () => {
    const provider = await registerAgent(ctx, 'RatingProvider');
    const reviewer = await registerAgent(ctx, 'BadRatingReviewer');

    const serviceRes = await ctx.app.inject({
      method: 'POST',
      url: '/agent-marketplace/services',
      payload: {
        agentId: provider.id,
        name: 'Rating Test',
        description: 'Test invalid ratings',
        category: 'signal-provider',
        capabilities: [{ name: 'Sig', description: 'Signals', category: 'signal-provider' }],
        priceUsd: 10,
        pricingModel: 'per-signal',
      },
    });
    const serviceId = serviceRes.json().service.id;

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/agent-marketplace/services/${serviceId}/review`,
      payload: {
        reviewerId: reviewer.id,
        rating: 6,
        comment: 'Too high rating',
      },
    });
    expect(res.statusCode).toBe(400);
  });

  // ── Disputes ──────────────────────────────────────────────────────

  it('should raise a dispute', async () => {
    const provider = await registerAgent(ctx, 'DisputeProvider');
    const complainant = await registerAgent(ctx, 'Complainant');

    const serviceRes = await ctx.app.inject({
      method: 'POST',
      url: '/agent-marketplace/services',
      payload: {
        agentId: provider.id,
        name: 'Disputed Service',
        description: 'Service that will be disputed',
        category: 'strategy-execution',
        capabilities: [{ name: 'Exec', description: 'Strategy execution', category: 'strategy-execution' }],
        priceUsd: 100,
        pricingModel: 'performance-fee',
        performanceFeePct: 20,
      },
    });
    const serviceId = serviceRes.json().service.id;

    const disputeRes = await ctx.app.inject({
      method: 'POST',
      url: '/agent-marketplace/disputes',
      payload: {
        serviceId,
        complainantId: complainant.id,
        reason: 'Service did not deliver promised signals',
        evidence: 'No signals received in 7 days',
      },
    });

    expect(disputeRes.statusCode).toBe(201);
    const body = disputeRes.json();
    expect(body.dispute.status).toBe('open');
    expect(body.dispute.reason).toBe('Service did not deliver promised signals');
  });

  it('should resolve a dispute with refund', async () => {
    const provider = await registerAgent(ctx, 'ResolveProvider');
    const complainant = await registerAgent(ctx, 'ResolveComplainant');

    const serviceRes = await ctx.app.inject({
      method: 'POST',
      url: '/agent-marketplace/services',
      payload: {
        agentId: provider.id,
        name: 'Resolve Service',
        description: 'Will be resolved',
        category: 'signal-provider',
        capabilities: [{ name: 'Sig', description: 'Signals', category: 'signal-provider' }],
        priceUsd: 50,
        pricingModel: 'subscription',
      },
    });
    const serviceId = serviceRes.json().service.id;

    const disputeRes = await ctx.app.inject({
      method: 'POST',
      url: '/agent-marketplace/disputes',
      payload: {
        serviceId,
        complainantId: complainant.id,
        reason: 'Poor signal quality',
      },
    });
    const disputeId = disputeRes.json().dispute.id;

    const resolveRes = await ctx.app.inject({
      method: 'POST',
      url: `/agent-marketplace/disputes/${disputeId}/resolve`,
      payload: {
        resolution: 'Partial refund granted due to service downtime',
        refundPct: 50,
      },
    });

    expect(resolveRes.statusCode).toBe(200);
    const body = resolveRes.json();
    expect(body.dispute.status).toBe('resolved');
    expect(body.dispute.refundPct).toBe(50);
  });

  it('should list disputes with status filter', async () => {
    const provider = await registerAgent(ctx, 'ListDisputeProvider');
    const complainant = await registerAgent(ctx, 'ListDisputeComplainant');

    const serviceRes = await ctx.app.inject({
      method: 'POST',
      url: '/agent-marketplace/services',
      payload: {
        agentId: provider.id,
        name: 'List Dispute Service',
        description: 'For listing disputes',
        category: 'signal-provider',
        capabilities: [{ name: 'Sig', description: 'Signals', category: 'signal-provider' }],
        priceUsd: 20,
        pricingModel: 'per-signal',
      },
    });
    const serviceId = serviceRes.json().service.id;

    // Create two disputes
    await ctx.app.inject({
      method: 'POST',
      url: '/agent-marketplace/disputes',
      payload: { serviceId, complainantId: complainant.id, reason: 'Dispute 1' },
    });
    await ctx.app.inject({
      method: 'POST',
      url: '/agent-marketplace/disputes',
      payload: { serviceId, complainantId: complainant.id, reason: 'Dispute 2' },
    });

    const listRes = await ctx.app.inject({
      method: 'GET',
      url: '/agent-marketplace/disputes?status=open',
    });

    expect(listRes.statusCode).toBe(200);
    const body = listRes.json();
    expect(body.disputes.length).toBe(2);
  });

  // ── Revenue Sharing ───────────────────────────────────────────────

  it('should register service with revenue sharing collaborators', async () => {
    const owner = await registerAgent(ctx, 'RevenueOwner');
    const collab = await registerAgent(ctx, 'RevenueCollab');

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/agent-marketplace/services',
      payload: {
        agentId: owner.id,
        name: 'Collaborative Service',
        description: 'Service with revenue sharing',
        category: 'strategy-execution',
        capabilities: [{ name: 'Exec', description: 'Execution', category: 'strategy-execution' }],
        priceUsd: 200,
        pricingModel: 'performance-fee',
        performanceFeePct: 15,
        collaborators: [
          { agentId: collab.id, splitPct: 30 },
        ],
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.service.name).toBe('Collaborative Service');
  });

  // ── Leaderboard ───────────────────────────────────────────────────

  it('should return multi-criteria leaderboard', async () => {
    const agent1 = await registerAgent(ctx, 'LeaderA');
    const agent2 = await registerAgent(ctx, 'LeaderB');

    // Register services for both agents
    await ctx.app.inject({
      method: 'POST',
      url: '/agent-marketplace/services',
      payload: {
        agentId: agent1.id,
        name: 'Leader A Service',
        description: 'A service',
        category: 'signal-provider',
        capabilities: [{ name: 'Sig', description: 'Signals', category: 'signal-provider' }],
        priceUsd: 10,
        pricingModel: 'per-signal',
      },
    });
    await ctx.app.inject({
      method: 'POST',
      url: '/agent-marketplace/services',
      payload: {
        agentId: agent2.id,
        name: 'Leader B Service',
        description: 'B service',
        category: 'market-analysis',
        capabilities: [{ name: 'Analysis', description: 'Analysis', category: 'market-analysis' }],
        priceUsd: 20,
        pricingModel: 'subscription',
      },
    });

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/agent-marketplace/leaderboard',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.leaderboard.length).toBeGreaterThanOrEqual(2);
    expect(body.leaderboard[0].rank).toBe(1);
    expect(body.leaderboard[0]).toHaveProperty('totalProfit');
    expect(body.leaderboard[0]).toHaveProperty('reliability');
    expect(body.leaderboard[0]).toHaveProperty('signalQuality');
    expect(body.leaderboard[0]).toHaveProperty('reputationScore');
    expect(body.leaderboard[0]).toHaveProperty('overallScore');
  });

  it('should sort leaderboard by profit', async () => {
    await registerAgent(ctx, 'ProfitSortBot');

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/agent-marketplace/leaderboard?sortBy=profit',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.leaderboard.length).toBeGreaterThan(0);
  });

  it('should prevent disputing own service', async () => {
    const agent = await registerAgent(ctx, 'SelfDisputeBot');

    const serviceRes = await ctx.app.inject({
      method: 'POST',
      url: '/agent-marketplace/services',
      payload: {
        agentId: agent.id,
        name: 'Self Dispute Service',
        description: 'Testing self dispute prevention',
        category: 'signal-provider',
        capabilities: [{ name: 'Sig', description: 'Signals', category: 'signal-provider' }],
        priceUsd: 10,
        pricingModel: 'per-signal',
      },
    });
    const serviceId = serviceRes.json().service.id;

    const disputeRes = await ctx.app.inject({
      method: 'POST',
      url: '/agent-marketplace/disputes',
      payload: {
        serviceId,
        complainantId: agent.id,
        reason: 'Self dispute test',
      },
    });
    expect(disputeRes.statusCode).toBe(400);
  });
});
