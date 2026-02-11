import { v4 as uuid } from 'uuid';
import { EventLogger } from '../infra/logger.js';
import { isoNow } from '../utils/time.js';

// ─── Webhook types ──────────────────────────────────────────────────────────

export type WebhookEvent = 'intent.executed' | 'intent.rejected' | 'risk.alert' | 'autonomous.halt';

export type DeliveryStatus = 'pending' | 'delivered' | 'failed';

export interface WebhookDelivery {
  id: string;
  agentId: string;
  event: WebhookEvent;
  payload: Record<string, unknown>;
  webhookUrl: string;
  status: DeliveryStatus;
  attempts: number;
  lastAttemptAt: string | null;
  deliveredAt: string | null;
  lastError: string | null;
  createdAt: string;
}

export interface WebhookRegistration {
  agentId: string;
  webhookUrl: string;
}

// ─── Webhook service ────────────────────────────────────────────────────────

const MAX_RETRY_ATTEMPTS = 5;
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;

export class WebhookService {
  private readonly registrations: Map<string, string> = new Map(); // agentId → webhookUrl
  private readonly deliveries: Map<string, WebhookDelivery[]> = new Map(); // agentId → deliveries[]

  constructor(private readonly logger: EventLogger) {}

  register(agentId: string, webhookUrl: string): void {
    this.registrations.set(agentId, webhookUrl);
  }

  unregister(agentId: string): void {
    this.registrations.delete(agentId);
  }

  getWebhookUrl(agentId: string): string | undefined {
    return this.registrations.get(agentId);
  }

  getDeliveries(agentId: string, limit = 50): WebhookDelivery[] {
    const deliveries = this.deliveries.get(agentId) ?? [];
    return deliveries.slice(0, limit);
  }

  async emit(agentId: string, event: WebhookEvent, payload: Record<string, unknown>): Promise<void> {
    const webhookUrl = this.registrations.get(agentId);
    if (!webhookUrl) return;

    const delivery: WebhookDelivery = {
      id: uuid(),
      agentId,
      event,
      payload,
      webhookUrl,
      status: 'pending',
      attempts: 0,
      lastAttemptAt: null,
      deliveredAt: null,
      lastError: null,
      createdAt: isoNow(),
    };

    // Store delivery record
    if (!this.deliveries.has(agentId)) {
      this.deliveries.set(agentId, []);
    }
    const agentDeliveries = this.deliveries.get(agentId)!;
    agentDeliveries.unshift(delivery);

    // Cap history at 500 per agent
    if (agentDeliveries.length > 500) {
      agentDeliveries.length = 500;
    }

    // Fire-and-forget delivery with retries
    this.deliverWithRetry(delivery).catch(async (error) => {
      await this.logger.log('error', 'webhook.delivery.unhandled', {
        deliveryId: delivery.id,
        agentId,
        event,
        error: String(error),
      });
    });
  }

  private async deliverWithRetry(delivery: WebhookDelivery): Promise<void> {
    for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
      delivery.attempts += 1;
      delivery.lastAttemptAt = isoNow();

      try {
        const response = await fetch(delivery.webhookUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Webhook-Event': delivery.event,
            'X-Webhook-Delivery-Id': delivery.id,
          },
          body: JSON.stringify({
            event: delivery.event,
            deliveryId: delivery.id,
            agentId: delivery.agentId,
            payload: delivery.payload,
            timestamp: isoNow(),
          }),
          signal: AbortSignal.timeout(10_000),
        });

        if (response.ok) {
          delivery.status = 'delivered';
          delivery.deliveredAt = isoNow();

          await this.logger.log('info', 'webhook.delivered', {
            deliveryId: delivery.id,
            agentId: delivery.agentId,
            event: delivery.event,
            attempts: delivery.attempts,
          });
          return;
        }

        delivery.lastError = `HTTP ${response.status}: ${response.statusText}`;
      } catch (error) {
        delivery.lastError = error instanceof Error ? error.message : String(error);
      }

      // Exponential backoff: baseDelay * 2^attempt, capped at MAX_DELAY_MS
      if (attempt < MAX_RETRY_ATTEMPTS - 1) {
        const delay = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    delivery.status = 'failed';
    await this.logger.log('warn', 'webhook.delivery.failed', {
      deliveryId: delivery.id,
      agentId: delivery.agentId,
      event: delivery.event,
      attempts: delivery.attempts,
      lastError: delivery.lastError,
    });
  }
}
