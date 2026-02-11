/**
 * Agent Notifications & Webhook Delivery Service.
 *
 * Agents subscribe to specific event types via webhook URLs.
 * When matching events occur, webhooks are delivered with retry logic.
 */

import { v4 as uuid } from 'uuid';
import { z } from 'zod';
import { StateStore } from '../infra/storage/stateStore.js';
import { eventBus, EventType } from '../infra/eventBus.js';
import { DomainError, ErrorCode } from '../errors/taxonomy.js';
import { isoNow } from '../utils/time.js';

// ─── Schemas ────────────────────────────────────────────────────────────────

export const subscribeSchema = z.object({
  eventType: z.string().min(1).max(100),
  webhookUrl: z.string().url(),
});

// ─── Types ──────────────────────────────────────────────────────────────────

export type DeliveryStatus = 'pending' | 'delivered' | 'failed';

export interface NotificationSubscription {
  id: string;
  agentId: string;
  eventType: string;
  webhookUrl: string;
  createdAt: string;
  active: boolean;
}

export interface DeliveryLogEntry {
  id: string;
  subscriptionId: string;
  agentId: string;
  eventType: string;
  webhookUrl: string;
  payload: Record<string, unknown>;
  status: DeliveryStatus;
  statusCode: number | null;
  attempts: number;
  maxAttempts: number;
  lastAttemptAt: string | null;
  deliveredAt: string | null;
  lastError: string | null;
  createdAt: string;
}

export interface DeliveryStats {
  totalDeliveries: number;
  successful: number;
  failed: number;
  pending: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_SUBSCRIPTIONS_PER_AGENT = 50;
const MAX_RETRY_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [1_000, 5_000, 15_000]; // exponential backoff
const MAX_LOG_PER_AGENT = 500;

// ─── Service ────────────────────────────────────────────────────────────────

export class NotificationService {
  /** agentId → subscriptionId → subscription */
  private subscriptions: Map<string, Map<string, NotificationSubscription>> = new Map();
  /** agentId → delivery log entries */
  private deliveryLogs: Map<string, DeliveryLogEntry[]> = new Map();
  /** EventBus unsubscribe handle */
  private unsubscribeHandle: (() => void) | null = null;
  /** Custom fetch for testing */
  private fetchFn: typeof fetch = globalThis.fetch;

  constructor(private readonly store: StateStore) {}

  /**
   * Override fetch implementation (for testing).
   */
  setFetch(fn: typeof fetch): void {
    this.fetchFn = fn;
  }

  /**
   * Start listening to EventBus for matching subscriptions.
   */
  startListening(): void {
    if (this.unsubscribeHandle) return;
    this.unsubscribeHandle = eventBus.on('*', (event: EventType, data: unknown) => {
      this.handleEvent(event, data);
    });
  }

  /**
   * Stop listening to EventBus.
   */
  stopListening(): void {
    if (this.unsubscribeHandle) {
      this.unsubscribeHandle();
      this.unsubscribeHandle = null;
    }
  }

  /**
   * Subscribe an agent to an event type via webhook.
   */
  subscribe(agentId: string, eventType: string, webhookUrl: string): NotificationSubscription {
    const state = this.store.snapshot();
    if (!state.agents[agentId]) {
      throw new DomainError(ErrorCode.AgentNotFound, 404, 'Agent not found.');
    }

    if (!this.subscriptions.has(agentId)) {
      this.subscriptions.set(agentId, new Map());
    }

    const agentSubs = this.subscriptions.get(agentId)!;

    if (agentSubs.size >= MAX_SUBSCRIPTIONS_PER_AGENT) {
      throw new DomainError(
        ErrorCode.InvalidPayload,
        400,
        `Subscription limit reached (max ${MAX_SUBSCRIPTIONS_PER_AGENT}).`,
      );
    }

    // Check for duplicate (same eventType + webhookUrl)
    for (const sub of agentSubs.values()) {
      if (sub.active && sub.eventType === eventType && sub.webhookUrl === webhookUrl) {
        return structuredClone(sub);
      }
    }

    const subscription: NotificationSubscription = {
      id: uuid(),
      agentId,
      eventType,
      webhookUrl,
      createdAt: isoNow(),
      active: true,
    };

    agentSubs.set(subscription.id, subscription);

    return structuredClone(subscription);
  }

