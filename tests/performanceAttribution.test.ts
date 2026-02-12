import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppContext, buildApp } from '../src/app.js';
import { AppConfig, config as baseConfig } from '../src/config.js';

const makeTestConfig = (dir: string): AppConfig => ({
  ...baseConfig,
  app: { ...baseConfig.app, env: 'test', port: 0 },
  paths: {
    dataDir: dir,
    stateFile: path.join(dir, 'state.json'),
    logFile: path.join(dir, 'events.ndjson'),
  },
  worker: { ...baseConfig.worker, intervalMs: 40, maxBatchSize: 10 },
  trading: {
    ...baseConfig.trading,
    defaultMode: 'paper',
    liveEnabled: false,
    liveBroadcastEnabled: false,
    quoteRetryAttempts: 2,
    quoteRetryBaseDelayMs: 1,
  },
  payments: { ...baseConfig.payments, x402Enabled: false },
});

let ctx: AppContext;
let dir: string;
let baseUrl: string;

beforeEach(async () => {
  dir = path.join('tests', `tmp-perf-attr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await fs.mkdir(dir, { recursive: true });
  ctx = await buildApp(makeTestConfig(dir));
  await ctx.app.listen({ port: 0 });
  const addr = ctx.app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await ctx.app.close();
  await fs.rm(dir, { recursive: true, force: true });
});

/* ─── helpers ─────────────────────────────────────────────────────── */

async function registerAgent(name = 'attr-test-agent'): Promise<{ id: string; apiKey: string }> {
  const res = await fetch(`${baseUrl}/agents/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const data = (await res.json()) as any;
  return { id: data.agent.id, apiKey: data.apiKey };
}

async function setPrice(symbol: string, priceUsd: number) {
  await fetch(`${baseUrl}/market/prices`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol, priceUsd }),
  });
}

async function submitIntent(agentId: string, apiKey: string, symbol: string, side: 'buy' | 'sell', notionalUsd: number) {
  const res = await fetch(`${baseUrl}/trade-intents`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ agentId, symbol, side, notionalUsd }),
  });
  return (await res.json()) as any;
}

