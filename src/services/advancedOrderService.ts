/**
 * Advanced Order Service — Limit Orders & Stop-Loss management.
 *
 * Provides order placement, cancellation, monitoring, and price-triggered fills.
 * Integrates with the agent and coordination layer for risk awareness.
 */

import { v4 as uuid } from 'uuid';
import {
  LimitOrder,
  StopLoss,
  shouldFillLimitOrder,
  shouldTriggerStopLoss,
} from '../domain/orders/advancedOrders.js';
import { StateStore } from '../infra/storage/stateStore.js';
import { DomainError, ErrorCode } from '../errors/taxonomy.js';
import { eventBus } from '../infra/eventBus.js';
import { isoNow } from '../utils/time.js';

export interface PlaceLimitOrderInput {
  agentId: string;
  symbol: string;
  side: 'buy' | 'sell';
  price: number;
  notionalUsd: number;
  /** ISO timestamp for expiry. Defaults to 24h from now. */
  expiry?: string;
}

export interface PlaceStopLossInput {
  agentId: string;
  symbol: string;
  triggerPrice: number;
  notionalUsd: number;
}

export interface CheckOrdersResult {
  filledLimitOrders: LimitOrder[];
  triggeredStopLosses: StopLoss[];
  expiredOrders: LimitOrder[];
}

const DEFAULT_EXPIRY_MS = 24 * 60 * 60 * 1000;

export class AdvancedOrderService {
  private limitOrders: Map<string, LimitOrder> = new Map();
  private stopLosses: Map<string, StopLoss> = new Map();

  constructor(private readonly store: StateStore) {}

  /**
   * Place a new limit order.
   */
  placeLimitOrder(input: PlaceLimitOrderInput): LimitOrder {
    const state = this.store.snapshot();
    const agent = state.agents[input.agentId];
    if (!agent) {
      throw new DomainError(ErrorCode.AgentNotFound, 404, 'Agent not found.');
    }

    if (input.price <= 0) {
      throw new DomainError(ErrorCode.InvalidPayload, 400, 'Price must be positive.');
    }
    if (input.notionalUsd <= 0) {
      throw new DomainError(ErrorCode.InvalidPayload, 400, 'Notional USD must be positive.');
    }

    const now = isoNow();
    const expiry = input.expiry ?? new Date(Date.now() + DEFAULT_EXPIRY_MS).toISOString();

    if (new Date(expiry).getTime() <= Date.now()) {
      throw new DomainError(ErrorCode.InvalidPayload, 400, 'Expiry must be in the future.');
    }

    const order: LimitOrder = {
      id: uuid(),
      agentId: input.agentId,
      symbol: input.symbol.toUpperCase(),
      side: input.side,
      price: input.price,
      notionalUsd: input.notionalUsd,
      expiry,
      status: 'open',
      createdAt: now,
      updatedAt: now,
    };

    this.limitOrders.set(order.id, order);

    eventBus.emit('order.limit.placed', {
      orderId: order.id,
      agentId: order.agentId,
      symbol: order.symbol,
      side: order.side,
      price: order.price,
    });

    return structuredClone(order);
  }

  /**
   * Place a new stop-loss order.
   */
  placeStopLoss(input: PlaceStopLossInput): StopLoss {
    const state = this.store.snapshot();
    const agent = state.agents[input.agentId];
    if (!agent) {
      throw new DomainError(ErrorCode.AgentNotFound, 404, 'Agent not found.');
    }

    if (input.triggerPrice <= 0) {
      throw new DomainError(ErrorCode.InvalidPayload, 400, 'Trigger price must be positive.');
    }
    if (input.notionalUsd <= 0) {
      throw new DomainError(ErrorCode.InvalidPayload, 400, 'Notional USD must be positive.');
    }

    const now = isoNow();

    const stopLoss: StopLoss = {
      id: uuid(),
      agentId: input.agentId,
      symbol: input.symbol.toUpperCase(),
      triggerPrice: input.triggerPrice,
      notionalUsd: input.notionalUsd,
      status: 'open',
      createdAt: now,
      updatedAt: now,
    };

    this.stopLosses.set(stopLoss.id, stopLoss);

    eventBus.emit('order.stoploss.placed', {
      orderId: stopLoss.id,
      agentId: stopLoss.agentId,
      symbol: stopLoss.symbol,
      triggerPrice: stopLoss.triggerPrice,
    });

    return structuredClone(stopLoss);
  }

