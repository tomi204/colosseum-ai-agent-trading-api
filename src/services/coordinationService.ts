/**
 * Multi-agent squad coordination service.
 *
 * Agents can form "squads" — groups that coordinate trading.
 * - Squad leader sets shared risk limits.
 * - Members share position information.
 * - Anti-collision: prevents opposing trades on the same symbol within a squad.
 */

import { v4 as uuid } from 'uuid';
import { Squad, SharedRiskLimits, CoordinationMessage } from '../domain/coordination/squadTypes.js';
import { StateStore } from '../infra/storage/stateStore.js';
import { eventBus } from '../infra/eventBus.js';
import { DomainError, ErrorCode } from '../errors/taxonomy.js';
import { Position } from '../types.js';
import { isoNow } from '../utils/time.js';

export interface CreateSquadInput {
  name: string;
  leaderId: string;
  sharedLimits?: Partial<SharedRiskLimits>;
}

export interface JoinSquadInput {
  agentId: string;
}

export interface SquadPositionSummary {
  symbol: string;
  totalQuantity: number;
  members: Array<{
    agentId: string;
    quantity: number;
    avgEntryPriceUsd: number;
  }>;
  netSide: 'long' | 'short' | 'flat';
}

export interface CollisionCheck {
  allowed: boolean;
  reason?: string;
}

const DEFAULT_SHARED_LIMITS: SharedRiskLimits = {
  maxSquadExposureUsd: 25_000,
  maxMemberPositionPct: 0.4,
};

export class CoordinationService {
  private squads: Map<string, Squad> = new Map();
  private messages: CoordinationMessage[] = [];

  constructor(private readonly store: StateStore) {}

  createSquad(input: CreateSquadInput): Squad {
    const state = this.store.snapshot();
    const leader = state.agents[input.leaderId];
    if (!leader) {
      throw new DomainError(ErrorCode.AgentNotFound, 404, 'Leader agent not found.');
    }

    const squad: Squad = {
      id: uuid(),
      name: input.name,
      leaderId: input.leaderId,
      memberIds: [input.leaderId],
      sharedLimits: {
        ...DEFAULT_SHARED_LIMITS,
        ...input.sharedLimits,
      },
      createdAt: isoNow(),
      updatedAt: isoNow(),
    };

    this.squads.set(squad.id, squad);

    eventBus.emit('squad.created', {
      squadId: squad.id,
      name: squad.name,
      leaderId: squad.leaderId,
    });

    return squad;
  }

  getSquad(squadId: string): Squad | undefined {
    return this.squads.get(squadId);
  }

  joinSquad(squadId: string, input: JoinSquadInput): Squad {
    const squad = this.squads.get(squadId);
    if (!squad) {
      throw new DomainError(ErrorCode.InvalidPayload, 404, 'Squad not found.');
    }

    const state = this.store.snapshot();
    const agent = state.agents[input.agentId];
    if (!agent) {
      throw new DomainError(ErrorCode.AgentNotFound, 404, 'Agent not found.');
    }

    if (squad.memberIds.includes(input.agentId)) {
      throw new DomainError(ErrorCode.InvalidPayload, 409, 'Agent is already a squad member.');
    }

    squad.memberIds.push(input.agentId);
    squad.updatedAt = isoNow();

    eventBus.emit('squad.joined', {
      squadId: squad.id,
      agentId: input.agentId,
    });

    return squad;
  }

  /**
   * Get aggregated positions across all squad members.
   */
  getSquadPositions(squadId: string): SquadPositionSummary[] {
    const squad = this.squads.get(squadId);
    if (!squad) {
      throw new DomainError(ErrorCode.InvalidPayload, 404, 'Squad not found.');
    }

    const state = this.store.snapshot();
    const symbolMap = new Map<string, SquadPositionSummary>();

    for (const memberId of squad.memberIds) {
      const agent = state.agents[memberId];
      if (!agent) continue;

      for (const position of Object.values(agent.positions)) {
        if (!symbolMap.has(position.symbol)) {
          symbolMap.set(position.symbol, {
            symbol: position.symbol,
            totalQuantity: 0,
            members: [],
            netSide: 'flat',
          });
        }

        const summary = symbolMap.get(position.symbol)!;
        summary.totalQuantity += position.quantity;
        summary.members.push({
          agentId: memberId,
          quantity: position.quantity,
          avgEntryPriceUsd: position.avgEntryPriceUsd,
        });
      }
    }

    // Determine net side for each symbol
    for (const summary of symbolMap.values()) {
      summary.netSide = summary.totalQuantity > 0 ? 'long' : summary.totalQuantity < 0 ? 'short' : 'flat';
    }

    return Array.from(symbolMap.values());
  }

  /**
   * Anti-collision check: if an agent in a squad is buying a symbol,
   * another agent in the same squad cannot sell it simultaneously (and vice versa).
   */
  checkCollision(agentId: string, symbol: string, side: 'buy' | 'sell'): CollisionCheck {
    // Find squads this agent belongs to.
    const agentSquads = Array.from(this.squads.values()).filter(
      (squad) => squad.memberIds.includes(agentId),
    );

    if (agentSquads.length === 0) {
      return { allowed: true };
    }

    const state = this.store.snapshot();
    const pendingIntents = Object.values(state.tradeIntents).filter(
      (intent) => intent.status === 'pending' || intent.status === 'processing',
    );

    for (const squad of agentSquads) {
      const otherMembers = squad.memberIds.filter((id) => id !== agentId);

      for (const memberId of otherMembers) {
        // Check if any squad member has an active opposing intent on the same symbol.
        const conflicting = pendingIntents.find(
          (intent) =>
            intent.agentId === memberId &&
            intent.symbol === symbol &&
            intent.side !== side,
        );

        if (conflicting) {
          return {
            allowed: false,
            reason: `Squad collision: agent ${memberId} has a pending ${conflicting.side} intent on ${symbol} in squad '${squad.name}'.`,
          };
        }
      }
    }

    return { allowed: true };
  }

  /**
   * Post a coordination message to a squad.
   */
  postMessage(fromAgentId: string, toSquadId: string, type: CoordinationMessage['type'], payload: Record<string, unknown>): CoordinationMessage {
    const squad = this.squads.get(toSquadId);
    if (!squad) {
      throw new DomainError(ErrorCode.InvalidPayload, 404, 'Squad not found.');
    }

    if (!squad.memberIds.includes(fromAgentId)) {
      throw new DomainError(ErrorCode.InvalidPayload, 403, 'Agent is not a member of this squad.');
    }

    const message: CoordinationMessage = {
      id: uuid(),
      fromAgentId,
      toSquadId,
      type,
      payload,
      createdAt: isoNow(),
    };

    this.messages.push(message);

    // Keep message buffer bounded.
    if (this.messages.length > 1000) {
      this.messages = this.messages.slice(-500);
    }

    return message;
  }

  listSquads(): Squad[] {
    return Array.from(this.squads.values());
  }

  getMessages(squadId: string, limit = 50): CoordinationMessage[] {
    return this.messages
      .filter((m) => m.toSquadId === squadId)
      .slice(-limit);
  }
}
