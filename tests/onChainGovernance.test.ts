import { describe, expect, it, beforeEach } from 'vitest';
import { buildApp, AppContext } from '../src/app.js';
import { eventBus } from '../src/infra/eventBus.js';

const testConfig = {
  app: { name: 'test', env: 'test', port: 0 },
  paths: {
    dataDir: '/tmp/colosseum-test-on-chain-gov',
    stateFile: `/tmp/colosseum-test-on-chain-gov/state-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
    logFile: `/tmp/colosseum-test-on-chain-gov/events-${Date.now()}.ndjson`,
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

async function createTestApp(): Promise<AppContext> {
  return buildApp(testConfig as any);
}

function createAgentViaStore(ctx: AppContext, agentId: string): void {
  const state = ctx.stateStore.snapshot();
  state.agents[agentId] = {
    id: agentId,
    name: `Test Agent ${agentId}`,
    apiKey: `key-${agentId}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    startingCapitalUsd: 10_000,
    cashUsd: 5_000,
    realizedPnlUsd: 0,
    peakEquityUsd: 10_000,
    riskLimits: {
      maxPositionSizePct: 0.25,
      maxOrderNotionalUsd: 2500,
      maxGrossExposureUsd: 7500,
      dailyLossCapUsd: 1000,
      maxDrawdownPct: 0.2,
      cooldownSeconds: 3,
    },
    positions: {
      SOL: { symbol: 'SOL', quantity: 30, avgEntryPriceUsd: 100 },
      BONK: { symbol: 'BONK', quantity: 50_000_000, avgEntryPriceUsd: 0.00002 },
    },
    dailyRealizedPnlUsd: {},
    riskRejectionsByReason: {},
    strategyId: 'momentum-v1',
  };
  state.marketPricesUsd = { SOL: 100, USDC: 1, BONK: 0.00002, JUP: 0.8 };
  (ctx.stateStore as any).state = state;
}

