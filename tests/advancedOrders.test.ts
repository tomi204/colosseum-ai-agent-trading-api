import { describe, expect, it, vi } from 'vitest';
import { AdvancedOrderService } from '../src/services/advancedOrderService.js';
import { shouldFillLimitOrder, shouldTriggerStopLoss, LimitOrder, StopLoss } from '../src/domain/orders/advancedOrders.js';
import { AppState, Agent } from '../src/types.js';
import { createDefaultState } from '../src/infra/storage/defaultState.js';

function createMockStore(state: AppState) {
  return {
    snapshot: () => structuredClone(state),
    transaction: vi.fn(),
    init: vi.fn(),
    flush: vi.fn(),
  } as any;
}

function makeAgent(id: string, name: string): Agent {
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
  };
}

describe('AdvancedOrderService', () => {
  function setup() {
    const state = createDefaultState();
    state.agents['agent-1'] = makeAgent('agent-1', 'Agent 1');
    state.agents['agent-2'] = makeAgent('agent-2', 'Agent 2');
    const store = createMockStore(state);
    const service = new AdvancedOrderService(store);
    return { state, store, service };
  }

  it('places a limit order successfully', () => {
    const { service } = setup();
    const order = service.placeLimitOrder({
      agentId: 'agent-1',
      symbol: 'SOL',
      side: 'buy',
      price: 95,
      notionalUsd: 500,
    });

    expect(order.id).toBeDefined();
    expect(order.agentId).toBe('agent-1');
    expect(order.symbol).toBe('SOL');
    expect(order.side).toBe('buy');
    expect(order.price).toBe(95);
    expect(order.notionalUsd).toBe(500);
    expect(order.status).toBe('open');
    expect(order.expiry).toBeDefined();
  });

  it('rejects limit order from unknown agent', () => {
    const { service } = setup();
    expect(() =>
      service.placeLimitOrder({
        agentId: 'ghost',
        symbol: 'SOL',
        side: 'buy',
        price: 95,
        notionalUsd: 500,
      }),
    ).toThrow('Agent not found');
  });

  it('places a stop-loss order successfully', () => {
    const { service } = setup();
    const sl = service.placeStopLoss({
      agentId: 'agent-1',
      symbol: 'SOL',
      triggerPrice: 80,
      notionalUsd: 1000,
    });

    expect(sl.id).toBeDefined();
    expect(sl.agentId).toBe('agent-1');
    expect(sl.symbol).toBe('SOL');
    expect(sl.triggerPrice).toBe(80);
    expect(sl.status).toBe('open');
  });

  it('fills limit buy order when price drops to target', () => {
    const { service } = setup();
    service.placeLimitOrder({
      agentId: 'agent-1',
      symbol: 'SOL',
      side: 'buy',
      price: 90,
      notionalUsd: 500,
    });

    const result = service.checkOrders({ SOL: 85 });

    expect(result.filledLimitOrders.length).toBe(1);
    expect(result.filledLimitOrders[0].status).toBe('filled');
    expect(result.filledLimitOrders[0].filledAt).toBeDefined();
  });

  it('fills limit sell order when price rises to target', () => {
    const { service } = setup();
    service.placeLimitOrder({
      agentId: 'agent-1',
      symbol: 'SOL',
      side: 'sell',
      price: 110,
      notionalUsd: 500,
    });

    const result = service.checkOrders({ SOL: 115 });

    expect(result.filledLimitOrders.length).toBe(1);
    expect(result.filledLimitOrders[0].side).toBe('sell');
    expect(result.filledLimitOrders[0].status).toBe('filled');
  });

  it('triggers stop-loss when price drops below trigger', () => {
    const { service } = setup();
    service.placeStopLoss({
      agentId: 'agent-1',
      symbol: 'SOL',
      triggerPrice: 80,
      notionalUsd: 1000,
    });

    const result = service.checkOrders({ SOL: 75 });

    expect(result.triggeredStopLosses.length).toBe(1);
    expect(result.triggeredStopLosses[0].status).toBe('triggered');
    expect(result.triggeredStopLosses[0].triggeredAt).toBeDefined();
  });

  it('cancels an open order', () => {
    const { service } = setup();
    const order = service.placeLimitOrder({
      agentId: 'agent-1',
      symbol: 'SOL',
      side: 'buy',
      price: 90,
      notionalUsd: 500,
    });

    const result = service.cancelOrder(order.id);
    expect(result.cancelled).toBe(true);
    expect(result.type).toBe('limit');

    // Verify order is now cancelled
    const orders = service.getOrders('agent-1');
    expect(orders.limitOrders[0].status).toBe('cancelled');
  });

  it('rejects cancellation of non-open order', () => {
    const { service } = setup();
    const order = service.placeLimitOrder({
      agentId: 'agent-1',
      symbol: 'SOL',
      side: 'buy',
      price: 90,
      notionalUsd: 500,
    });

    service.cancelOrder(order.id);

    expect(() => service.cancelOrder(order.id)).toThrow('Cannot cancel');
  });

  it('retrieves orders for an agent', () => {
    const { service } = setup();
    service.placeLimitOrder({
      agentId: 'agent-1',
      symbol: 'SOL',
      side: 'buy',
      price: 90,
      notionalUsd: 500,
    });
    service.placeStopLoss({
      agentId: 'agent-1',
      symbol: 'SOL',
      triggerPrice: 80,
      notionalUsd: 1000,
    });
    service.placeLimitOrder({
      agentId: 'agent-2',
      symbol: 'SOL',
      side: 'sell',
      price: 110,
      notionalUsd: 300,
    });

    const agent1Orders = service.getOrders('agent-1');
    expect(agent1Orders.limitOrders.length).toBe(1);
    expect(agent1Orders.stopLosses.length).toBe(1);

    const agent2Orders = service.getOrders('agent-2');
    expect(agent2Orders.limitOrders.length).toBe(1);
    expect(agent2Orders.stopLosses.length).toBe(0);
  });

  it('expires limit orders past expiry during checkOrders', async () => {
    const { service } = setup();
    service.placeLimitOrder({
      agentId: 'agent-1',
      symbol: 'SOL',
      side: 'buy',
      price: 90,
      notionalUsd: 500,
      expiry: new Date(Date.now() + 10).toISOString(),
    });

    // Wait for expiry
    await new Promise((resolve) => setTimeout(resolve, 30));

    const result = service.checkOrders({ SOL: 85 });
    expect(result.expiredOrders.length).toBe(1);
    expect(result.filledLimitOrders.length).toBe(0);
  });

  it('does not fill order when price does not reach target', () => {
    const { service } = setup();
    service.placeLimitOrder({
      agentId: 'agent-1',
      symbol: 'SOL',
      side: 'buy',
      price: 90,
      notionalUsd: 500,
    });

    const result = service.checkOrders({ SOL: 95 });
    expect(result.filledLimitOrders.length).toBe(0);
  });
});

describe('Domain helpers', () => {
  it('shouldFillLimitOrder returns false for non-open status', () => {
    const order: LimitOrder = {
      id: 'test',
      agentId: 'a',
      symbol: 'SOL',
      side: 'buy',
      price: 90,
      notionalUsd: 100,
      expiry: new Date(Date.now() + 100_000).toISOString(),
      status: 'filled',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    expect(shouldFillLimitOrder(order, 50)).toBe(false);
  });

  it('shouldTriggerStopLoss returns false for non-open status', () => {
    const sl: StopLoss = {
      id: 'test',
      agentId: 'a',
      symbol: 'SOL',
      triggerPrice: 80,
      notionalUsd: 100,
      status: 'triggered',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    expect(shouldTriggerStopLoss(sl, 50)).toBe(false);
  });
});
