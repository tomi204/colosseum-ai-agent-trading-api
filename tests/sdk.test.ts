import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TradingAPIClient, TradingAPIError } from '../src/sdk/index.js';

// ─── Mock fetch helper ─────────────────────────────────────────────────────

function mockFetch(status: number, body: unknown): typeof globalThis.fetch {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as unknown as typeof globalThis.fetch;
}

describe('TradingAPIClient', () => {
  const BASE = 'http://localhost:3000';

  it('constructs with string args', () => {
    const client = new TradingAPIClient(BASE, 'test-key');
    expect(client).toBeInstanceOf(TradingAPIClient);
  });

  it('constructs with options object', () => {
    const client = new TradingAPIClient({ baseUrl: BASE, apiKey: 'test-key' });
    expect(client).toBeInstanceOf(TradingAPIClient);
  });

  it('strips trailing slashes from baseUrl', async () => {
    const fetch = mockFetch(200, { status: 'ok' });
    const client = new TradingAPIClient({ baseUrl: 'http://localhost:3000///', fetch });

    await client.health();

    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:3000/health',
      expect.anything(),
    );
  });

  describe('health()', () => {
    it('returns health response', async () => {
      const body = {
        status: 'ok',
        env: 'test',
        uptimeSeconds: 42,
        pendingIntents: 0,
        processPid: 123,
        defaultMode: 'paper',
        liveModeEnabled: false,
        stateSummary: { agents: 1, intents: 5, executions: 3, receipts: 3 },
      };
      const fetch = mockFetch(200, body);
      const client = new TradingAPIClient({ baseUrl: BASE, fetch });

      const result = await client.health();
      expect(result.status).toBe('ok');
      expect(result.uptimeSeconds).toBe(42);
    });
  });

  describe('registerAgent()', () => {
    it('posts to /agents/register and returns agent + apiKey', async () => {
      const body = {
        agent: {
          id: 'agent-1',
          name: 'TestBot',
          createdAt: '2025-01-01T00:00:00Z',
          startingCapitalUsd: 10000,
          riskLimits: {},
          strategyId: 'momentum-v1',
        },
        apiKey: 'key-abc-123',
        note: 'Store apiKey securely.',
      };
      const fetch = mockFetch(201, body);
      const client = new TradingAPIClient({ baseUrl: BASE, fetch });

      const result = await client.registerAgent({ name: 'TestBot', startingCapitalUsd: 10000 });
      expect(result.agent.id).toBe('agent-1');
      expect(result.apiKey).toBe('key-abc-123');

      expect(fetch).toHaveBeenCalledWith(
        `${BASE}/agents/register`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ name: 'TestBot', startingCapitalUsd: 10000 }),
        }),
      );
    });
  });

  describe('getAgent()', () => {
    it('gets agent by ID', async () => {
      const body = { id: 'a1', name: 'Bot', createdAt: '2025-01-01T00:00:00Z' };
      const fetch = mockFetch(200, body);
      const client = new TradingAPIClient({ baseUrl: BASE, fetch });

      const result = await client.getAgent('a1');
      expect(result.id).toBe('a1');
      expect(fetch).toHaveBeenCalledWith(`${BASE}/agents/a1`, expect.anything());
    });
  });

  describe('getPortfolio()', () => {
    it('gets portfolio', async () => {
      const body = {
        agentId: 'a1',
        cashUsd: 9000,
        inventoryValueUsd: 1000,
        equityUsd: 10000,
        realizedPnlUsd: 0,
        positions: [],
        marketPricesUsd: {},
        strategyId: 'momentum-v1',
      };
      const fetch = mockFetch(200, body);
      const client = new TradingAPIClient({ baseUrl: BASE, fetch });

      const result = await client.getPortfolio('a1');
      expect(result.equityUsd).toBe(10000);
    });
  });

  describe('submitIntent()', () => {
    it('posts intent with auth header', async () => {
      const body = {
        message: 'intent_queued',
        replayed: false,
        intent: { id: 'i1', status: 'pending' },
      };
      const fetch = mockFetch(202, body);
      const client = new TradingAPIClient({ baseUrl: BASE, apiKey: 'my-key', fetch });

      const result = await client.submitIntent({
        agentId: 'a1',
        symbol: 'SOL',
        side: 'buy',
        quantity: 5,
      });

      expect(result.message).toBe('intent_queued');
      expect(result.replayed).toBe(false);

      const callArgs = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(callArgs[1].headers['authorization']).toBe('Bearer my-key');
    });

    it('passes idempotency key header', async () => {
      const body = { message: 'intent_queued', replayed: false, intent: { id: 'i2' } };
      const fetch = mockFetch(202, body);
      const client = new TradingAPIClient({ baseUrl: BASE, apiKey: 'k', fetch });

      await client.submitIntent(
        { agentId: 'a1', symbol: 'SOL', side: 'buy', quantity: 1 },
        { idempotencyKey: 'idem-123' },
      );

      const callArgs = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(callArgs[1].headers['x-idempotency-key']).toBe('idem-123');
    });
  });

  describe('getExecutions()', () => {
    it('unwraps executions array from response', async () => {
      const body = { executions: [{ id: 'e1' }, { id: 'e2' }] };
      const fetch = mockFetch(200, body);
      const client = new TradingAPIClient({ baseUrl: BASE, fetch });

      const result = await client.getExecutions({ agentId: 'a1', limit: 10 });
      expect(result).toHaveLength(2);
      expect(fetch).toHaveBeenCalledWith(
        `${BASE}/executions?agentId=a1&limit=10`,
        expect.anything(),
      );
    });

    it('works without options', async () => {
      const body = { executions: [] };
      const fetch = mockFetch(200, body);
      const client = new TradingAPIClient({ baseUrl: BASE, fetch });

      const result = await client.getExecutions();
      expect(result).toHaveLength(0);
      expect(fetch).toHaveBeenCalledWith(`${BASE}/executions`, expect.anything());
    });
  });

  describe('getReceipt()', () => {
    it('unwraps receipt from response', async () => {
      const body = {
        executionId: 'e1',
        receipt: { version: 'v1', receiptHash: 'abc123' },
      };
      const fetch = mockFetch(200, body);
      const client = new TradingAPIClient({ baseUrl: BASE, fetch });

      const result = await client.getReceipt('e1');
      expect(result.receiptHash).toBe('abc123');
    });
  });

  describe('verifyReceipt()', () => {
    it('returns verification result', async () => {
      const body = {
        ok: true,
        expectedPayloadHash: 'ph',
        expectedReceiptHash: 'rh',
        expectedSignaturePayloadHash: 'sph',
      };
      const fetch = mockFetch(200, body);
      const client = new TradingAPIClient({ baseUrl: BASE, fetch });

      const result = await client.verifyReceipt('e1');
      expect(result.ok).toBe(true);
    });
  });

  describe('updatePrice()', () => {
    it('posts price update', async () => {
      const fetch = mockFetch(200, { ok: true, marketPricesUsd: { SOL: 150 } });
      const client = new TradingAPIClient({ baseUrl: BASE, fetch });

      await client.updatePrice('SOL', 150);
      expect(fetch).toHaveBeenCalledWith(
        `${BASE}/market/prices`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ symbol: 'SOL', priceUsd: 150 }),
        }),
      );
    });
  });

  describe('autonomous', () => {
    it('getAutonomousStatus()', async () => {
      const body = { enabled: false, intervalMs: 30000, loopCount: 0, lastRunAt: null, agentStates: {} };
      const fetch = mockFetch(200, body);
      const client = new TradingAPIClient({ baseUrl: BASE, fetch });

      const result = await client.getAutonomousStatus();
      expect(result.enabled).toBe(false);
    });

    it('toggleAutonomous()', async () => {
      const body = { ok: true, autonomous: { enabled: true, intervalMs: 30000, loopCount: 0 } };
      const fetch = mockFetch(200, body);
      const client = new TradingAPIClient({ baseUrl: BASE, fetch });

      const result = await client.toggleAutonomous(true);
      expect(result.enabled).toBe(true);
    });
  });

  describe('error handling', () => {
    it('throws TradingAPIError with structured error', async () => {
      const body = {
        error: {
          code: 'AGENT_NOT_FOUND',
          message: 'Agent not found.',
        },
      };
      const fetch = mockFetch(404, body);
      const client = new TradingAPIClient({ baseUrl: BASE, fetch });

      await expect(client.getAgent('nope')).rejects.toThrow(TradingAPIError);

      try {
        await client.getAgent('nope');
      } catch (err) {
        const e = err as TradingAPIError;
        expect(e.status).toBe(404);
        expect(e.code).toBe('AGENT_NOT_FOUND');
        expect(e.message).toBe('Agent not found.');
      }
    });

    it('handles non-JSON error responses', async () => {
      const fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        json: async () => { throw new Error('not json'); },
      }) as unknown as typeof globalThis.fetch;
      const client = new TradingAPIClient({ baseUrl: BASE, fetch });

      await expect(client.health()).rejects.toThrow(TradingAPIError);
    });
  });

  describe('metrics()', () => {
    it('returns metrics response', async () => {
      const body = {
        runtime: { uptimeSeconds: 100, pendingIntents: 0, processPid: 1 },
        metrics: {
          startedAt: '2025-01-01T00:00:00Z',
          workerLoops: 10,
          intentsReceived: 5,
          intentsExecuted: 3,
          intentsRejected: 1,
          intentsFailed: 1,
          riskRejectionsByReason: {},
          apiPaymentDenials: 0,
          idempotencyReplays: 0,
          receiptCount: 3,
          quoteRetries: 0,
        },
        treasury: { totalFeesUsd: 0.15, entries: [] },
        monetization: {},
      };
      const fetch = mockFetch(200, body);
      const client = new TradingAPIClient({ baseUrl: BASE, fetch });

      const result = await client.metrics();
      expect(result.runtime.uptimeSeconds).toBe(100);
      expect(result.metrics.intentsExecuted).toBe(3);
    });
  });
});
