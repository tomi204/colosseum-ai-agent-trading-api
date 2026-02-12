/**
 * Agent Marketplace & Reputation V2 Service.
 *
 * An economy where agents trade services:
 * - Agent capability registry (what each agent can do)
 * - Service pricing (agents set prices for signals/strategies/analysis)
 * - Reputation V2 with decay (old ratings matter less) + weighted reviews
 * - Dispute resolution system (raise/resolve disputes on service quality)
 * - Revenue sharing for agent collaborations
 * - Leaderboard with multiple ranking criteria
 */

import { v4 as uuid } from 'uuid';
import { DomainError, ErrorCode } from '../errors/taxonomy.js';
import { StateStore } from '../infra/storage/stateStore.js';
import { isoNow } from '../utils/time.js';

// ─── Types ──────────────────────────────────────────────────────────────

export type ServiceCategory =
  | 'signal-provider'
  | 'strategy-execution'
  | 'market-analysis'
  | 'risk-assessment'
  | 'portfolio-management'
  | 'data-feed'
  | 'arbitrage-detection'
  | 'sentiment-analysis';

export type DisputeStatus = 'open' | 'resolved' | 'dismissed';

export interface AgentCapability {
  name: string;
  description: string;
  category: ServiceCategory;
}

export interface AgentServiceListing {
  id: string;
  agentId: string;
  name: string;
  description: string;
  category: ServiceCategory;
  capabilities: AgentCapability[];
  priceUsd: number;
  pricingModel: 'per-signal' | 'subscription' | 'performance-fee';
  performanceFeePct?: number;
  isActive: boolean;
  reviews: ServiceReview[];
  reputationScore: number;
  totalRevenue: number;
  subscriberCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ServiceReview {
  id: string;
  serviceId: string;
  reviewerId: string;
  rating: number; // 1–5
  comment: string;
  weight: number; // Weighted by reviewer reputation
  createdAt: string;
}

export interface ServiceDispute {
  id: string;
  serviceId: string;
  complainantId: string;
  providerId: string;
  reason: string;
  evidence?: string;
  status: DisputeStatus;
  resolution?: string;
  refundPct?: number;
  createdAt: string;
  resolvedAt?: string;
}

export interface RevenueShare {
  id: string;
  serviceId: string;
  collaboratorIds: string[];
  splitPcts: Record<string, number>; // agentId → percentage
  totalEarnedUsd: number;
  createdAt: string;
}

export interface LeaderboardEntry {
  rank: number;
  agentId: string;
  totalProfit: number;
  reliability: number; // 0–100
  signalQuality: number; // 0–100
  reputationScore: number; // 0–1000
  serviceCount: number;
  disputeRate: number; // lower is better
  overallScore: number;
}

export interface CreateServiceInput {
  agentId: string;
  name: string;
  description: string;
  category: ServiceCategory;
  capabilities: AgentCapability[];
  priceUsd: number;
  pricingModel: 'per-signal' | 'subscription' | 'performance-fee';
  performanceFeePct?: number;
  collaborators?: Array<{ agentId: string; splitPct: number }>;
}

export interface ReviewInput {
  reviewerId: string;
  rating: number;
  comment: string;
}

export interface CreateDisputeInput {
  serviceId: string;
  complainantId: string;
  reason: string;
  evidence?: string;
}

export interface ResolveDisputeInput {
  resolution: string;
  refundPct?: number;
}

// ─── Constants ──────────────────────────────────────────────────────────

/** Half-life for review decay in milliseconds (30 days). */
const REVIEW_DECAY_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;

/** Minimum reviewer reputation weight. */
const MIN_REVIEW_WEIGHT = 0.1;

/** Maximum reputation score. */
const MAX_REPUTATION = 1000;

// ─── Service ────────────────────────────────────────────────────────────

export class AgentMarketplaceService {
  private services = new Map<string, AgentServiceListing>();
  private disputes = new Map<string, ServiceDispute>();
  private revenueShares = new Map<string, RevenueShare>();

  constructor(private readonly store: StateStore) {}

  // ── Service Registration ──────────────────────────────────────────

