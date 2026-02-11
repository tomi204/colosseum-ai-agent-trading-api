/**
 * Social Trading Service.
 *
 * Builds a social graph for agents — follow/unfollow, follower lists,
 * and activity feeds from followed agents. Extends the existing copy
 * trading infrastructure with social discovery features.
 */

import { v4 as uuid } from 'uuid';
import { StateStore } from '../infra/storage/stateStore.js';
import { eventBus, EventType } from '../infra/eventBus.js';
import { isoNow } from '../utils/time.js';
import { DomainError, ErrorCode } from '../errors/taxonomy.js';

export interface SocialFollowRelation {
  id: string;
  followerId: string;
  targetId: string;
  createdAt: string;
}

export interface FeedEntry {
  id: string;
  agentId: string;
  eventType: string;
  data: Record<string, unknown>;
  createdAt: string;
}

const TRACKED_EVENTS: EventType[] = [
  'intent.created',
  'intent.executed',
  'intent.rejected',
  'copytrade.executed',
  'alert.triggered',
];

export class SocialTradingService {
  /** followerId → targetId → SocialFollowRelation */
  private following: Map<string, Map<string, SocialFollowRelation>> = new Map();
  /** targetId → Set<followerId> */
  private followers: Map<string, Set<string>> = new Map();
  /** agentId → FeedEntry[] (activity log for each agent) */
  private activityLog: Map<string, FeedEntry[]> = new Map();

  private readonly maxFeedEntries = 200;

  constructor(private readonly store: StateStore) {
    // Listen for relevant events to build activity feeds
    for (const eventType of TRACKED_EVENTS) {
      eventBus.on(eventType, (_evt, data) => {
        const payload = data as Record<string, unknown>;
        const agentId = (payload.agentId ?? payload.followerId ?? payload.targetId) as string | undefined;
        if (agentId) {
          this.recordActivity(agentId, eventType, payload);
        }
      });
    }
  }

  /**
   * Follow another agent (social follow — no copy trading config).
   */
  followAgent(followerId: string, targetId: string): SocialFollowRelation {
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

    const existingMap = this.following.get(followerId);
    if (existingMap?.has(targetId)) {
      throw new DomainError(ErrorCode.InvalidPayload, 400, `Agent '${followerId}' is already following '${targetId}'.`);
    }

    const relation: SocialFollowRelation = {
      id: uuid(),
      followerId,
      targetId,
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

    eventBus.emit('social.followed', {
      followerId,
      targetId,
      relationId: relation.id,
    });

    return relation;
  }

  /**
   * Unfollow an agent.
   */
  unfollowAgent(followerId: string, targetId: string): { unfollowed: boolean } {
    const followingMap = this.following.get(followerId);
    if (!followingMap?.has(targetId)) {
      throw new DomainError(ErrorCode.AgentNotFound, 404, 'Follow relation not found.');
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

    eventBus.emit('social.unfollowed', {
      followerId,
      targetId,
    });

    return { unfollowed: true };
  }

  /**
   * Get all agents following a given agent.
   */
  getFollowers(agentId: string): SocialFollowRelation[] {
    const followerIds = this.followers.get(agentId);
    if (!followerIds || followerIds.size === 0) return [];

    const relations: SocialFollowRelation[] = [];
    for (const fId of followerIds) {
      const relation = this.following.get(fId)?.get(agentId);
      if (relation) relations.push(relation);
    }
    return relations.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * Get all agents a given agent is following.
   */
  getFollowing(agentId: string): SocialFollowRelation[] {
    const followingMap = this.following.get(agentId);
    if (!followingMap) return [];
    return Array.from(followingMap.values())
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * Get an activity feed of recent events from agents this agent follows.
   */
  getFeed(agentId: string, limit = 50): FeedEntry[] {
    const followingMap = this.following.get(agentId);
    if (!followingMap || followingMap.size === 0) return [];

    const followedIds = Array.from(followingMap.keys());
    const allEntries: FeedEntry[] = [];

    for (const targetId of followedIds) {
      const entries = this.activityLog.get(targetId) ?? [];
      allEntries.push(...entries);
    }

    // Sort by most recent first
    allEntries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    return allEntries.slice(0, Math.min(limit, 200));
  }

  /**
   * Record an activity entry for an agent (called by event listeners).
   */
  private recordActivity(agentId: string, eventType: string, data: Record<string, unknown>): void {
    if (!this.activityLog.has(agentId)) {
      this.activityLog.set(agentId, []);
    }

    const entries = this.activityLog.get(agentId)!;
    entries.push({
      id: uuid(),
      agentId,
      eventType,
      data,
      createdAt: isoNow(),
    });

    // Trim to max size
    if (entries.length > this.maxFeedEntries) {
      entries.splice(0, entries.length - this.maxFeedEntries);
    }
  }
}
