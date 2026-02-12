/**
 * Agent Insurance & Protection Service
 *
 * Provides a mutual insurance framework for AI trading agents:
 *
 *   - Insurance pool management (agents contribute to a shared insurance fund)
 *   - Coverage policies (smart contract risk, slippage, black swan events)
 *   - Claims processing (submit, validate, payout)
 *   - Premium calculation (based on agent risk profile, trade volume, history)
 *   - Insurance fund analytics (total pool, coverage ratio, claims history)
 *   - Mutual insurance (agents insure each other via peer-to-peer backing)
 */

import { StateStore } from '../infra/storage/stateStore.js';
import { isoNow } from '../utils/time.js';

// ─── Types ──────────────────────────────────────────────────────────────

export type CoverageType = 'smart-contract-risk' | 'slippage' | 'black-swan' | 'liquidation' | 'oracle-failure';
export type PolicyStatus = 'active' | 'expired' | 'cancelled' | 'claimed';
export type ClaimStatus = 'pending' | 'approved' | 'denied' | 'paid';

export interface InsuranceContribution {
  id: string;
  agentId: string;
  amountUsd: number;
  contributedAt: string;
}

export interface InsurancePolicy {
  id: string;
  agentId: string;
  coverageType: CoverageType;
  coverageAmountUsd: number;
  premiumUsd: number;
  deductibleUsd: number;
  status: PolicyStatus;
  createdAt: string;
  expiresAt: string;
  /** Optional peer backer for mutual insurance */
  backerId: string | null;
}

export interface InsuranceClaim {
  id: string;
  policyId: string;
  agentId: string;
  coverageType: CoverageType;
  claimedAmountUsd: number;
  approvedAmountUsd: number;
  status: ClaimStatus;
  reason: string;
  evidence: string;
  submittedAt: string;
  resolvedAt: string | null;
}

export interface InsurancePool {
  totalFundUsd: number;
  totalContributions: number;
  totalPolicies: number;
  activePolicies: number;
  totalClaims: number;
  approvedClaims: number;
  totalPayoutsUsd: number;
  coverageRatio: number;
  contributors: Array<{ agentId: string; totalContributedUsd: number }>;
  updatedAt: string;
}

export interface PremiumQuote {
  agentId: string;
  coverageType: CoverageType;
  coverageAmountUsd: number;
  premiumUsd: number;
  deductibleUsd: number;
  riskScore: number;
  riskFactors: PremiumRiskFactor[];
  validUntil: string;
}

export interface PremiumRiskFactor {
  name: string;
  weight: number;
  rawValue: number;
  adjustedRate: number;
  description: string;
}

export interface MutualInsuranceOffer {
  id: string;
  backerId: string;
  coverageType: CoverageType;
  maxCoverageUsd: number;
  premiumRatePct: number;
  createdAt: string;
  active: boolean;
}

// ─── Premium base rates per coverage type (annual % of coverage) ────────

const BASE_RATES: Record<CoverageType, number> = {
  'smart-contract-risk': 0.05,    // 5%
  'slippage': 0.02,               // 2%
  'black-swan': 0.08,             // 8%
  'liquidation': 0.06,            // 6%
  'oracle-failure': 0.04,         // 4%
};

const DEDUCTIBLE_RATES: Record<CoverageType, number> = {
  'smart-contract-risk': 0.10,    // 10% deductible
  'slippage': 0.05,               // 5%
  'black-swan': 0.15,             // 15%
  'liquidation': 0.10,            // 10%
  'oracle-failure': 0.08,         // 8%
};

/** Policy duration: 30 days in ms */
const POLICY_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

/** Minimum coverage ratio the pool should maintain */
const MIN_COVERAGE_RATIO = 0.2;