  registerService(input: CreateServiceInput): AgentServiceListing {
    const state = this.store.snapshot();

    if (!state.agents[input.agentId]) {
      throw new DomainError(ErrorCode.AgentNotFound, 404, `Agent '${input.agentId}' not found.`);
    }

    if (input.priceUsd < 0) {
      throw new DomainError(ErrorCode.InvalidPayload, 400, 'Price must be non-negative.');
    }

    if (input.pricingModel === 'performance-fee') {
      if (input.performanceFeePct === undefined || input.performanceFeePct < 0 || input.performanceFeePct > 100) {
        throw new DomainError(ErrorCode.InvalidPayload, 400, 'performanceFeePct must be between 0 and 100 for performance-fee model.');
      }
    }

    if (!input.capabilities || input.capabilities.length === 0) {
      throw new DomainError(ErrorCode.InvalidPayload, 400, 'At least one capability is required.');
    }

    const now = isoNow();
    const service: AgentServiceListing = {
      id: uuid(),
      agentId: input.agentId,
      name: input.name,
      description: input.description,
      category: input.category,
      capabilities: input.capabilities,
      priceUsd: input.priceUsd,
      pricingModel: input.pricingModel,
      performanceFeePct: input.performanceFeePct,
      isActive: true,
      reviews: [],
      reputationScore: 500, // Start at neutral
      totalRevenue: 0,
      subscriberCount: 0,
      createdAt: now,
      updatedAt: now,
    };

    this.services.set(service.id, service);

    // Set up revenue sharing if collaborators specified
    if (input.collaborators && input.collaborators.length > 0) {
      const totalSplit = input.collaborators.reduce((sum, c) => sum + c.splitPct, 0);
      if (totalSplit > 100) {
        throw new DomainError(ErrorCode.InvalidPayload, 400, 'Total collaborator split cannot exceed 100%.');
      }
      // Validate all collaborator agents exist
      for (const collab of input.collaborators) {
        if (!state.agents[collab.agentId]) {
          throw new DomainError(ErrorCode.AgentNotFound, 404, `Collaborator agent '${collab.agentId}' not found.`);
        }
      }

      const splits: Record<string, number> = {};
      const collabIds: string[] = [];
      for (const collab of input.collaborators) {
        splits[collab.agentId] = collab.splitPct;
        collabIds.push(collab.agentId);
      }
      // Remaining goes to service owner
      splits[input.agentId] = 100 - totalSplit;
      collabIds.push(input.agentId);

      const share: RevenueShare = {
        id: uuid(),
        serviceId: service.id,
        collaboratorIds: collabIds,
        splitPcts: splits,
        totalEarnedUsd: 0,
        createdAt: now,
      };
      this.revenueShares.set(share.id, share);
    }

    return structuredClone(service);
  }

  // ── Browse / Query ────────────────────────────────────────────────

  listServices(filters?: {
    category?: ServiceCategory;
    agentId?: string;
    minReputation?: number;
    activeOnly?: boolean;
  }): AgentServiceListing[] {
    let results = Array.from(this.services.values());

    if (filters?.category) {
      results = results.filter((s) => s.category === filters.category);
    }
    if (filters?.agentId) {
      results = results.filter((s) => s.agentId === filters.agentId);
    }
    if (filters?.minReputation !== undefined) {
      results = results.filter((s) => s.reputationScore >= filters.minReputation!);
    }
    if (filters?.activeOnly !== false) {
      results = results.filter((s) => s.isActive);
    }

    return results
      .sort((a, b) => b.reputationScore - a.reputationScore)
      .map((s) => structuredClone(s));
  }

  getService(serviceId: string): AgentServiceListing | null {
    const service = this.services.get(serviceId);
    return service ? structuredClone(service) : null;
  }

  // ── Reviews & Reputation V2 ───────────────────────────────────────

  reviewService(serviceId: string, input: ReviewInput): ServiceReview {
    const service = this.services.get(serviceId);
    if (!service) {
      throw new DomainError(ErrorCode.ListingNotFound, 404, `Service '${serviceId}' not found.`);
    }

    const state = this.store.snapshot();
    if (!state.agents[input.reviewerId]) {
      throw new DomainError(ErrorCode.AgentNotFound, 404, `Reviewer agent '${input.reviewerId}' not found.`);
    }

    if (input.reviewerId === service.agentId) {
      throw new DomainError(ErrorCode.InvalidPayload, 400, 'Cannot review your own service.');
    }

    if (input.rating < 1 || input.rating > 5) {
      throw new DomainError(ErrorCode.InvalidPayload, 400, 'Rating must be between 1 and 5.');
    }

    // Calculate reviewer weight based on their activity (proxy for reputation)
    const reviewerExecs = Object.values(state.executions)
      .filter((ex) => ex.agentId === input.reviewerId && ex.status === 'filled');
    const reviewerWeight = Math.max(MIN_REVIEW_WEIGHT, Math.min(1, reviewerExecs.length / 50));

    const review: ServiceReview = {
      id: uuid(),
      serviceId,
      reviewerId: input.reviewerId,
      rating: input.rating,
      comment: input.comment,
      weight: reviewerWeight,
      createdAt: isoNow(),
    };

    service.reviews.push(review);
    service.updatedAt = isoNow();

    // Recalculate reputation with decay
    this.recalculateReputation(service);

    return structuredClone(review);
  }