async function waitForExecution(agentId: string, minCount: number, maxWaitMs = 4000) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${baseUrl}/executions?agentId=${agentId}&limit=200`);
    const data = (await res.json()) as any;
    const filled = data.executions.filter((e: any) => e.status === 'filled');
    if (filled.length >= minCount) return filled;
    await new Promise((r) => setTimeout(r, 60));
  }
  return [];
}

/* ─── Tests ───────────────────────────────────────────────────────── */

describe('Performance Attribution Service', () => {

  // ── Return Decomposition ──────────────────────────────────────────

  it('GET /agents/:agentId/attribution/returns — 404 for unknown agent', async () => {
    const res = await fetch(`${baseUrl}/agents/no-such-agent/attribution/returns`);
    expect(res.status).toBe(404);
  });

  it('GET /agents/:agentId/attribution/returns — returns decomposition for agent with no trades', async () => {
    const { id } = await registerAgent();
    const res = await fetch(`${baseUrl}/agents/${id}/attribution/returns`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.agentId).toBe(id);
    expect(data.totalReturnPct).toBe(0);
    expect(data.alpha).toBeDefined();
    expect(data.beta).toBeDefined();
    expect(data.residual).toBeDefined();
    expect(data.riskFreeRate).toBeGreaterThan(0);
  });

  it('GET /agents/:agentId/attribution/returns — includes alpha/beta after trades', async () => {
    const { id, apiKey } = await registerAgent();
    await setPrice('SOL', 100);
    await submitIntent(id, apiKey, 'SOL', 'buy', 500);
    await waitForExecution(id, 1, 6000);
    await setPrice('SOL', 120);
    await submitIntent(id, apiKey, 'SOL', 'sell', 500);
    await waitForExecution(id, 2, 6000);

    const res = await fetch(`${baseUrl}/agents/${id}/attribution/returns`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.agentId).toBe(id);
    expect(typeof data.totalReturnPct).toBe('number');
    expect(typeof data.alpha).toBe('number');
    expect(typeof data.beta).toBe('number');
    expect(data.marketReturnPct).toBeDefined();
  }, 20000);

  // ── Factor Attribution ────────────────────────────────────────────

  it('GET /agents/:agentId/attribution/factors — 404 for unknown agent', async () => {
    const res = await fetch(`${baseUrl}/agents/ghost/attribution/factors`);
    expect(res.status).toBe(404);
  });

  it('GET /agents/:agentId/attribution/factors — returns factor breakdown', async () => {
    const { id } = await registerAgent();
    const res = await fetch(`${baseUrl}/agents/${id}/attribution/factors`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.agentId).toBe(id);
    expect(Array.isArray(data.factors)).toBe(true);
    expect(typeof data.rSquared).toBe('number');
    expect(typeof data.unexplainedReturn).toBe('number');
  });

  it('GET /agents/:agentId/attribution/factors — includes standard factors', async () => {
    const { id, apiKey } = await registerAgent();
    await setPrice('SOL', 100);
    await submitIntent(id, apiKey, 'SOL', 'buy', 200);
    await waitForExecution(id, 1, 6000);

    const res = await fetch(`${baseUrl}/agents/${id}/attribution/factors`);
    const data = (await res.json()) as any;
    const factorNames = data.factors.map((f: any) => f.factor);
    expect(factorNames).toContain('momentum');
    expect(factorNames).toContain('volatility');
    expect(factorNames).toContain('size');
    expect(factorNames).toContain('value');
  }, 15000);

  // ── Timing Analysis ───────────────────────────────────────────────

  it('GET /agents/:agentId/attribution/timing — 404 for unknown agent', async () => {
    const res = await fetch(`${baseUrl}/agents/nope/attribution/timing`);
    expect(res.status).toBe(404);
  });

  it('GET /agents/:agentId/attribution/timing — returns timing analysis', async () => {
    const { id, apiKey } = await registerAgent();
    await setPrice('SOL', 100);
    await submitIntent(id, apiKey, 'SOL', 'buy', 300);
    await waitForExecution(id, 1, 6000);

    const res = await fetch(`${baseUrl}/agents/${id}/attribution/timing`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.agentId).toBe(id);
    expect(typeof data.overallTimingScore).toBe('number');
    expect(typeof data.avgEntryTimingScore).toBe('number');
    expect(typeof data.avgExitTimingScore).toBe('number');
    expect(Array.isArray(data.entries)).toBe(true);
  }, 15000);

  // ── Strategy Attribution ──────────────────────────────────────────

  it('GET /agents/:agentId/attribution/strategies — 404 for unknown agent', async () => {
    const res = await fetch(`${baseUrl}/agents/missing/attribution/strategies`);
    expect(res.status).toBe(404);
  });

  it('GET /agents/:agentId/attribution/strategies — returns strategy contributions', async () => {
    const { id, apiKey } = await registerAgent();
    await setPrice('SOL', 100);
    await submitIntent(id, apiKey, 'SOL', 'buy', 400);
    await waitForExecution(id, 1, 6000);

    const res = await fetch(`${baseUrl}/agents/${id}/attribution/strategies`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.agentId).toBe(id);
    expect(Array.isArray(data.strategies)).toBe(true);
    expect(typeof data.totalReturnUsd).toBe('number');
  }, 15000);

  // ── Exposure Analysis ─────────────────────────────────────────────

  it('GET /agents/:agentId/attribution/exposure — returns token exposure', async () => {
    const { id, apiKey } = await registerAgent();
    await setPrice('SOL', 100);
    await submitIntent(id, apiKey, 'SOL', 'buy', 200);
    await waitForExecution(id, 1, 6000);

    const res = await fetch(`${baseUrl}/agents/${id}/attribution/exposure`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.agentId).toBe(id);
    expect(Array.isArray(data.tokens)).toBe(true);
    expect(typeof data.concentrationIndex).toBe('number');
  }, 15000);

  // ── Persistence ───────────────────────────────────────────────────

  it('GET /agents/:agentId/attribution/persistence — 404 for unknown agent', async () => {
    const res = await fetch(`${baseUrl}/agents/vanished/attribution/persistence`);
    expect(res.status).toBe(404);
  });

  it('GET /agents/:agentId/attribution/persistence — returns persistence metrics', async () => {
    const { id } = await registerAgent();
    const res = await fetch(`${baseUrl}/agents/${id}/attribution/persistence`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.agentId).toBe(id);
    expect(Array.isArray(data.windows)).toBe(true);
    expect(typeof data.persistenceScore).toBe('number');
    expect(typeof data.isConsistent).toBe('boolean');
    expect(typeof data.streakCurrent).toBe('number');
    expect(typeof data.streakLongestWin).toBe('number');
    expect(typeof data.streakLongestLoss).toBe('number');
  });

  it('GET /agents/:agentId/attribution/persistence — streak tracking after trades', async () => {
    const { id, apiKey } = await registerAgent();
    await setPrice('SOL', 100);
    await submitIntent(id, apiKey, 'SOL', 'buy', 200);
    await waitForExecution(id, 1, 6000);
    await setPrice('SOL', 110);
    await submitIntent(id, apiKey, 'SOL', 'sell', 200);
    await waitForExecution(id, 2, 6000);

    const res = await fetch(`${baseUrl}/agents/${id}/attribution/persistence`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.agentId).toBe(id);
    // With at least one profitable trade, should have data
    expect(typeof data.persistenceScore).toBe('number');
  }, 20000);
});