let idCounter = 0;
function generateId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now()}-${idCounter}`;
}

// ─── Service ────────────────────────────────────────────────────────────

export class InsuranceService {
  private contributions: InsuranceContribution[] = [];
  private policies: Map<string, InsurancePolicy> = new Map();
  private claims: Map<string, InsuranceClaim> = new Map();
  private mutualOffers: Map<string, MutualInsuranceOffer> = new Map();
  private poolBalance = 0;

  constructor(private readonly store: StateStore) {}

  // ─── Pool Management ────────────────────────────────────────────────

  /**
   * Contribute funds to the shared insurance pool.
   */
  contribute(agentId: string, amountUsd: number): InsuranceContribution {
    if (amountUsd <= 0) {
      throw new Error('Contribution amount must be positive.');
    }

    const state = this.store.snapshot();
    if (!state.agents[agentId]) {
      throw new Error(`Agent ${agentId} not found.`);
    }

    const contribution: InsuranceContribution = {
      id: generateId('contrib'),
      agentId,
      amountUsd,
      contributedAt: isoNow(),
    };

    this.contributions.push(contribution);
    this.poolBalance += amountUsd;

    return contribution;
  }

  /**
   * Get current insurance pool status & analytics.
   */
  getPoolStatus(): InsurancePool {
    const allPolicies = Array.from(this.policies.values());
    const activePolicies = allPolicies.filter((p) => p.status === 'active');
    const allClaims = Array.from(this.claims.values());
    const approvedClaims = allClaims.filter((c) => c.status === 'approved' || c.status === 'paid');
    const totalPayouts = allClaims
      .filter((c) => c.status === 'paid')
      .reduce((sum, c) => sum + c.approvedAmountUsd, 0);

    // Total coverage exposure
    const totalCoverageExposure = activePolicies.reduce((sum, p) => sum + p.coverageAmountUsd, 0);
    const coverageRatio = totalCoverageExposure > 0
      ? this.poolBalance / totalCoverageExposure
      : this.poolBalance > 0 ? 1 : 0;

    // Group contributions by agent
    const contributorMap = new Map<string, number>();
    for (const c of this.contributions) {
      contributorMap.set(c.agentId, (contributorMap.get(c.agentId) ?? 0) + c.amountUsd);
    }

    return {
      totalFundUsd: this.poolBalance,
      totalContributions: this.contributions.length,
      totalPolicies: allPolicies.length,
      activePolicies: activePolicies.length,
      totalClaims: allClaims.length,
      approvedClaims: approvedClaims.length,
      totalPayoutsUsd: totalPayouts,
      coverageRatio: Number(coverageRatio.toFixed(4)),
      contributors: Array.from(contributorMap.entries())
        .map(([agentId, totalContributedUsd]) => ({ agentId, totalContributedUsd }))
        .sort((a, b) => b.totalContributedUsd - a.totalContributedUsd),
      updatedAt: isoNow(),
    };
  }

  // ─── Policy Management ──────────────────────────────────────────────

  /**
   * Create a new insurance policy for an agent.
   */
  createPolicy(
    agentId: string,
    coverageType: CoverageType,
    coverageAmountUsd: number,
  ): InsurancePolicy {
    if (coverageAmountUsd <= 0) {
      throw new Error('Coverage amount must be positive.');
    }

    const state = this.store.snapshot();
    if (!state.agents[agentId]) {
      throw new Error(`Agent ${agentId} not found.`);
    }

    // Check pool capacity
    const pool = this.getPoolStatus();
    const projectedExposure = this.getActiveCoverageExposure() + coverageAmountUsd;
    if (this.poolBalance > 0 && this.poolBalance / projectedExposure < MIN_COVERAGE_RATIO) {
      throw new Error('Insufficient pool funds to cover this policy. Coverage ratio would drop below minimum.');
    }

    // Calculate premium
    const quote = this.calculatePremium(agentId, coverageType, coverageAmountUsd);

    const now = new Date();
    const expiresAt = new Date(now.getTime() + POLICY_DURATION_MS);

    const policy: InsurancePolicy = {
      id: generateId('policy'),
      agentId,
      coverageType,
      coverageAmountUsd,
      premiumUsd: quote.premiumUsd,
      deductibleUsd: quote.deductibleUsd,
      status: 'active',
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      backerId: null,
    };

    this.policies.set(policy.id, policy);
    // Premium goes into the pool
    this.poolBalance += quote.premiumUsd;

    return policy;
  }

  /**
   * Get all policies for a specific agent.
   */
  getAgentPolicies(agentId: string): InsurancePolicy[] {
    return Array.from(this.policies.values())
      .filter((p) => p.agentId === agentId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * Get a single policy by ID.
   */
  getPolicy(policyId: string): InsurancePolicy | null {
    return this.policies.get(policyId) ?? null;
  }

  // ─── Claims Processing ──────────────────────────────────────────────

  /**
   * Submit an insurance claim against an active policy.
   */
  submitClaim(
    policyId: string,
    agentId: string,
    claimedAmountUsd: number,
    reason: string,
    evidence: string,
  ): InsuranceClaim {
    const policy = this.policies.get(policyId);
    if (!policy) {
      throw new Error(`Policy ${policyId} not found.`);
    }
    if (policy.agentId !== agentId) {
      throw new Error('Agent does not own this policy.');
    }
    if (policy.status !== 'active') {
      throw new Error(`Policy is not active (status: ${policy.status}).`);
    }
    if (claimedAmountUsd <= 0) {
      throw new Error('Claimed amount must be positive.');
    }
    if (claimedAmountUsd > policy.coverageAmountUsd) {
      throw new Error('Claimed amount exceeds coverage.');
    }

    // Auto-validate: simple rule-based validation
    const validation = this.validateClaim(policy, claimedAmountUsd, reason);

    const claim: InsuranceClaim = {
      id: generateId('claim'),
      policyId,
      agentId,
      coverageType: policy.coverageType,
      claimedAmountUsd,
      approvedAmountUsd: validation.approved ? validation.approvedAmount : 0,
      status: validation.approved ? 'approved' : 'denied',
      reason,
      evidence,
      submittedAt: isoNow(),
      resolvedAt: isoNow(),
    };

    this.claims.set(claim.id, claim);

    // If approved, process payout
    if (claim.status === 'approved' && claim.approvedAmountUsd > 0) {
      this.processPayout(claim);
    }

    return claim;
  }

  /**
   * Get all claims for a specific agent.
   */
  getAgentClaims(agentId: string): InsuranceClaim[] {
    return Array.from(this.claims.values())
      .filter((c) => c.agentId === agentId)
      .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
  }

  /**
   * Get a single claim by ID.
   */
  getClaim(claimId: string): InsuranceClaim | null {
    return this.claims.get(claimId) ?? null;
  }

  // ─── Premium Calculator ─────────────────────────────────────────────

  /**
   * Calculate insurance premium based on agent risk profile.
   */
  calculatePremium(
    agentId: string,
    coverageType: CoverageType,
    coverageAmountUsd: number,
  ): PremiumQuote {
    const state = this.store.snapshot();
    const agent = state.agents[agentId];

    // Base rate for coverage type
    const baseRate = BASE_RATES[coverageType];
    const deductibleRate = DEDUCTIBLE_RATES[coverageType];

    const riskFactors: PremiumRiskFactor[] = [];
    let totalMultiplier = 1.0;

    if (agent) {
      // Factor 1: Trade volume (more volume = slight discount)
      const executions = Object.values(state.executions)
        .filter((ex) => ex.agentId === agentId && ex.status === 'filled');
      const totalVolume = executions.reduce((sum, ex) => sum + ex.grossNotionalUsd, 0);
      const volumeDiscount = Math.min(totalVolume / 1_000_000, 0.3); // Up to 30% discount
      const volumeMultiplier = 1 - volumeDiscount;
      riskFactors.push({
        name: 'tradeVolume',
        weight: 0.25,
        rawValue: totalVolume,
        adjustedRate: volumeMultiplier,
        description: `Trade volume: $${totalVolume.toFixed(2)} → ${(volumeDiscount * 100).toFixed(1)}% discount`,
      });

      // Factor 2: Win rate (higher win rate = lower risk)
      const closingTrades = executions.filter((ex) => ex.side === 'sell');
      const wins = closingTrades.filter((ex) => ex.realizedPnlUsd > 0).length;
      const winRate = closingTrades.length > 0 ? wins / closingTrades.length : 0.5;
      const winRateMultiplier = 1.5 - winRate; // 50% win rate → 1.0x, 100% → 0.5x, 0% → 1.5x
      riskFactors.push({
        name: 'winRate',
        weight: 0.25,
        rawValue: winRate,
        adjustedRate: winRateMultiplier,
        description: `Win rate: ${(winRate * 100).toFixed(1)}% → ${winRateMultiplier.toFixed(2)}x multiplier`,
      });

      // Factor 3: Max drawdown (higher drawdown = higher risk)
      let maxDrawdownPct = 0;
      let cumulativePnl = 0;
      let peakEquity = agent.startingCapitalUsd;
      for (const ex of executions) {
        cumulativePnl += ex.realizedPnlUsd;
        const equity = agent.startingCapitalUsd + cumulativePnl;
        if (equity > peakEquity) peakEquity = equity;
        const dd = peakEquity > 0 ? (peakEquity - equity) / peakEquity : 0;
        if (dd > maxDrawdownPct) maxDrawdownPct = dd;
      }
      const drawdownMultiplier = 1 + maxDrawdownPct; // 0% dd → 1.0x, 50% dd → 1.5x
      riskFactors.push({
        name: 'maxDrawdown',
        weight: 0.25,
        rawValue: maxDrawdownPct,
        adjustedRate: drawdownMultiplier,
        description: `Max drawdown: ${(maxDrawdownPct * 100).toFixed(1)}% → ${drawdownMultiplier.toFixed(2)}x multiplier`,
      });

      // Factor 4: Risk rejection rate (more rejections = riskier agent)
      const totalRejections = Object.values(agent.riskRejectionsByReason)
        .reduce((sum, count) => sum + count, 0);
      const totalIntents = Object.values(state.tradeIntents)
        .filter((i) => i.agentId === agentId).length;
      const rejectionRate = totalIntents > 0 ? totalRejections / totalIntents : 0;
      const rejectionMultiplier = 1 + rejectionRate * 0.5; // 0% → 1.0x, 100% → 1.5x
      riskFactors.push({
        name: 'riskRejectionRate',
        weight: 0.25,
        rawValue: rejectionRate,
        adjustedRate: rejectionMultiplier,
        description: `Risk rejection rate: ${(rejectionRate * 100).toFixed(1)}% → ${rejectionMultiplier.toFixed(2)}x multiplier`,
      });

      // Combine multipliers (weighted geometric mean)
      totalMultiplier = riskFactors.reduce((acc, f) => acc * Math.pow(f.adjustedRate, f.weight), 1);
    } else {
      // Unknown agent: apply default high-risk multiplier
      totalMultiplier = 1.5;
      riskFactors.push({
        name: 'unknownAgent',
        weight: 1.0,
        rawValue: 0,
        adjustedRate: 1.5,
        description: 'Unknown agent — default high-risk multiplier applied.',
      });
    }

    const premiumUsd = Number((coverageAmountUsd * baseRate * totalMultiplier).toFixed(2));
    const deductibleUsd = Number((coverageAmountUsd * deductibleRate).toFixed(2));

    // Risk score 0-100 (lower is better)
    const riskScore = Number(Math.min(100, Math.max(0, (totalMultiplier - 0.5) * 100)).toFixed(2));

    const validUntil = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    return {
      agentId,
      coverageType,
      coverageAmountUsd,
      premiumUsd,
      deductibleUsd,
      riskScore,
      riskFactors,
      validUntil,
    };
  }

  // ─── Mutual Insurance ──────────────────────────────────────────────

  /**
   * Create a mutual insurance offer (agent backs another agent).
   */
  createMutualOffer(
    backerId: string,
    coverageType: CoverageType,
    maxCoverageUsd: number,
    premiumRatePct: number,
  ): MutualInsuranceOffer {
    if (maxCoverageUsd <= 0) {
      throw new Error('Max coverage must be positive.');
    }
    if (premiumRatePct <= 0 || premiumRatePct > 50) {
      throw new Error('Premium rate must be between 0 and 50%.');
    }

    const state = this.store.snapshot();
    if (!state.agents[backerId]) {
      throw new Error(`Backer agent ${backerId} not found.`);
    }

    const offer: MutualInsuranceOffer = {
      id: generateId('mutual'),
      backerId,
      coverageType,
      maxCoverageUsd,
      premiumRatePct,
      createdAt: isoNow(),
      active: true,
    };

    this.mutualOffers.set(offer.id, offer);
    return offer;
  }

  /**
   * Accept a mutual insurance offer and create a policy backed by peer.
   */
  acceptMutualOffer(offerId: string, agentId: string, coverageAmountUsd: number): InsurancePolicy {
    const offer = this.mutualOffers.get(offerId);
    if (!offer) {
      throw new Error(`Mutual offer ${offerId} not found.`);
    }
    if (!offer.active) {
      throw new Error('Offer is no longer active.');
    }
    if (coverageAmountUsd > offer.maxCoverageUsd) {
      throw new Error('Coverage amount exceeds offer maximum.');
    }
    if (agentId === offer.backerId) {
      throw new Error('Agent cannot insure itself.');
    }

    const state = this.store.snapshot();
    if (!state.agents[agentId]) {
      throw new Error(`Agent ${agentId} not found.`);
    }

    const premiumUsd = Number((coverageAmountUsd * offer.premiumRatePct / 100).toFixed(2));
    const deductibleUsd = Number((coverageAmountUsd * DEDUCTIBLE_RATES[offer.coverageType]).toFixed(2));

    const now = new Date();
    const policy: InsurancePolicy = {
      id: generateId('policy'),
      agentId,
      coverageType: offer.coverageType,
      coverageAmountUsd,
      premiumUsd,
      deductibleUsd,
      status: 'active',
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + POLICY_DURATION_MS).toISOString(),
      backerId: offer.backerId,
    };

    this.policies.set(policy.id, policy);
    return policy;
  }

  /**
   * List all active mutual insurance offers.
   */
  getMutualOffers(coverageType?: CoverageType): MutualInsuranceOffer[] {
    let offers = Array.from(this.mutualOffers.values()).filter((o) => o.active);
    if (coverageType) {
      offers = offers.filter((o) => o.coverageType === coverageType);
    }
    return offers.sort((a, b) => a.premiumRatePct - b.premiumRatePct);
  }

  // ─── Internal Helpers ───────────────────────────────────────────────

  private getActiveCoverageExposure(): number {
    return Array.from(this.policies.values())
      .filter((p) => p.status === 'active')
      .reduce((sum, p) => sum + p.coverageAmountUsd, 0);
  }

  private validateClaim(
    policy: InsurancePolicy,
    claimedAmountUsd: number,
    reason: string,
  ): { approved: boolean; approvedAmount: number } {
    // Rule 1: Reason must be non-empty
    if (!reason || reason.trim().length < 10) {
      return { approved: false, approvedAmount: 0 };
    }

    // Rule 2: Claimed amount must be within coverage limits
    if (claimedAmountUsd > policy.coverageAmountUsd) {
      return { approved: false, approvedAmount: 0 };
    }

    // Rule 3: Apply deductible
    const afterDeductible = Math.max(0, claimedAmountUsd - policy.deductibleUsd);

    // Rule 4: Check pool has sufficient funds
    if (afterDeductible > this.poolBalance) {
      // Partial payout: whatever the pool can cover
      return { approved: true, approvedAmount: Math.min(afterDeductible, this.poolBalance) };
    }

    return { approved: true, approvedAmount: Number(afterDeductible.toFixed(2)) };
  }

  private processPayout(claim: InsuranceClaim): void {
    if (claim.approvedAmountUsd > 0) {
      this.poolBalance = Math.max(0, this.poolBalance - claim.approvedAmountUsd);
      claim.status = 'paid';

      // Mark policy as claimed
      const policy = this.policies.get(claim.policyId);
      if (policy) {
        policy.status = 'claimed';
      }
    }
  }
}