  /**
   * Reputation V2: Weighted reviews with time decay.
   * Old ratings matter less — exponential decay based on age.
   */
  private recalculateReputation(service: AgentServiceListing): void {
    if (service.reviews.length === 0) {
      service.reputationScore = 500;
      return;
    }

    const now = Date.now();
    let weightedSum = 0;
    let totalWeight = 0;

    for (const review of service.reviews) {
      const ageMs = now - new Date(review.createdAt).getTime();
      // Exponential decay: weight halves every REVIEW_DECAY_HALF_LIFE_MS
      const decayFactor = Math.pow(0.5, ageMs / REVIEW_DECAY_HALF_LIFE_MS);
      const effectiveWeight = review.weight * decayFactor;

      weightedSum += review.rating * effectiveWeight;
      totalWeight += effectiveWeight;
    }

    if (totalWeight === 0) {
      service.reputationScore = 500;
      return;
    }

    // Convert 1–5 rating to 0–1000 scale
    const avgRating = weightedSum / totalWeight;
    service.reputationScore = Math.round(((avgRating - 1) / 4) * MAX_REPUTATION);
  }

  // ── Dispute Resolution ────────────────────────────────────────────

  raiseDispute(input: CreateDisputeInput): ServiceDispute {
    const service = this.services.get(input.serviceId);
    if (!service) {
      throw new DomainError(ErrorCode.ListingNotFound, 404, `Service '${input.serviceId}' not found.`);
    }

    const state = this.store.snapshot();
    if (!state.agents[input.complainantId]) {
      throw new DomainError(ErrorCode.AgentNotFound, 404, `Complainant agent '${input.complainantId}' not found.`);
    }

    if (input.complainantId === service.agentId) {
      throw new DomainError(ErrorCode.InvalidPayload, 400, 'Cannot dispute your own service.');
    }

    const dispute: ServiceDispute = {
      id: uuid(),
      serviceId: input.serviceId,
      complainantId: input.complainantId,
      providerId: service.agentId,
      reason: input.reason,
      evidence: input.evidence,
      status: 'open',
      createdAt: isoNow(),
    };

    this.disputes.set(dispute.id, dispute);
    return structuredClone(dispute);
  }

  listDisputes(filters?: {
    serviceId?: string;
    status?: DisputeStatus;
    agentId?: string;
  }): ServiceDispute[] {
    let results = Array.from(this.disputes.values());

    if (filters?.serviceId) {
      results = results.filter((d) => d.serviceId === filters.serviceId);
    }
    if (filters?.status) {
      results = results.filter((d) => d.status === filters.status);
    }
    if (filters?.agentId) {
      results = results.filter(
        (d) => d.complainantId === filters.agentId || d.providerId === filters.agentId,
      );
    }

    return results
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((d) => structuredClone(d));
  }

  resolveDispute(disputeId: string, input: ResolveDisputeInput): ServiceDispute {
    const dispute = this.disputes.get(disputeId);
    if (!dispute) {
      throw new DomainError(ErrorCode.InvalidPayload, 404, `Dispute '${disputeId}' not found.`);
    }

    if (dispute.status !== 'open') {
      throw new DomainError(ErrorCode.InvalidPayload, 400, `Dispute is already '${dispute.status}'.`);
    }

    if (input.refundPct !== undefined && (input.refundPct < 0 || input.refundPct > 100)) {
      throw new DomainError(ErrorCode.InvalidPayload, 400, 'refundPct must be between 0 and 100.');
    }

    dispute.status = 'resolved';
    dispute.resolution = input.resolution;
    dispute.refundPct = input.refundPct;
    dispute.resolvedAt = isoNow();

    // Impact provider reputation on dispute resolution
    if (input.refundPct && input.refundPct > 0) {
      const service = this.services.get(dispute.serviceId);
      if (service) {
        // Penalty proportional to refund — max 10% reputation hit
        const penalty = Math.round((input.refundPct / 100) * 100);
        service.reputationScore = Math.max(0, service.reputationScore - penalty);
        service.updatedAt = isoNow();
      }
    }

    return structuredClone(dispute);
  }