describe('OnChainGovernanceService', () => {
  let ctx: AppContext;

  beforeEach(async () => {
    eventBus.clear();
    ctx = await createTestApp();
  });

  // ─── Proposals ────────────────────────────────────────────────────

  it('GET /on-chain-governance/proposals returns seeded proposals', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/on-chain-governance/proposals' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.proposals.length).toBeGreaterThanOrEqual(5);
    for (const p of body.proposals) {
      expect(p.id).toBeDefined();
      expect(p.daoName).toBeDefined();
      expect(p.title).toBeDefined();
      expect(p.status).toBeDefined();
    }
  });

  it('GET /on-chain-governance/proposals filters by status', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/on-chain-governance/proposals?status=passed',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.proposals.length).toBeGreaterThanOrEqual(1);
    for (const p of body.proposals) {
      expect(p.status).toBe('passed');
    }
  });

  it('GET /on-chain-governance/proposals filters by daoName', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/on-chain-governance/proposals?daoName=Jupiter%20DAO',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.proposals.length).toBeGreaterThanOrEqual(2);
    for (const p of body.proposals) {
      expect(p.daoName).toBe('Jupiter DAO');
    }
  });

  // ─── Analysis ─────────────────────────────────────────────────────

  it('POST /on-chain-governance/proposals/:id/analyze returns analysis', async () => {
    createAgentViaStore(ctx, 'agent-gov-1');
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/on-chain-governance/proposals/prop-jup-001/analyze',
      payload: { agentId: 'agent-gov-1' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.analysis.proposalId).toBe('prop-jup-001');
    expect(body.analysis.riskLevel).toBeDefined();
    expect(body.analysis.score).toBeGreaterThanOrEqual(0);
    expect(body.analysis.score).toBeLessThanOrEqual(100);
    expect(body.analysis.pros.length).toBeGreaterThan(0);
    expect(body.analysis.cons.length).toBeGreaterThan(0);
    expect(['for', 'against', 'abstain']).toContain(body.analysis.recommendation);
    expect(body.analysis.confidence).toBeGreaterThan(0);
    expect(body.analysis.impactAreas.length).toBeGreaterThan(0);
  });

  it('POST /on-chain-governance/proposals/:id/analyze rejects unknown proposal', async () => {
    createAgentViaStore(ctx, 'agent-gov-1');
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/on-chain-governance/proposals/nonexistent/analyze',
      payload: { agentId: 'agent-gov-1' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('POST /on-chain-governance/proposals/:id/analyze rejects unknown agent', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/on-chain-governance/proposals/prop-jup-001/analyze',
      payload: { agentId: 'ghost-agent' },
    });
    expect(res.statusCode).toBe(404);
  });

  // ─── Voting ───────────────────────────────────────────────────────

  it('POST /on-chain-governance/vote casts a vote', async () => {
    createAgentViaStore(ctx, 'agent-voter');
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/on-chain-governance/vote',
      payload: {
        agentId: 'agent-voter',
        proposalId: 'prop-jup-001',
        choice: 'for',
        votingPower: 100,
        rationale: 'Increased staking rewards align with our strategy.',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.vote.agentId).toBe('agent-voter');
    expect(body.vote.choice).toBe('for');
    expect(body.vote.votingPower).toBe(100);
  });

  it('POST /on-chain-governance/vote rejects duplicate vote', async () => {
    createAgentViaStore(ctx, 'agent-dup');
    await ctx.app.inject({
      method: 'POST',
      url: '/on-chain-governance/vote',
      payload: { agentId: 'agent-dup', proposalId: 'prop-jup-001', choice: 'for' },
    });
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/on-chain-governance/vote',
      payload: { agentId: 'agent-dup', proposalId: 'prop-jup-001', choice: 'against' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /on-chain-governance/vote rejects vote on passed proposal', async () => {
    createAgentViaStore(ctx, 'agent-late');
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/on-chain-governance/vote',
      payload: { agentId: 'agent-late', proposalId: 'prop-jup-002', choice: 'for' },
    });
    expect(res.statusCode).toBe(400);
  });

  // ─── Delegation ───────────────────────────────────────────────────

  it('POST /on-chain-governance/delegate creates delegation', async () => {
    createAgentViaStore(ctx, 'agent-del');
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/on-chain-governance/delegate',
      payload: {
        fromAgentId: 'agent-del',
        toDelegate: 'validator-xyz',
        daoName: 'Jupiter DAO',
        votingPower: 5000,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.delegation.fromAgentId).toBe('agent-del');
    expect(body.delegation.toDelegate).toBe('validator-xyz');
    expect(body.delegation.active).toBe(true);
  });

  it('GET /on-chain-governance/delegations/:agentId returns delegations', async () => {
    createAgentViaStore(ctx, 'agent-del2');
    await ctx.app.inject({
      method: 'POST',
      url: '/on-chain-governance/delegate',
      payload: {
        fromAgentId: 'agent-del2',
        toDelegate: 'validator-abc',
        daoName: 'Raydium',
        votingPower: 3000,
      },
    });
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/on-chain-governance/delegations/agent-del2',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.delegations).toHaveLength(1);
    expect(body.delegations[0].daoName).toBe('Raydium');
  });

  // ─── Calendar ─────────────────────────────────────────────────────

  it('GET /on-chain-governance/calendar returns governance events', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/on-chain-governance/calendar',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.events.length).toBeGreaterThanOrEqual(5);
    for (const event of body.events) {
      expect(event.proposalId).toBeDefined();
      expect(event.daoName).toBeDefined();
      expect(['voting-start', 'voting-end', 'execution']).toContain(event.eventType);
      expect(['upcoming', 'in-progress', 'completed']).toContain(event.status);
    }
  });

  // ─── History ──────────────────────────────────────────────────────

  it('GET /on-chain-governance/history/:agentId returns participation history', async () => {
    createAgentViaStore(ctx, 'agent-hist');

    // Cast a vote
    await ctx.app.inject({
      method: 'POST',
      url: '/on-chain-governance/vote',
      payload: { agentId: 'agent-hist', proposalId: 'prop-jup-001', choice: 'for', votingPower: 50 },
    });

    // Analyze a proposal
    await ctx.app.inject({
      method: 'POST',
      url: '/on-chain-governance/proposals/prop-marinade-001/analyze',
      payload: { agentId: 'agent-hist' },
    });

    // Delegate
    await ctx.app.inject({
      method: 'POST',
      url: '/on-chain-governance/delegate',
      payload: {
        fromAgentId: 'agent-hist',
        toDelegate: 'validator-123',
        daoName: 'Drift Protocol',
        votingPower: 1000,
      },
    });

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/on-chain-governance/history/agent-hist',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.history.agentId).toBe('agent-hist');
    expect(body.history.totalVotesCast).toBe(1);
    expect(body.history.proposalsAnalyzed).toBe(1);
    expect(body.history.activeDelegations).toBe(1);
    expect(body.history.participationRate).toBeGreaterThan(0);
    expect(body.history.votes).toHaveLength(1);
    expect(body.history.delegations).toHaveLength(1);
  });

  it('GET /on-chain-governance/history/:agentId rejects unknown agent', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/on-chain-governance/history/nonexistent',
    });
    expect(res.statusCode).toBe(404);
  });

  // ─── Protocol-upgrade analysis has high risk ─────────────────────

  it('analysis of protocol-upgrade proposal shows high risk', async () => {
    createAgentViaStore(ctx, 'agent-risk');
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/on-chain-governance/proposals/prop-raydium-001/analyze',
      payload: { agentId: 'agent-risk' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.analysis.riskLevel).toBe('high');
    expect(body.analysis.impactAreas).toContain('Smart Contracts');
  });
});
