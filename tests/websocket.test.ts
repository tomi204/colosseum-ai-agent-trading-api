import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppContext, buildApp } from '../src/app.js';
import { AppConfig, config as baseConfig } from '../src/config.js';
import { eventBus } from '../src/infra/eventBus.js';

const makeTestConfig = (dir: string): AppConfig => ({
  ...baseConfig,
  app: { ...baseConfig.app, env: 'test', port: 0 },
  paths: {
    dataDir: dir,
    stateFile: path.join(dir, 'state.json'),
    logFile: path.join(dir, 'events.ndjson'),
  },
  worker: { ...baseConfig.worker, intervalMs: 60_000, maxBatchSize: 10 },
  trading: { ...baseConfig.trading, defaultMode: 'paper', liveEnabled: false, liveBroadcastEnabled: false },
  payments: { ...baseConfig.payments, x402Enabled: false },
});

let ctx: AppContext;
let dir: string;
let baseUrl: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(process.cwd(), '.test-ws-'));
  ctx = await buildApp(makeTestConfig(dir));
  const address = await ctx.app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = address;
});

afterEach(async () => {
  eventBus.clear();
  await ctx.app.close();
  await ctx.stateStore.flush();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('WebSocket live feed', () => {
  it('emits agent.registered event on POST /agents/register', async () => {
    // We can't easily connect WebSocket in vitest, but we can verify the event bus fires.
    const received: Array<{ event: string; data: unknown }> = [];
    eventBus.on('agent.registered', (event, data) => {
      received.push({ event, data });
    });

    await fetch(`${baseUrl}/agents/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'ws-test-bot', startingCapitalUsd: 1000 }),
    });

    expect(received).toHaveLength(1);
    expect(received[0].event).toBe('agent.registered');
    expect((received[0].data as { name: string }).name).toBe('ws-test-bot');
  });

  it('emits intent.created event on POST /trade-intents', async () => {
    const received: Array<{ event: string; data: unknown }> = [];
    eventBus.on('intent.created', (event, data) => {
      received.push({ event, data });
    });

    // Register agent
    const regRes = await fetch(`${baseUrl}/agents/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'intent-ws-bot', startingCapitalUsd: 5000 }),
    });
    const { agent, apiKey } = await regRes.json() as { agent: { id: string }; apiKey: string };

    // Set price
    await fetch(`${baseUrl}/market/prices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: 'SOL', priceUsd: 100 }),
    });

    // Submit intent
    await fetch(`${baseUrl}/trade-intents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-agent-api-key': apiKey },
      body: JSON.stringify({ agentId: agent.id, symbol: 'SOL', side: 'buy', notionalUsd: 50 }),
    });

    expect(received).toHaveLength(1);
    expect(received[0].event).toBe('intent.created');
    expect((received[0].data as { symbol: string }).symbol).toBe('SOL');
  });

  it('emits price.updated event on POST /market/prices', async () => {
    const received: Array<{ event: string; data: unknown }> = [];
    eventBus.on('price.updated', (event, data) => {
      received.push({ event, data });
    });

    await fetch(`${baseUrl}/market/prices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: 'SOL', priceUsd: 155.5 }),
    });

    expect(received).toHaveLength(1);
    expect((received[0].data as { symbol: string; priceUsd: number }).symbol).toBe('SOL');
    expect((received[0].data as { priceUsd: number }).priceUsd).toBe(155.5);
  });

  it('health endpoint includes wsClients count', async () => {
    const res = await fetch(`${baseUrl}/health`);
    const body = await res.json() as { wsClients: number };
    expect(body.wsClients).toBe(0);
  });
});
