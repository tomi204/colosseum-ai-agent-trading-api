import { v4 as uuid } from 'uuid';
import {
  PerformanceStats,
  StrategyListing,
  Subscription,
} from '../domain/marketplace/marketplaceTypes.js';
import { DomainError, ErrorCode } from '../errors/taxonomy.js';
import { StateStore } from '../infra/storage/stateStore.js';
import { isoNow } from '../utils/time.js';

export interface CreateListingInput {
  agentId: string;
  strategyId: string;
  description: string;
  performanceStats: PerformanceStats;
  fee: number;
}

export class MarketplaceService {
  private listings = new Map<string, StrategyListing>();
  private subscriptions: Subscription[] = [];

  constructor(private readonly store: StateStore) {}

  createListing(input: CreateListingInput): StrategyListing {
    const state = this.store.snapshot();

    // Validate agent exists
    if (!state.agents[input.agentId]) {
      throw new DomainError(
        ErrorCode.AgentNotFound,
        404,
        'Agent not found. Only registered agents can list strategies.',
      );
    }

    if (input.fee < 0) {
      throw new DomainError(
        ErrorCode.InvalidPayload,
        400,
        'Fee must be non-negative.',
      );
    }

    // Compute reputation score from agent history
    const agent = state.agents[input.agentId];
    const executions = Object.values(state.executions).filter(
      (ex) => ex.agentId === input.agentId,
    );
    const successfulExecs = executions.filter((ex) => ex.status === 'filled').length;
    const reputationScore = executions.length > 0
      ? Number(((successfulExecs / executions.length) * 100).toFixed(2))
      : 50; // Default neutral reputation

    const now = isoNow();
    const listing: StrategyListing = {
      id: uuid(),
      agentId: input.agentId,
      strategyId: input.strategyId,
      description: input.description,
      performanceStats: input.performanceStats,
      fee: input.fee,
      subscribers: [],
      reputationScore,
      createdAt: now,
      updatedAt: now,
    };

    this.listings.set(listing.id, listing);
    return listing;
  }

  listAll(): StrategyListing[] {
    return Array.from(this.listings.values())
      .sort((a, b) => b.reputationScore - a.reputationScore);
  }

  getById(listingId: string): StrategyListing | undefined {
    return this.listings.get(listingId);
  }

  subscribe(listingId: string, subscriberId: string): Subscription {
    const listing = this.listings.get(listingId);
    if (!listing) {
      throw new DomainError(
        ErrorCode.InvalidPayload,
        404,
        'Listing not found.',
      );
    }

    const state = this.store.snapshot();
    if (!state.agents[subscriberId]) {
      throw new DomainError(
        ErrorCode.AgentNotFound,
        404,
        'Subscribing agent not found.',
      );
    }

    // Prevent duplicate subscriptions
    if (listing.subscribers.includes(subscriberId)) {
      throw new DomainError(
        ErrorCode.InvalidPayload,
        409,
        'Agent is already subscribed to this listing.',
      );
    }

    // Prevent self-subscription
    if (listing.agentId === subscriberId) {
      throw new DomainError(
        ErrorCode.InvalidPayload,
        400,
        'Cannot subscribe to your own listing.',
      );
    }

    const subscription: Subscription = {
      subscriberId,
      listingId,
      subscribedAt: isoNow(),
    };

    listing.subscribers.push(subscriberId);
    listing.updatedAt = isoNow();
    this.subscriptions.push(subscription);

    return subscription;
  }

  getSubscriptions(listingId: string): Subscription[] {
    return this.subscriptions.filter((sub) => sub.listingId === listingId);
  }

  getListingWithStats(listingId: string): (StrategyListing & { subscriptionCount: number }) | undefined {
    const listing = this.listings.get(listingId);
    if (!listing) return undefined;

    return {
      ...listing,
      subscriptionCount: listing.subscribers.length,
    };
  }
}
