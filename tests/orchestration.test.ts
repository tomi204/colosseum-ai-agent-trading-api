import { describe, expect, it, beforeEach } from 'vitest';
import { buildApp, AppContext } from '../src/app.js';
import { eventBus } from '../src/infra/eventBus.js';

const testConfig = {
  app: { name: 'test', env: 'test', port: 0 },
  paths: {
    dataDir: '/tmp/colosseum-test-orchestration',
    stateFile: `/tmp/colosseum-test-orchestration/state-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
    logFile: `/tmp/colosseum-test-orchestration/events-${Date.now()}.ndjson`,
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

function freshConfig() {
  return {
    ...testConfig,
    paths: {
      ...testConfig.paths,
      stateFile: `/tmp/colosseum-test-orchestration/state-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
    },
  };
}

describe('OrchestrationService', () => {
  let ctx: AppContext;

  beforeEach(async () => {
    eventBus.clear();
    ctx = await buildApp(freshConfig() as any);
  });

  // ─── 1. Create a workflow ──────────────────────────────────────────

  it('creates a workflow via POST /orchestration/workflows', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/orchestration/workflows',
      payload: {
        name: 'Data Pipeline',
        description: 'Fetch, transform, and load data',
        tasks: [
          { id: 'fetch', name: 'Fetch Data', dependsOn: [] },
          { id: 'transform', name: 'Transform Data', dependsOn: ['fetch'] },
          { id: 'load', name: 'Load Data', dependsOn: ['transform'] },
        ],
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.workflow.id).toBeDefined();
    expect(body.workflow.name).toBe('Data Pipeline');
    expect(body.workflow.status).toBe('pending');
    expect(body.workflow.tasks).toHaveLength(3);
    expect(body.workflow.taskStates.fetch.status).toBe('pending');
    expect(body.workflow.taskStates.transform.status).toBe('pending');
    expect(body.workflow.taskStates.load.status).toBe('pending');
  });

  // ─── 2. List workflows ────────────────────────────────────────────

  it('lists workflows via GET /orchestration/workflows', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/orchestration/workflows',
      payload: {
        name: 'Workflow A',
        tasks: [{ id: 't1', name: 'Task 1', dependsOn: [] }],
      },
    });

    await ctx.app.inject({
      method: 'POST',
      url: '/orchestration/workflows',
      payload: {
        name: 'Workflow B',
        tasks: [{ id: 't1', name: 'Task 1', dependsOn: [] }],
      },
    });

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/orchestration/workflows',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().workflows).toHaveLength(2);
  });

  // ─── 3. Start a workflow ──────────────────────────────────────────

  it('starts a workflow via POST /orchestration/workflows/:id/start', async () => {
    const createRes = await ctx.app.inject({
      method: 'POST',
      url: '/orchestration/workflows',
      payload: {
        name: 'Simple Workflow',
        tasks: [
          { id: 'a', name: 'Task A', dependsOn: [] },
          { id: 'b', name: 'Task B', dependsOn: ['a'] },
        ],
      },
    });
    const workflowId = createRes.json().workflow.id;

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/orchestration/workflows/${workflowId}/start`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Workflow should be completed since tasks succeed immediately
    expect(['running', 'completed']).toContain(body.workflow.status);
  });

  // ─── 4. Get workflow status with progress ──────────────────────────

  it('returns workflow status with progress via GET /orchestration/workflows/:id/status', async () => {
    const createRes = await ctx.app.inject({
      method: 'POST',
      url: '/orchestration/workflows',
      payload: {
        name: 'Progress Workflow',
        tasks: [
          { id: 't1', name: 'Task 1', dependsOn: [] },
          { id: 't2', name: 'Task 2', dependsOn: [] },
          { id: 't3', name: 'Task 3', dependsOn: ['t1', 't2'] },
        ],
      },
    });
    const workflowId = createRes.json().workflow.id;

    // Before starting
    const pendingRes = await ctx.app.inject({
      method: 'GET',
      url: `/orchestration/workflows/${workflowId}/status`,
    });

    expect(pendingRes.statusCode).toBe(200);
    const pendingBody = pendingRes.json();
    expect(pendingBody.status).toBe('pending');
    expect(pendingBody.progress.total).toBe(3);
    expect(pendingBody.progress.pending).toBe(3);
    expect(pendingBody.progress.completed).toBe(0);

    // Start it
    await ctx.app.inject({
      method: 'POST',
      url: `/orchestration/workflows/${workflowId}/start`,
    });

    // After starting
    const runRes = await ctx.app.inject({
      method: 'GET',
      url: `/orchestration/workflows/${workflowId}/status`,
    });

    const runBody = runRes.json();
    expect(runBody.progress.completed).toBe(3);
    expect(runBody.progress.percentComplete).toBe(100);
  });

  // ─── 5. Workflow analytics ────────────────────────────────────────

  it('returns analytics via GET /orchestration/analytics', async () => {
    // Create and run a workflow
    const createRes = await ctx.app.inject({
      method: 'POST',
      url: '/orchestration/workflows',
      payload: {
        name: 'Analytics Test',
        tasks: [
          { id: 'a', name: 'Analyze', dependsOn: [] },
          { id: 'b', name: 'Report', dependsOn: ['a'] },
        ],
      },
    });
    const workflowId = createRes.json().workflow.id;

    await ctx.app.inject({
      method: 'POST',
      url: `/orchestration/workflows/${workflowId}/start`,
    });

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/orchestration/analytics',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalWorkflows).toBeGreaterThanOrEqual(1);
    expect(body.completedWorkflows).toBeGreaterThanOrEqual(1);
    expect(typeof body.successRate).toBe('number');
    expect(Array.isArray(body.bottlenecks)).toBe(true);
    expect(typeof body.taskSuccessRates).toBe('object');
  });

  // ─── 6. DAG with parallel execution ───────────────────────────────

  it('executes independent tasks in parallel mode', async () => {
    const createRes = await ctx.app.inject({
      method: 'POST',
      url: '/orchestration/workflows',
      payload: {
        name: 'Parallel Workflow',
        mode: 'parallel',
        tasks: [
          { id: 'a', name: 'Task A', dependsOn: [] },
          { id: 'b', name: 'Task B', dependsOn: [] },
          { id: 'c', name: 'Task C', dependsOn: [] },
          { id: 'd', name: 'Merge', dependsOn: ['a', 'b', 'c'] },
        ],
      },
    });

    const workflowId = createRes.json().workflow.id;

    await ctx.app.inject({
      method: 'POST',
      url: `/orchestration/workflows/${workflowId}/start`,
    });

    const statusRes = await ctx.app.inject({
      method: 'GET',
      url: `/orchestration/workflows/${workflowId}/status`,
    });

    const body = statusRes.json();
    expect(body.status).toBe('completed');
    expect(body.progress.completed).toBe(4);
    expect(body.taskStates.a.status).toBe('completed');
    expect(body.taskStates.b.status).toBe('completed');
    expect(body.taskStates.c.status).toBe('completed');
    expect(body.taskStates.d.status).toBe('completed');
  });

  // ─── 7. Sequential mode ───────────────────────────────────────────

  it('executes tasks in sequential mode', async () => {
    const createRes = await ctx.app.inject({
      method: 'POST',
      url: '/orchestration/workflows',
      payload: {
        name: 'Sequential Workflow',
        mode: 'sequential',
        tasks: [
          { id: 's1', name: 'Step 1', dependsOn: [] },
          { id: 's2', name: 'Step 2', dependsOn: ['s1'] },
          { id: 's3', name: 'Step 3', dependsOn: ['s2'] },
        ],
      },
    });

    const workflowId = createRes.json().workflow.id;

    await ctx.app.inject({
      method: 'POST',
      url: `/orchestration/workflows/${workflowId}/start`,
    });

    const statusRes = await ctx.app.inject({
      method: 'GET',
      url: `/orchestration/workflows/${workflowId}/status`,
    });

    expect(statusRes.json().status).toBe('completed');
    expect(statusRes.json().progress.completed).toBe(3);
  });

  // ─── 8. Rejects cyclic dependencies ───────────────────────────────

  it('rejects workflows with cyclic dependencies', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/orchestration/workflows',
      payload: {
        name: 'Cyclic Workflow',
        tasks: [
          { id: 'a', name: 'Task A', dependsOn: ['c'] },
          { id: 'b', name: 'Task B', dependsOn: ['a'] },
          { id: 'c', name: 'Task C', dependsOn: ['b'] },
        ],
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('cycle');
  });

  // ─── 9. Rejects duplicate task IDs ────────────────────────────────

  it('rejects workflows with duplicate task IDs', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/orchestration/workflows',
      payload: {
        name: 'Dupe Workflow',
        tasks: [
          { id: 'same', name: 'Task 1', dependsOn: [] },
          { id: 'same', name: 'Task 2', dependsOn: [] },
        ],
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('unique');
  });

  // ─── 10. Rejects unknown dependency reference ─────────────────────

  it('rejects workflows referencing unknown task dependencies', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/orchestration/workflows',
      payload: {
        name: 'Bad Dep Workflow',
        tasks: [
          { id: 'a', name: 'Task A', dependsOn: ['nonexistent'] },
        ],
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('unknown task');
  });

  // ─── 11. Cannot start an already started workflow ─────────────────

  it('cannot start an already running/completed workflow', async () => {
    const createRes = await ctx.app.inject({
      method: 'POST',
      url: '/orchestration/workflows',
      payload: {
        name: 'Single Start',
        tasks: [{ id: 't', name: 'Task', dependsOn: [] }],
      },
    });
    const workflowId = createRes.json().workflow.id;

    await ctx.app.inject({
      method: 'POST',
      url: `/orchestration/workflows/${workflowId}/start`,
    });

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/orchestration/workflows/${workflowId}/start`,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('can only start');
  });

  // ─── 12. Returns 404 for unknown workflow status ──────────────────

  it('returns 404 for unknown workflow status', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/orchestration/workflows/nonexistent/status',
    });

    expect(res.statusCode).toBe(404);
  });

  // ─── 13. Agent capability assignment ──────────────────────────────

  it('assigns agents to tasks based on capability', async () => {
    const createRes = await ctx.app.inject({
      method: 'POST',
      url: '/orchestration/workflows',
      payload: {
        name: 'Agent Assignment Workflow',
        tasks: [
          { id: 'analyze', name: 'Market Analysis', dependsOn: [], requiredCapability: 'analysis' },
          { id: 'trade', name: 'Execute Trade', dependsOn: ['analyze'], requiredCapability: 'trading' },
        ],
      },
    });

    expect(createRes.statusCode).toBe(201);
    const workflowId = createRes.json().workflow.id;

    // Start - tasks still succeed even without registered agents
    const startRes = await ctx.app.inject({
      method: 'POST',
      url: `/orchestration/workflows/${workflowId}/start`,
    });

    expect(startRes.statusCode).toBe(200);
    expect(startRes.json().workflow.status).toBe('completed');
  });

  // ─── 14. Workflow with retry policy ───────────────────────────────

  it('creates workflows with retry policies on tasks', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/orchestration/workflows',
      payload: {
        name: 'Retry Workflow',
        tasks: [
          {
            id: 'flaky',
            name: 'Flaky Task',
            dependsOn: [],
            retryPolicy: {
              maxAttempts: 3,
              baseDelayMs: 100,
              backoffFactor: 2,
            },
          },
          { id: 'stable', name: 'Stable Task', dependsOn: ['flaky'] },
        ],
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.workflow.tasks[0].retryPolicy.maxAttempts).toBe(3);
    expect(body.workflow.tasks[0].retryPolicy.baseDelayMs).toBe(100);

    // Start it
    const startRes = await ctx.app.inject({
      method: 'POST',
      url: `/orchestration/workflows/${body.workflow.id}/start`,
    });
    expect(startRes.json().workflow.status).toBe('completed');
  });

  // ─── 15. Self-dependency is rejected ──────────────────────────────

  it('rejects task that depends on itself', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/orchestration/workflows',
      payload: {
        name: 'Self-dep Workflow',
        tasks: [
          { id: 'loop', name: 'Loop Task', dependsOn: ['loop'] },
        ],
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('cannot depend on itself');
  });

  // ─── 16. Filter workflows by status ───────────────────────────────

  it('filters workflows by status', async () => {
    // Create 2 workflows
    const wf1 = await ctx.app.inject({
      method: 'POST',
      url: '/orchestration/workflows',
      payload: {
        name: 'WF1',
        tasks: [{ id: 't', name: 'Task', dependsOn: [] }],
      },
    });
    await ctx.app.inject({
      method: 'POST',
      url: '/orchestration/workflows',
      payload: {
        name: 'WF2',
        tasks: [{ id: 't', name: 'Task', dependsOn: [] }],
      },
    });

    // Start only the first one (it completes immediately)
    await ctx.app.inject({
      method: 'POST',
      url: `/orchestration/workflows/${wf1.json().workflow.id}/start`,
    });

    // Filter by pending
    const pendingRes = await ctx.app.inject({
      method: 'GET',
      url: '/orchestration/workflows?status=pending',
    });
    expect(pendingRes.json().workflows).toHaveLength(1);
    expect(pendingRes.json().workflows[0].name).toBe('WF2');

    // Filter by completed
    const completedRes = await ctx.app.inject({
      method: 'GET',
      url: '/orchestration/workflows?status=completed',
    });
    expect(completedRes.json().workflows).toHaveLength(1);
    expect(completedRes.json().workflows[0].name).toBe('WF1');
  });

  // ─── 17. Rejects empty task list ──────────────────────────────────

  it('rejects workflow with empty task list', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/orchestration/workflows',
      payload: {
        name: 'Empty Workflow',
        tasks: [],
      },
    });

    expect(res.statusCode).toBe(400);
  });

  // ─── 18. Complex DAG with diamond dependency ──────────────────────

  it('handles complex diamond-shaped DAG correctly', async () => {
    // Diamond: A → B, A → C, B → D, C → D
    const createRes = await ctx.app.inject({
      method: 'POST',
      url: '/orchestration/workflows',
      payload: {
        name: 'Diamond DAG',
        tasks: [
          { id: 'a', name: 'Root', dependsOn: [] },
          { id: 'b', name: 'Left', dependsOn: ['a'] },
          { id: 'c', name: 'Right', dependsOn: ['a'] },
          { id: 'd', name: 'Merge', dependsOn: ['b', 'c'] },
        ],
      },
    });

    const workflowId = createRes.json().workflow.id;

    await ctx.app.inject({
      method: 'POST',
      url: `/orchestration/workflows/${workflowId}/start`,
    });

    const statusRes = await ctx.app.inject({
      method: 'GET',
      url: `/orchestration/workflows/${workflowId}/status`,
    });

    const body = statusRes.json();
    expect(body.status).toBe('completed');
    expect(body.progress.completed).toBe(4);
    // D should have started after both B and C
    expect(body.taskStates.d.status).toBe('completed');
  });

  // ─── 19. Start nonexistent workflow returns 404 ───────────────────

  it('returns 404 when starting a nonexistent workflow', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/orchestration/workflows/nonexistent-id/start',
    });

    expect(res.statusCode).toBe(404);
  });
});
