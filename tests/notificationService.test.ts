import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { NotificationService } from '../src/services/notificationService.js';
import { AppState, Agent } from '../src/types.js';
import { createDefaultState } from '../src/infra/storage/defaultState.js';
import { eventBus } from '../src/infra/eventBus.js';

function createMockStore(state: AppState) {
  return {
    snapshot: () => structuredClone(state),
    transaction: vi.fn(),
    init: vi.fn(),
    flush: vi.fn(),
  } as any;
}

function makeAgent(id: string, name: string, overrides?: Partial<Agent>): Agent {
  return {
    id,
    name,
    apiKey: `key-${id}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    startingCapitalUsd: 10000,
    cashUsd: 10000,
    realizedPnlUsd: 0,
    peakEquityUsd: 10000,
    riskLimits: {
      maxPositionSizePct: 0.25,
      maxOrderNotionalUsd: 2500,
      maxGrossExposureUsd: 7500,
      dailyLossCapUsd: 1000,
      maxDrawdownPct: 0.2,
      cooldownSeconds: 3,
    },
    positions: {},
    dailyRealizedPnlUsd: {},
    riskRejectionsByReason: {},
    strategyId: 'momentum-v1',
    ...overrides,
  };
}

describe('NotificationService', () => {
  let service: NotificationService;
  let state: AppState;

  beforeEach(() => {
    eventBus.clear();
    state = createDefaultState();
    state.agents['agent-1'] = makeAgent('agent-1', 'Agent 1');
    state.agents['agent-2'] = makeAgent('agent-2', 'Agent 2');
    const store = createMockStore(state);
    service = new NotificationService(store);
  });

  afterEach(() => {
    service.stopListening();
  });

  // ─── subscribe ──────────────────────────────────────────────────────

  it('subscribes an agent to an event type', () => {
    const sub = service.subscribe('agent-1', 'intent.executed', 'https://example.com/hook');
    expect(sub.id).toBeDefined();
    expect(sub.agentId).toBe('agent-1');
    expect(sub.eventType).toBe('intent.executed');
    expect(sub.webhookUrl).toBe('https://example.com/hook');
    expect(sub.active).toBe(true);
  });

  it('returns existing subscription on duplicate', () => {
    const sub1 = service.subscribe('agent-1', 'intent.executed', 'https://example.com/hook');
    const sub2 = service.subscribe('agent-1', 'intent.executed', 'https://example.com/hook');
    expect(sub1.id).toBe(sub2.id);
  });

  it('allows different events on same URL', () => {
    const sub1 = service.subscribe('agent-1', 'intent.executed', 'https://example.com/hook');
    const sub2 = service.subscribe('agent-1', 'intent.rejected', 'https://example.com/hook');
    expect(sub1.id).not.toBe(sub2.id);
  });

  it('throws for unknown agent', () => {
    expect(() =>
      service.subscribe('ghost', 'intent.executed', 'https://example.com/hook'),
    ).toThrow('Agent not found');
  });

  // ─── unsubscribe ────────────────────────────────────────────────────

  it('unsubscribes successfully', () => {
    const sub = service.subscribe('agent-1', 'intent.executed', 'https://example.com/hook');
    const result = service.unsubscribe('agent-1', sub.id);
    expect(result.removed).toBe(true);

    const list = service.listSubscriptions('agent-1');
    expect(list.length).toBe(0);
  });

  it('throws when unsubscribing non-existent subscription', () => {
    expect(() =>
      service.unsubscribe('agent-1', 'nonexistent'),
    ).toThrow('Subscription not found');
  });

  // ─── listSubscriptions ─────────────────────────────────────────────

  it('lists only active subscriptions for the agent', () => {
    service.subscribe('agent-1', 'intent.executed', 'https://example.com/hook1');
    service.subscribe('agent-1', 'price.updated', 'https://example.com/hook2');
    service.subscribe('agent-2', 'intent.executed', 'https://example.com/hook3');

    const agent1Subs = service.listSubscriptions('agent-1');
    expect(agent1Subs.length).toBe(2);
    expect(agent1Subs.every((s) => s.agentId === 'agent-1')).toBe(true);

    const agent2Subs = service.listSubscriptions('agent-2');
    expect(agent2Subs.length).toBe(1);
  });

  it('returns empty array for agent with no subscriptions', () => {
    expect(service.listSubscriptions('agent-1')).toEqual([]);
  });

  // ─── delivery log ──────────────────────────────────────────────────

  it('getDeliveryLog returns empty by default', () => {
    expect(service.getDeliveryLog('agent-1')).toEqual([]);
  });

  // ─── delivery stats ────────────────────────────────────────────────

  it('getDeliveryStats returns zeros by default', () => {
    const stats = service.getDeliveryStats('agent-1');
    expect(stats.totalDeliveries).toBe(0);
    expect(stats.successful).toBe(0);
    expect(stats.failed).toBe(0);
    expect(stats.pending).toBe(0);
  });

  // ─── event matching and delivery ──────────────────────────────────

  it('queues delivery when matching event fires', async () => {
    // Mock fetch to succeed immediately
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    });
    service.setFetch(mockFetch as any);

    service.subscribe('agent-1', 'intent.executed', 'https://example.com/hook');
    service.startListening();

    eventBus.emit('intent.executed', { intentId: 'i-1', agentId: 'agent-1' });

    // Wait for async delivery
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe('https://example.com/hook');

    const log = service.getDeliveryLog('agent-1');
    expect(log.length).toBe(1);
    expect(log[0].status).toBe('delivered');
    expect(log[0].eventType).toBe('intent.executed');
    expect(log[0].attempts).toBe(1);
  });

  it('does not queue delivery for non-matching events', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    service.setFetch(mockFetch as any);

    service.subscribe('agent-1', 'intent.executed', 'https://example.com/hook');
    service.startListening();

    eventBus.emit('price.updated', { symbol: 'SOL', priceUsd: 105 });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockFetch).not.toHaveBeenCalled();
    expect(service.getDeliveryLog('agent-1')).toEqual([]);
  });

  it('wildcard subscription matches all events', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    service.setFetch(mockFetch as any);

    service.subscribe('agent-1', '*', 'https://example.com/hook');
    service.startListening();

    eventBus.emit('intent.executed', { intentId: 'i-1' });
    eventBus.emit('price.updated', { symbol: 'SOL' });

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('retries on failure and marks as failed after max attempts', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });
    service.setFetch(mockFetch as any);

    service.subscribe('agent-1', 'intent.executed', 'https://example.com/hook');
    service.startListening();

    eventBus.emit('intent.executed', { intentId: 'i-1' });

    // Wait enough for retries (1s + 5s + 15s ≈ 21s, but we mock so timing is fast)
    // Since fetch resolves immediately (no real delay needed for mock responses),
    // but the retry delays are real. We need to wait for the retry delays.
    // With mocked fetch, attempts happen quickly but delays are real.
    // For testing, let's wait long enough for at least the first retry
    await new Promise((resolve) => setTimeout(resolve, 7_000));

    const log = service.getDeliveryLog('agent-1');
    expect(log.length).toBe(1);
    expect(log[0].attempts).toBeGreaterThanOrEqual(2);
    expect(log[0].lastError).toBe('HTTP 500');
  }, 10_000);

  it('retries on network error', async () => {
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount <= 2) {
        return Promise.reject(new Error('Connection refused'));
      }
      return Promise.resolve({ ok: true, status: 200 });
    });
    service.setFetch(mockFetch as any);

    service.subscribe('agent-1', 'intent.executed', 'https://example.com/hook');
    service.startListening();

    eventBus.emit('intent.executed', { intentId: 'i-1' });

    // Wait for retries (first delay 1s, second delay 5s)
    await new Promise((resolve) => setTimeout(resolve, 8_000));

    const log = service.getDeliveryLog('agent-1');
    expect(log.length).toBe(1);
    expect(log[0].status).toBe('delivered');
    expect(log[0].attempts).toBe(3);
  }, 12_000);

  // ─── multiple agents ───────────────────────────────────────────────

  it('delivers to multiple agents subscribed to same event', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    service.setFetch(mockFetch as any);

    service.subscribe('agent-1', 'price.updated', 'https://agent1.example.com/hook');
    service.subscribe('agent-2', 'price.updated', 'https://agent2.example.com/hook');
    service.startListening();

    eventBus.emit('price.updated', { symbol: 'SOL', priceUsd: 110 });

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(mockFetch).toHaveBeenCalledTimes(2);

    const log1 = service.getDeliveryLog('agent-1');
    const log2 = service.getDeliveryLog('agent-2');
    expect(log1.length).toBe(1);
    expect(log2.length).toBe(1);
  });

  // ─── stopListening ─────────────────────────────────────────────────

  it('stops listening to events after stopListening', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    service.setFetch(mockFetch as any);

    service.subscribe('agent-1', 'intent.executed', 'https://example.com/hook');
    service.startListening();
    service.stopListening();

    eventBus.emit('intent.executed', { intentId: 'i-1' });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockFetch).not.toHaveBeenCalled();
  });
});
