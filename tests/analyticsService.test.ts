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
  dir = await fs.mkdtemp(path.join(process.cwd(), '.test-analytics-'));
  ctx = await buildApp(makeTestConfig(dir));
  const address = await ctx.app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = address;
});

afterEach(async () => {
  ctx.worker.stop();
  await ctx.app.close();
  await ctx.stateStore.flush();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('Analytics API', () => {
  it('returns 404 for unknown agent', async () => {
    const res = await fetch(`${baseUrl}/agents/nonexistent/analytics`);
    expect(res.status).toBe(404);
  });

  it('returns analytics for an agent with no trades', async () => {
    const regRes = await fetch(`${baseUrl}/agents/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'analytics-bot', startingCapitalUsd: 5000 }),
    });
    const { agent } = await regRes.json() as { agent: { id: string } };

    const res = await fetch(`${baseUrl}/agents/${agent.id}/analytics`);
    expect(res.status).toBe(200);

    const data = await res.json() as {
      agentId: string;
      totalTrades: number;
      winRate: number;
      sharpeRatio: null;
      sortinoRatio: null;
      dailyPnl: unknown[];
      weeklyPnl: unknown[];
    };

    expect(data.agentId).toBe(agent.id);
    expect(data.totalTrades).toBe(0);
    expect(data.winRate).toBe(0);
    expect(data.sharpeRatio).toBeNull();
    expect(data.sortinoRatio).toBeNull();
    expect(data.dailyPnl).toEqual([]);
    expect(data.weeklyPnl).toEqual([]);
  });

  it('returns analytics with correct structure after price feeds and worker runs', async () => {
    // Register agent with mean-reversion strategy (more permissive with price history)
    const regRes = await fetch(`${baseUrl}/agents/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'trade-analytics-bot', startingCapitalUsd: 10000, strategyId: 'dca-v1' }),
    });
    const { agent, apiKey } = await regRes.json() as { agent: { id: string }; apiKey: string };

    // Set price history (dca-v1 doesn't require complex signals)
    for (let i = 0; i < 5; i++) {
      await fetch(`${baseUrl}/market/prices`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: 'SOL', priceUsd: 150 + i }),
      });
    }

    // Submit a buy intent
    await fetch(`${baseUrl}/trade-intents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-agent-api-key': apiKey },
      body: JSON.stringify({ agentId: agent.id, symbol: 'SOL', side: 'buy', notionalUsd: 300 }),
    });

    // Wait for worker to process
    ctx.worker.start();
    await new Promise((r) => setTimeout(r, 300));
    ctx.worker.stop();

    const res = await fetch(`${baseUrl}/agents/${agent.id}/analytics`);
    expect(res.status).toBe(200);

    const data = await res.json() as {
      agentId: string;
      totalTrades: number;
      winRate: number;
      sharpeRatio: number | null;
      sortinoRatio: number | null;
      maxDrawdownPct: number;
      maxDrawdownDurationMs: number;
      dailyPnl: unknown[];
      weeklyPnl: unknown[];
    };

    // The structure must always be valid even if strategy rejects the trade
    expect(data.agentId).toBe(agent.id);
    expect(typeof data.totalTrades).toBe('number');
    expect(typeof data.winRate).toBe('number');
    expect(data.maxDrawdownPct).toBeGreaterThanOrEqual(0);
    expect(data.maxDrawdownDurationMs).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(data.dailyPnl)).toBe(true);
    expect(Array.isArray(data.weeklyPnl)).toBe(true);
  });
});
