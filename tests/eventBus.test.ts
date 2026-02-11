import { describe, it, expect, beforeEach } from 'vitest';
import { eventBus, EventType } from '../src/infra/eventBus.js';

describe('EventBus', () => {
  beforeEach(() => {
    eventBus.clear();
  });

  it('delivers events to specific listeners', () => {
    const received: Array<{ event: EventType; data: unknown }> = [];
    eventBus.on('intent.created', (event, data) => {
      received.push({ event, data });
    });

    eventBus.emit('intent.created', { intentId: '123' });
    eventBus.emit('price.updated', { symbol: 'SOL' });

    expect(received).toHaveLength(1);
    expect(received[0].event).toBe('intent.created');
    expect(received[0].data).toEqual({ intentId: '123' });
  });

  it('delivers all events to wildcard listeners', () => {
    const received: EventType[] = [];
    eventBus.on('*', (event) => {
      received.push(event);
    });

    eventBus.emit('intent.created', {});
    eventBus.emit('price.updated', {});
    eventBus.emit('agent.registered', {});

    expect(received).toEqual(['intent.created', 'price.updated', 'agent.registered']);
  });

  it('unsubscribes correctly', () => {
    const received: unknown[] = [];
    const unsub = eventBus.on('intent.executed', (_e, data) => {
      received.push(data);
    });

    eventBus.emit('intent.executed', 'first');
    unsub();
    eventBus.emit('intent.executed', 'second');

    expect(received).toEqual(['first']);
  });

  it('clear() removes all listeners', () => {
    const received: unknown[] = [];
    eventBus.on('intent.created', (_e, data) => received.push(data));
    eventBus.on('*', (_e, data) => received.push(data));

    eventBus.clear();
    eventBus.emit('intent.created', 'test');

    expect(received).toHaveLength(0);
  });

  it('swallows listener errors without affecting other listeners', () => {
    const received: unknown[] = [];

    eventBus.on('intent.created', () => {
      throw new Error('boom');
    });
    eventBus.on('intent.created', (_e, data) => {
      received.push(data);
    });

    eventBus.emit('intent.created', 'value');

    expect(received).toEqual(['value']);
  });
});
