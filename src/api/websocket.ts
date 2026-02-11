/**
 * WebSocket live event feed.
 * Broadcasts real-time events (intent.created, intent.executed, price.updated, etc.)
 * to all connected WebSocket clients.
 */

import type { FastifyInstance } from 'fastify';
import { eventBus, EventType } from '../infra/eventBus.js';

interface WSLike {
  readyState: number;
  send(data: string): void;
  on(event: string, cb: () => void): void;
}

const clients = new Set<WSLike>();

/** Number of currently connected WebSocket clients. */
export function connectedClients(): number {
  return clients.size;
}

/**
 * Register the WebSocket endpoint and subscribe to the event bus.
 * Must be called AFTER @fastify/websocket is registered on the Fastify instance.
 */
export async function registerWebSocket(app: FastifyInstance): Promise<void> {
  // Subscribe to ALL events on the bus and broadcast to connected clients.
  eventBus.on('*', (event: EventType, data: unknown) => {
    const message = JSON.stringify({
      type: event,
      data,
      ts: new Date().toISOString(),
    });

    for (const ws of clients) {
      if (ws.readyState === 1 /* OPEN */) {
        ws.send(message);
      }
    }
  });

  app.get('/ws', { websocket: true }, (socket: WSLike) => {
    clients.add(socket);

    // Send a welcome message with the current client count.
    socket.send(JSON.stringify({
      type: 'connected',
      data: { clients: clients.size },
      ts: new Date().toISOString(),
    }));

    socket.on('close', () => {
      clients.delete(socket);
    });

    socket.on('error', () => {
      clients.delete(socket);
    });
  });
}
