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
  worker: { ...baseConfig.worker, intervalMs: 60_000, maxBatchSize: 10 },
  trading: { ...baseConfig.trading, defaultMode: 'paper', liveEnabled: false, liveBroadcastEnabled: false },
  payments: { ...baseConfig.payments, x402Enabled: false },
});

let ctx: AppContext;
let dir: string;
let baseUrl: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(process.cwd(), '.test-coord-'));
  ctx = await buildApp(makeTestConfig(dir));
  const address = await ctx.app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = address;
});

afterEach(async () => {
  await ctx.app.close();
  await ctx.stateStore.flush();
  await fs.rm(dir, { recursive: true, force: true });
});

async function registerAgent(name: string) {
  const res = await fetch(`${baseUrl}/agents/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, startingCapitalUsd: 5000 }),
  });
  return res.json() as Promise<{ agent: { id: string }; apiKey: string }>;
}

describe('Squad Coordination API', () => {
  it('creates a squad and returns it', async () => {
    const { agent } = await registerAgent('leader-bot');

    const res = await fetch(`${baseUrl}/squads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Alpha Squad', leaderId: agent.id }),
    });

    expect(res.status).toBe(201);
    const body = await res.json() as { squad: { id: string; name: string; leaderId: string; memberIds: string[] } };
    expect(body.squad.name).toBe('Alpha Squad');
    expect(body.squad.leaderId).toBe(agent.id);
    expect(body.squad.memberIds).toEqual([agent.id]);
  });

  it('allows an agent to join a squad', async () => {
    const { agent: leader } = await registerAgent('leader-bot');
    const { agent: member } = await registerAgent('member-bot');

    const createRes = await fetch(`${baseUrl}/squads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Beta Squad', leaderId: leader.id }),
    });
    const { squad } = await createRes.json() as { squad: { id: string } };

    const joinRes = await fetch(`${baseUrl}/squads/${squad.id}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: member.id }),
    });

    expect(joinRes.status).toBe(200);
    const joinBody = await joinRes.json() as { squad: { memberIds: string[] } };
    expect(joinBody.squad.memberIds).toContain(member.id);
    expect(joinBody.squad.memberIds).toContain(leader.id);
  });

  it('GET /squads/:id returns squad info', async () => {
    const { agent } = await registerAgent('scout-bot');

    const createRes = await fetch(`${baseUrl}/squads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Gamma Squad', leaderId: agent.id }),
    });
    const { squad } = await createRes.json() as { squad: { id: string } };

    const getRes = await fetch(`${baseUrl}/squads/${squad.id}`);
    expect(getRes.status).toBe(200);
    const body = await getRes.json() as { squad: { id: string; name: string } };
    expect(body.squad.id).toBe(squad.id);
    expect(body.squad.name).toBe('Gamma Squad');
  });

  it('returns 404 for unknown squad', async () => {
    const res = await fetch(`${baseUrl}/squads/nonexistent`);
    expect(res.status).toBe(404);
  });

  it('GET /squads/:id/positions returns aggregated positions', async () => {
    const { agent } = await registerAgent('pos-bot');

    const createRes = await fetch(`${baseUrl}/squads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Delta Squad', leaderId: agent.id }),
    });
    const { squad } = await createRes.json() as { squad: { id: string } };

    const posRes = await fetch(`${baseUrl}/squads/${squad.id}/positions`);
    expect(posRes.status).toBe(200);
    const body = await posRes.json() as { squadId: string; positions: unknown[] };
    expect(body.squadId).toBe(squad.id);
    expect(Array.isArray(body.positions)).toBe(true);
  });

  it('rejects duplicate squad membership', async () => {
    const { agent } = await registerAgent('dup-bot');

    const createRes = await fetch(`${baseUrl}/squads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Echo Squad', leaderId: agent.id }),
    });
    const { squad } = await createRes.json() as { squad: { id: string } };

    const joinRes = await fetch(`${baseUrl}/squads/${squad.id}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: agent.id }),
    });
    expect(joinRes.status).toBe(409);
  });
});