  // ── Revenue Sharing ───────────────────────────────────────────────

  recordRevenue(serviceId: string, amountUsd: number): RevenueShare | null {
    const service = this.services.get(serviceId);
    if (!service) return null;

    service.totalRevenue += amountUsd;
    service.subscriberCount += 1;
    service.updatedAt = isoNow();

    // Distribute to revenue share if exists
    for (const share of this.revenueShares.values()) {
      if (share.serviceId === serviceId) {
        share.totalEarnedUsd += amountUsd;
        return structuredClone(share);
      }
    }

    return null;
  }

  getRevenueShare(serviceId: string): RevenueShare | null {
    for (const share of this.revenueShares.values()) {
      if (share.serviceId === serviceId) {
        return structuredClone(share);
      }
    }
    return null;
  }

  // ── Multi-Criteria Leaderboard ────────────────────────────────────

  leaderboard(
    sortBy: 'overall' | 'profit' | 'reliability' | 'signalQuality' | 'reputation' = 'overall',
    limit = 50,
  ): LeaderboardEntry[] {
    const state = this.store.snapshot();
    const agentIds = new Set<string>();

    // Collect agents that have services
    for (const service of this.services.values()) {
      agentIds.add(service.agentId);
    }

    // Also include all registered agents
    for (const agentId of Object.keys(state.agents)) {
      agentIds.add(agentId);
    }

    const entries: LeaderboardEntry[] = [];

    for (const agentId of agentIds) {
      const agentServices = Array.from(this.services.values())
        .filter((s) => s.agentId === agentId);

      // Calculate profit
      const executions = Object.values(state.executions)
        .filter((ex) => ex.agentId === agentId && ex.status === 'filled');
      const totalProfit = executions.reduce((sum, ex) => sum + ex.realizedPnlUsd, 0);

      // Calculate reliability (fill rate)
      const allIntents = Object.values(state.tradeIntents)
        .filter((intent) => intent.agentId === agentId);
      const filledIntents = allIntents.filter((intent) => intent.status === 'executed');
      const reliability = allIntents.length > 0
        ? Math.round((filledIntents.length / allIntents.length) * 100)
        : 50;

      // Signal quality: avg reputation score of services
      const avgReputation = agentServices.length > 0
        ? agentServices.reduce((sum, s) => sum + s.reputationScore, 0) / agentServices.length
        : 500;
      const signalQuality = Math.round((avgReputation / MAX_REPUTATION) * 100);

      // Dispute rate
      const agentDisputes = Array.from(this.disputes.values())
        .filter((d) => d.providerId === agentId);
      const resolvedWithRefund = agentDisputes.filter(
        (d) => d.status === 'resolved' && d.refundPct && d.refundPct > 0,
      );
      const disputeRate = agentServices.length > 0
        ? resolvedWithRefund.length / Math.max(agentServices.length, 1)
        : 0;

      // Overall composite score (weighted)
      const profitScore = Math.min(100, Math.max(0, 50 + totalProfit / 100));
      const overallScore = Math.round(
        profitScore * 0.25
        + reliability * 0.25
        + signalQuality * 0.25
        + ((1 - disputeRate) * 100) * 0.15
        + (avgReputation / MAX_REPUTATION * 100) * 0.10,
      );

      entries.push({
        rank: 0, // Set after sort
        agentId,
        totalProfit: Math.round(totalProfit * 100) / 100,
        reliability,
        signalQuality,
        reputationScore: Math.round(avgReputation),
        serviceCount: agentServices.length,
        disputeRate: Math.round(disputeRate * 1000) / 1000,
        overallScore,
      });
    }

    // Sort by chosen criterion
    switch (sortBy) {
      case 'profit':
        entries.sort((a, b) => b.totalProfit - a.totalProfit);
        break;
      case 'reliability':
        entries.sort((a, b) => b.reliability - a.reliability);
        break;
      case 'signalQuality':
        entries.sort((a, b) => b.signalQuality - a.signalQuality);
        break;
      case 'reputation':
        entries.sort((a, b) => b.reputationScore - a.reputationScore);
        break;
      default:
        entries.sort((a, b) => b.overallScore - a.overallScore);
    }

    // Assign ranks
    const sliced = entries.slice(0, limit);
    for (let i = 0; i < sliced.length; i++) {
      sliced[i].rank = i + 1;
    }

    return sliced;
  }
}