  /**
   * Remove a subscription.
   */
  unsubscribe(agentId: string, subscriptionId: string): { removed: boolean } {
    const agentSubs = this.subscriptions.get(agentId);
    if (!agentSubs || !agentSubs.has(subscriptionId)) {
      throw new DomainError(ErrorCode.InvalidPayload, 404, 'Subscription not found.');
    }

    agentSubs.delete(subscriptionId);
    return { removed: true };
  }

  /**
   * List active subscriptions for an agent.
   */
  listSubscriptions(agentId: string): NotificationSubscription[] {
    const agentSubs = this.subscriptions.get(agentId);
    if (!agentSubs) return [];

    return Array.from(agentSubs.values())
      .filter((sub) => sub.active)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((sub) => structuredClone(sub));
  }

  /**
   * Get delivery log for an agent.
   */
  getDeliveryLog(agentId: string, limit = 50): DeliveryLogEntry[] {
    const logs = this.deliveryLogs.get(agentId) ?? [];
    return logs.slice(0, Math.min(limit, MAX_LOG_PER_AGENT)).map((e) => structuredClone(e));
  }

  /**
   * Get delivery stats for an agent.
   */
  getDeliveryStats(agentId: string): DeliveryStats {
    const logs = this.deliveryLogs.get(agentId) ?? [];
    return {
      totalDeliveries: logs.length,
      successful: logs.filter((l) => l.status === 'delivered').length,
      failed: logs.filter((l) => l.status === 'failed').length,
      pending: logs.filter((l) => l.status === 'pending').length,
    };
  }

  /**
   * Handle an event from the EventBus. Queue webhooks for matching subscriptions.
   */
  private handleEvent(event: EventType, data: unknown): void {
    for (const [agentId, agentSubs] of this.subscriptions) {
      for (const sub of agentSubs.values()) {
        if (!sub.active) continue;
        if (sub.eventType !== event && sub.eventType !== '*') continue;

        const payload = (data && typeof data === 'object' ? data : { data }) as Record<string, unknown>;
        this.queueDelivery(sub, event, payload);
      }
    }
  }

  /**
   * Queue a webhook delivery with retries.
   */
  private queueDelivery(
    sub: NotificationSubscription,
    eventType: string,
    payload: Record<string, unknown>,
  ): void {
    const entry: DeliveryLogEntry = {
      id: uuid(),
      subscriptionId: sub.id,
      agentId: sub.agentId,
      eventType,
      webhookUrl: sub.webhookUrl,
      payload,
      status: 'pending',
      statusCode: null,
      attempts: 0,
      maxAttempts: MAX_RETRY_ATTEMPTS,
      lastAttemptAt: null,
      deliveredAt: null,
      lastError: null,
      createdAt: isoNow(),
    };

    if (!this.deliveryLogs.has(sub.agentId)) {
      this.deliveryLogs.set(sub.agentId, []);
    }

    const logs = this.deliveryLogs.get(sub.agentId)!;
    logs.unshift(entry);

    // Cap log size
    if (logs.length > MAX_LOG_PER_AGENT) {
      logs.length = MAX_LOG_PER_AGENT;
    }

    // Fire-and-forget delivery
    this.deliverWithRetry(entry).catch(() => {
      // swallow unhandled errors
    });
  }

  /**
   * Deliver a webhook with retry logic: 3 attempts at 1s, 5s, 15s.
   */
  private async deliverWithRetry(entry: DeliveryLogEntry): Promise<void> {
    for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
      entry.attempts += 1;
      entry.lastAttemptAt = isoNow();

      try {
        const response = await this.fetchFn(entry.webhookUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Event-Type': entry.eventType,
            'X-Delivery-Id': entry.id,
            'X-Subscription-Id': entry.subscriptionId,
          },
          body: JSON.stringify({
            event: entry.eventType,
            deliveryId: entry.id,
            subscriptionId: entry.subscriptionId,
            agentId: entry.agentId,
            payload: entry.payload,
            timestamp: isoNow(),
          }),
          signal: AbortSignal.timeout(10_000),
        });

        entry.statusCode = response.status;

        if (response.ok) {
          entry.status = 'delivered';
          entry.deliveredAt = isoNow();
          return;
        }

        entry.lastError = `HTTP ${response.status}`;
      } catch (error) {
        entry.lastError = error instanceof Error ? error.message : String(error);
      }

      // Wait before retry (except on last attempt)
      if (attempt < MAX_RETRY_ATTEMPTS - 1) {
        const delay = RETRY_DELAYS_MS[attempt] ?? 15_000;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    entry.status = 'failed';
  }
}
