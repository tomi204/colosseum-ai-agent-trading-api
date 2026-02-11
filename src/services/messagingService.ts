/**
 * Agent Messaging / Communication Service.
 *
 * Agents can send messages to other agents or broadcast to squads.
 * Supports typed messages: trade-signal, risk-alert, strategy-update, general.
 */

import { v4 as uuid } from 'uuid';
import { StateStore } from '../infra/storage/stateStore.js';
import { DomainError, ErrorCode } from '../errors/taxonomy.js';
import { eventBus } from '../infra/eventBus.js';
import { isoNow } from '../utils/time.js';

export type MessageType = 'trade-signal' | 'risk-alert' | 'strategy-update' | 'general';

export interface AgentMessage {
  id: string;
  from: string;
  to: string;
  type: MessageType;
  payload: Record<string, unknown>;
  read: boolean;
  createdAt: string;
}

export interface SquadMessage {
  id: string;
  from: string;
  squadId: string;
  type: MessageType;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface SendMessageInput {
  from: string;
  to: string;
  type: MessageType;
  payload: Record<string, unknown>;
}

export interface BroadcastInput {
  from: string;
  squadId: string;
  type: MessageType;
  payload: Record<string, unknown>;
}

const MAX_MESSAGES = 10_000;
const VALID_TYPES: MessageType[] = ['trade-signal', 'risk-alert', 'strategy-update', 'general'];

export class MessagingService {
  private agentMessages: AgentMessage[] = [];
  private squadMessages: SquadMessage[] = [];

  /** External lookup for squad members — injected to avoid circular deps. */
  private squadMemberLookup: ((squadId: string) => string[] | null) | null = null;

  constructor(private readonly store: StateStore) {}

  /**
   * Set the squad member lookup function (called during app init).
   */
  setSquadMemberLookup(fn: (squadId: string) => string[] | null): void {
    this.squadMemberLookup = fn;
  }

  /**
   * Send a message from one agent to another.
   */
  sendMessage(input: SendMessageInput): AgentMessage {
    const state = this.store.snapshot();

    if (!state.agents[input.from]) {
      throw new DomainError(ErrorCode.AgentNotFound, 404, 'Sender agent not found.');
    }
    if (!state.agents[input.to]) {
      throw new DomainError(ErrorCode.AgentNotFound, 404, 'Recipient agent not found.');
    }
    if (!VALID_TYPES.includes(input.type)) {
      throw new DomainError(ErrorCode.InvalidPayload, 400, `Invalid message type. Must be one of: ${VALID_TYPES.join(', ')}`);
    }

    const message: AgentMessage = {
      id: uuid(),
      from: input.from,
      to: input.to,
      type: input.type,
      payload: input.payload,
      read: false,
      createdAt: isoNow(),
    };

    this.agentMessages.push(message);
    this.trimAgentMessages();

    eventBus.emit('message.sent', {
      messageId: message.id,
      from: message.from,
      to: message.to,
      type: message.type,
    });

    return structuredClone(message);
  }

  /**
   * Broadcast a message to all members of a squad.
   */
  broadcastToSquad(input: BroadcastInput): SquadMessage {
    const state = this.store.snapshot();

    if (!state.agents[input.from]) {
      throw new DomainError(ErrorCode.AgentNotFound, 404, 'Sender agent not found.');
    }
    if (!VALID_TYPES.includes(input.type)) {
      throw new DomainError(ErrorCode.InvalidPayload, 400, `Invalid message type. Must be one of: ${VALID_TYPES.join(', ')}`);
    }

    // Verify squad exists via lookup
    if (!this.squadMemberLookup) {
      throw new DomainError(ErrorCode.InvalidPayload, 500, 'Squad lookup not configured.');
    }

    const members = this.squadMemberLookup(input.squadId);
    if (members === null) {
      throw new DomainError(ErrorCode.SquadNotFound, 404, 'Squad not found.');
    }

    if (!members.includes(input.from)) {
      throw new DomainError(ErrorCode.InvalidPayload, 403, 'Sender is not a member of this squad.');
    }

    const message: SquadMessage = {
      id: uuid(),
      from: input.from,
      squadId: input.squadId,
      type: input.type,
      payload: input.payload,
      createdAt: isoNow(),
    };

    this.squadMessages.push(message);
    this.trimSquadMessages();

    eventBus.emit('message.squad.broadcast', {
      messageId: message.id,
      from: message.from,
      squadId: message.squadId,
      type: message.type,
      memberCount: members.length,
    });

    return structuredClone(message);
  }

  /**
   * Get inbox for an agent (messages sent TO them).
   */
  getInbox(agentId: string, limit = 50): AgentMessage[] {
    return this.agentMessages
      .filter((m) => m.to === agentId)
      .slice(-limit)
      .reverse()
      .map((m) => structuredClone(m));
  }

  /**
   * Get messages for a squad.
   */
  getSquadMessages(squadId: string, limit = 50): SquadMessage[] {
    return this.squadMessages
      .filter((m) => m.squadId === squadId)
      .slice(-limit)
      .reverse()
      .map((m) => structuredClone(m));
  }

  private trimAgentMessages(): void {
    if (this.agentMessages.length > MAX_MESSAGES) {
      this.agentMessages = this.agentMessages.slice(-MAX_MESSAGES / 2);
    }
  }

  private trimSquadMessages(): void {
    if (this.squadMessages.length > MAX_MESSAGES) {
      this.squadMessages = this.squadMessages.slice(-MAX_MESSAGES / 2);
    }
  }
}
