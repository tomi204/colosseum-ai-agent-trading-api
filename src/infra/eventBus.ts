/**
 * Simple in-memory pub/sub event bus.
 * Used by services to emit events and by the WebSocket handler to broadcast them.
 */

export type EventType =
  | 'intent.created'
  | 'intent.executed'
  | 'intent.rejected'
  | 'price.updated'
  | 'autonomous.tick'
  | 'agent.registered'
  | 'squad.created'
  | 'squad.joined'
  | 'order.limit.placed'
  | 'order.limit.filled'
  | 'order.stoploss.placed'
  | 'order.stoploss.triggered'
  | 'order.cancelled'
  | 'message.sent'
  | 'message.squad.broadcast'
  | 'mev.analyzed'
  | 'journal.entry'
  | 'alert.created'
  | 'alert.triggered'
  | 'alert.deleted'
  | 'copytrade.executed'
  | 'watchlist.added'
  | 'watchlist.removed'
  | 'improve.analyzed'
  | 'improve.applied'
  | 'improve.cycle'
  | 'tournament.created'
  | 'tournament.completed'
  | 'social.followed'
  | 'social.unfollowed';

export type EventCallback = (event: EventType, data: unknown) => void;

class EventBus {
  private listeners: Map<string, Set<EventCallback>> = new Map();
  private wildcardListeners: Set<EventCallback> = new Set();

  /**
   * Subscribe to a specific event type, or '*' for all events.
   */
  on(event: string, callback: EventCallback): () => void {
    if (event === '*') {
      this.wildcardListeners.add(callback);
      return () => {
        this.wildcardListeners.delete(callback);
      };
    }

    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(callback);

    return () => {
      this.listeners.get(event)?.delete(callback);
    };
  }

  /**
   * Emit an event to all matching subscribers.
   */
  emit(event: EventType, data: unknown): void {
    const specific = this.listeners.get(event);
    if (specific) {
      for (const cb of specific) {
        try {
          cb(event, data);
        } catch {
          // swallow errors from listeners
        }
      }
    }

    for (const cb of this.wildcardListeners) {
      try {
        cb(event, data);
      } catch {
        // swallow errors from listeners
      }
    }
  }

  /**
   * Remove all listeners. Useful for tests.
   */
  clear(): void {
    this.listeners.clear();
    this.wildcardListeners.clear();
  }
}

/** Singleton event bus instance for the application. */
export const eventBus = new EventBus();