  /**
   * Scan all open orders against current market prices and trigger fills.
   */
  checkOrders(currentPrices: Record<string, number>): CheckOrdersResult {
    const result: CheckOrdersResult = {
      filledLimitOrders: [],
      triggeredStopLosses: [],
      expiredOrders: [],
    };

    // Check limit orders
    for (const order of this.limitOrders.values()) {
      if (order.status !== 'open') continue;

      // Check expiry first
      if (new Date(order.expiry).getTime() <= Date.now()) {
        order.status = 'expired';
        order.updatedAt = isoNow();
        result.expiredOrders.push(structuredClone(order));
        continue;
      }

      const price = currentPrices[order.symbol];
      if (price !== undefined && shouldFillLimitOrder(order, price)) {
        order.status = 'filled';
        order.filledAt = isoNow();
        order.updatedAt = isoNow();
        result.filledLimitOrders.push(structuredClone(order));

        eventBus.emit('order.limit.filled', {
          orderId: order.id,
          agentId: order.agentId,
          symbol: order.symbol,
          side: order.side,
          price: order.price,
          fillPrice: price,
        });
      }
    }

    // Check stop-losses
    for (const sl of this.stopLosses.values()) {
      if (sl.status !== 'open') continue;

      const price = currentPrices[sl.symbol];
      if (price !== undefined && shouldTriggerStopLoss(sl, price)) {
        sl.status = 'triggered';
        sl.triggeredAt = isoNow();
        sl.updatedAt = isoNow();
        result.triggeredStopLosses.push(structuredClone(sl));

        eventBus.emit('order.stoploss.triggered', {
          orderId: sl.id,
          agentId: sl.agentId,
          symbol: sl.symbol,
          triggerPrice: sl.triggerPrice,
          marketPrice: price,
        });
      }
    }

    return result;
  }

  /**
   * Cancel a pending order (limit or stop-loss).
   */
  cancelOrder(orderId: string): { cancelled: boolean; type: 'limit' | 'stop-loss' } {
    const limitOrder = this.limitOrders.get(orderId);
    if (limitOrder) {
      if (limitOrder.status !== 'open') {
        throw new DomainError(ErrorCode.InvalidPayload, 400, `Cannot cancel order with status '${limitOrder.status}'.`);
      }
      limitOrder.status = 'cancelled';
      limitOrder.updatedAt = isoNow();

      eventBus.emit('order.cancelled', { orderId, type: 'limit' });
      return { cancelled: true, type: 'limit' };
    }

    const stopLoss = this.stopLosses.get(orderId);
    if (stopLoss) {
      if (stopLoss.status !== 'open') {
        throw new DomainError(ErrorCode.InvalidPayload, 400, `Cannot cancel stop-loss with status '${stopLoss.status}'.`);
      }
      stopLoss.status = 'cancelled';
      stopLoss.updatedAt = isoNow();

      eventBus.emit('order.cancelled', { orderId, type: 'stop-loss' });
      return { cancelled: true, type: 'stop-loss' };
    }

    throw new DomainError(ErrorCode.InvalidPayload, 404, 'Order not found.');
  }

  /**
   * Get all orders (limit + stop-loss) for a given agent.
   */
  getOrders(agentId: string): { limitOrders: LimitOrder[]; stopLosses: StopLoss[] } {
    const limits = Array.from(this.limitOrders.values())
      .filter((o) => o.agentId === agentId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((o) => structuredClone(o));

    const stops = Array.from(this.stopLosses.values())
      .filter((o) => o.agentId === agentId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((o) => structuredClone(o));

    return { limitOrders: limits, stopLosses: stops };
  }
}
