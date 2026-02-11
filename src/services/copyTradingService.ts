/**
 * Social Trading / Copy Trading service.
 *
 * Agents can follow other agents and automatically copy their trades.
 * When a followed agent executes a trade, copy intents are created for
 * all followers, scaled by their copyRatio and capped by maxNotionalUsd.
 */

import { v4 as uuid } from 'uuid';
import { StateStore } from '../infra/storage/stateStore.js';
import { eventBus } from '../infra/eventBus.js';
import { isoNow } from '../utils/time.js';
import { DomainError, ErrorCode } from '../errors/taxonomy.js';

export interface CopyTradingConfig {
  copyRatio: number;       // 0.1 – 1.0: fraction of original trade to copy
  maxNotionalUsd: number;  // hard cap on notional per copy trade
}

export interface FollowRelation {
  id: string;
  followerId: string;
  targetId: string;
  copyRatio: number;
  maxNotionalUsd: number;
  createdAt: string;
}

export interface CopyTradeResult {
  id: string;
  originalIntentId: string;
  followerId: string;
  targetId: string;
  symbol: string;
  side: 'buy' | 'sell';
  notionalUsd: number;
  copyRatio: number;
  createdAt: string;
}

export class CopyTradingService {
  /** followerId → targetId → FollowRelation */
  private following: Map<string, Map<string, FollowRelation>> = new Map();
  /** targetId → Set<followerId> (reverse index) */
  private followers: Map<string, Set<string>> = new Map();
  /** All copy trade results for introspection */
  private copyTrades: CopyTradeResult[] = [];

  constructor(private readonly store: StateStore) {
    // Listen for executed intents to trigger copy trades
    eventBus.on('intent.executed', (_event, data) => {
      const payload = data as { intentId: string; agentId: string; symbol: string; side: string; notionalUsd: number };
      if (payload && payload.intentId) {
        this.processCopyTrades(payload.intentId);
      }
    });
  }

  /**
   * Start following another agent.
   */
  followAgent(followerId: string, targetId: string, config: CopyTradingConfig): FollowRelation {
    const state = this.store.snapshot();

    if (!state.agents[followerId]) {
      throw new DomainError(ErrorCode.AgentNotFound, 404, `Follower agent '${followerId}' not found.`);
    }
    if (!state.agents[targetId]) {
      throw new DomainError(ErrorCode.AgentNotFound, 404, `Target agent '${targetId}' not found.`);
    }
    if (followerId === targetId) {
      throw new DomainError(ErrorCode.InvalidPayload, 400, 'An agent cannot follow itself.');
    }
    if (config.copyRatio < 0.1 || config.copyRatio > 1.0) {
      throw new DomainError(ErrorCode.InvalidPayload, 400, 'copyRatio must be between 0.1 and 1.0.');
    }
    if (config.maxNotionalUsd <= 0) {
      throw new DomainError(ErrorCode.InvalidPayload, 400, 'maxNotionalUsd must be positive.');
    }

    // Check if already following
    const existingMap = this.following.get(followerId);
    if (existingMap?.has(targetId)) {
      throw new DomainError(ErrorCode.InvalidPayload, 400, `Agent '${followerId}' is already following '${targetId}'.`);
    }

    const relation: FollowRelation = {
      id: uuid(),
      followerId,
      targetId,
      copyRatio: config.copyRatio,
      maxNotionalUsd: config.maxNotionalUsd,
      createdAt: isoNow(),
    };

    // Update following index
    if (!this.following.has(followerId)) {
      this.following.set(followerId, new Map());
    }
    this.following.get(followerId)!.set(targetId, relation);

    // Update followers index
    if (!this.followers.has(targetId)) {
      this.followers.set(targetId, new Set());
    }
    this.followers.get(targetId)!.add(followerId);

    return relation;
  }

  /**
   * Stop following another agent.
   */
  unfollowAgent(followerId: string, targetId: string): { unfollowed: boolean } {
    const followingMap = this.following.get(followerId);
    if (!followingMap?.has(targetId)) {
      throw new DomainError(ErrorCode.AgentNotFound, 404, `Follow relation not found.`);
    }

    followingMap.delete(targetId);
    if (followingMap.size === 0) {
      this.following.delete(followerId);
    }

    const followerSet = this.followers.get(targetId);
    if (followerSet) {
      followerSet.delete(followerId);
      if (followerSet.size === 0) {
        this.followers.delete(targetId);
      }
    }

    return { unfollowed: true };
  }

  /**
   * List agents who follow this agent.
   */
  getFollowers(agentId: string): FollowRelation[] {
    const followerIds = this.followers.get(agentId);
    if (!followerIds || followerIds.size === 0) return [];

    const relations: FollowRelation[] = [];
    for (const fId of followerIds) {
      const relation = this.following.get(fId)?.get(agentId);
      if (relation) relations.push(relation);
    }
    return relations.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * List agents this agent is following.
   */
  getFollowing(agentId: string): FollowRelation[] {
    const followingMap = this.following.get(agentId);
    if (!followingMap) return [];
    return Array.from(followingMap.values())
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * When a followed agent's trade is executed, auto-create copy trades
   * for all followers scaled by their copyRatio, capped by maxNotionalUsd.
   */
  processCopyTrades(originalIntentId: string): CopyTradeResult[] {
    const state = this.store.snapshot();
    const intent = state.tradeIntents[originalIntentId];
    if (!intent) return [];

    // Find the execution for this intent to get actual notional
    const execution = Object.values(state.executions)
      .find((ex) => ex.intentId === originalIntentId && ex.status === 'filled');

    if (!execution) return [];

    const targetId = execution.agentId;
    const followerIds = this.followers.get(targetId);
    if (!followerIds || followerIds.size === 0) return [];

    const results: CopyTradeResult[] = [];

    for (const followerId of followerIds) {
      const relation = this.following.get(followerId)?.get(targetId);
      if (!relation) continue;

      // Scale by copyRatio and cap by maxNotionalUsd
      const scaledNotional = execution.grossNotionalUsd * relation.copyRatio;
      const cappedNotional = Math.min(scaledNotional, relation.maxNotionalUsd);

      if (cappedNotional <= 0) continue;

      const copyTrade: CopyTradeResult = {
        id: uuid(),
        originalIntentId,
        followerId,
        targetId,
        symbol: execution.symbol,
        side: execution.side,
        notionalUsd: Number(cappedNotional.toFixed(4)),
        copyRatio: relation.copyRatio,
        createdAt: isoNow(),
      };

      results.push(copyTrade);
      this.copyTrades.push(copyTrade);

      eventBus.emit('copytrade.executed', {
        copyTradeId: copyTrade.id,
        originalIntentId,
        followerId,
        targetId,
        symbol: copyTrade.symbol,
        side: copyTrade.side,
        notionalUsd: copyTrade.notionalUsd,
      });
    }

    return results;
  }

  /**
   * Get all copy trades (for debugging / introspection).
   */
  getCopyTrades(): CopyTradeResult[] {
    return [...this.copyTrades];
  }
}
