import { describe, expect, it, beforeEach } from 'vitest';
import {
  InsuranceService,
  CoverageType,
  InsurancePool,
  InsurancePolicy,
  InsuranceClaim,
  PremiumQuote,
  MutualInsuranceOffer,
} from '../src/services/insuranceService.js';
import { StateStore } from '../src/infra/storage/stateStore.js';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

function tmpState(): string {
  return path.join(os.tmpdir(), `insurance-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

async function createService(): Promise<{ svc: InsuranceService; store: StateStore }> {
  const file = tmpState();
  const store = new StateStore(file);
  await store.init();

  // Register a test agent
  const state = store.snapshot();
  const agentId = 'agent-ins-1';
  store.updateState({
    ...state,
    agents: {
      ...state.agents,
      [agentId]: {
        id: agentId,
        name: 'Insurance Test Agent',
        apiKey: 'test-key-1',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        startingCapitalUsd: 100_000,
        cashUsd: 100_000,
        realizedPnlUsd: 0,
        peakEquityUsd: 100_000,
        riskLimits: {
          maxPositionSizePct: 0.1,
          maxOrderNotionalUsd: 50_000,
          maxGrossExposureUsd: 200_000,
          dailyLossCapUsd: 5_000,
          maxDrawdownPct: 0.2,
          cooldownSeconds: 0,
        },
        positions: {},
        dailyRealizedPnlUsd: {},
        riskRejectionsByReason: {},
        strategyId: 'momentum-v1',
      },
      'agent-ins-2': {
        id: 'agent-ins-2',
        name: 'Insurance Test Agent 2',
        apiKey: 'test-key-2',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        startingCapitalUsd: 50_000,
        cashUsd: 50_000,
        realizedPnlUsd: 0,
        peakEquityUsd: 50_000,
        riskLimits: {
          maxPositionSizePct: 0.1,
          maxOrderNotionalUsd: 25_000,
          maxGrossExposureUsd: 100_000,
          dailyLossCapUsd: 2_500,
          maxDrawdownPct: 0.2,
          cooldownSeconds: 0,
        },
        positions: {},
        dailyRealizedPnlUsd: {},
        riskRejectionsByReason: {},
        strategyId: 'mean-reversion-v1',
      },
    },
  });

  const svc = new InsuranceService(store);
  return { svc, store };
}

describe('InsuranceService', () => {
  // ── 1. Pool contribution ──────────────────────────────────────────
  it('accepts a contribution and increases the pool balance', async () => {
    const { svc } = await createService();

    const contrib = svc.contribute('agent-ins-1', 5000);

    expect(contrib.agentId).toBe('agent-ins-1');
    expect(contrib.amountUsd).toBe(5000);
    expect(contrib.id).toMatch(/^contrib-/);
    expect(contrib.contributedAt).toBeTruthy();

    const pool = svc.getPoolStatus();
    expect(pool.totalFundUsd).toBe(5000);
    expect(pool.totalContributions).toBe(1);
  });

  // ── 2. Pool rejects invalid contribution ──────────────────────────
  it('rejects contribution with non-positive amount', async () => {
    const { svc } = await createService();

    expect(() => svc.contribute('agent-ins-1', 0)).toThrow('Contribution amount must be positive');
    expect(() => svc.contribute('agent-ins-1', -100)).toThrow('Contribution amount must be positive');
  });

  // ── 3. Pool rejects unknown agent ─────────────────────────────────
  it('rejects contribution from unknown agent', async () => {
    const { svc } = await createService();

    expect(() => svc.contribute('nonexistent-agent', 1000)).toThrow('not found');
  });

  // ── 4. Pool status analytics ──────────────────────────────────────
  it('returns correct pool analytics with multiple contributors', async () => {
    const { svc } = await createService();

    svc.contribute('agent-ins-1', 3000);
    svc.contribute('agent-ins-2', 2000);
    svc.contribute('agent-ins-1', 1000);

    const pool = svc.getPoolStatus();
    expect(pool.totalFundUsd).toBe(6000);
    expect(pool.totalContributions).toBe(3);
    expect(pool.contributors).toHaveLength(2);

    // agent-ins-1 contributed 4000 total, should be first
    expect(pool.contributors[0].agentId).toBe('agent-ins-1');
    expect(pool.contributors[0].totalContributedUsd).toBe(4000);
    expect(pool.contributors[1].agentId).toBe('agent-ins-2');
    expect(pool.contributors[1].totalContributedUsd).toBe(2000);
  });

  // ── 5. Create policy ─────────────────────────────────────────────
  it('creates an insurance policy with premium and deductible', async () => {
    const { svc } = await createService();

    // Seed the pool first
    svc.contribute('agent-ins-1', 50_000);

    const policy = svc.createPolicy('agent-ins-1', 'smart-contract-risk', 10_000);

    expect(policy.id).toMatch(/^policy-/);
    expect(policy.agentId).toBe('agent-ins-1');
    expect(policy.coverageType).toBe('smart-contract-risk');
    expect(policy.coverageAmountUsd).toBe(10_000);
    expect(policy.premiumUsd).toBeGreaterThan(0);
    expect(policy.deductibleUsd).toBeGreaterThan(0);
    expect(policy.status).toBe('active');
    expect(policy.backerId).toBeNull();
    expect(policy.expiresAt).toBeTruthy();
  });

  // ── 6. Get agent policies ─────────────────────────────────────────
  it('returns policies for a specific agent', async () => {
    const { svc } = await createService();
    svc.contribute('agent-ins-1', 100_000);

    svc.createPolicy('agent-ins-1', 'slippage', 5_000);
    svc.createPolicy('agent-ins-1', 'black-swan', 20_000);
    svc.createPolicy('agent-ins-2', 'liquidation', 10_000);

    const agent1Policies = svc.getAgentPolicies('agent-ins-1');
    expect(agent1Policies).toHaveLength(2);
    expect(agent1Policies.every((p) => p.agentId === 'agent-ins-1')).toBe(true);

    const agent2Policies = svc.getAgentPolicies('agent-ins-2');
    expect(agent2Policies).toHaveLength(1);
    expect(agent2Policies[0].coverageType).toBe('liquidation');
  });

  // ── 7. Submit and approve a claim ─────────────────────────────────
  it('submits a claim that gets approved and paid', async () => {
    const { svc } = await createService();
    svc.contribute('agent-ins-1', 100_000);

    const policy = svc.createPolicy('agent-ins-1', 'slippage', 10_000);

    const claim = svc.submitClaim(
      policy.id,
      'agent-ins-1',
      2_000,
      'Excessive slippage on SOL/USDC trade due to low liquidity',
      'tx-hash-abc123',
    );

    expect(claim.id).toMatch(/^claim-/);
    expect(claim.policyId).toBe(policy.id);
    expect(claim.agentId).toBe('agent-ins-1');
    expect(claim.status).toBe('paid');
    expect(claim.approvedAmountUsd).toBeGreaterThan(0);
    // Approved amount = claimed - deductible
    expect(claim.approvedAmountUsd).toBeLessThanOrEqual(2_000);
  });

  // ── 8. Claim denied for insufficient reason ──────────────────────
  it('denies a claim with insufficient reason', async () => {
    const { svc } = await createService();
    svc.contribute('agent-ins-1', 100_000);

    const policy = svc.createPolicy('agent-ins-1', 'slippage', 10_000);

    const claim = svc.submitClaim(
      policy.id,
      'agent-ins-1',
      2_000,
      'short',       // Too short (<10 chars)
      'evidence',
    );

    expect(claim.status).toBe('denied');
    expect(claim.approvedAmountUsd).toBe(0);
  });

  // ── 9. Claim rejected for wrong agent ─────────────────────────────
  it('rejects a claim from a different agent', async () => {
    const { svc } = await createService();
    svc.contribute('agent-ins-1', 100_000);

    const policy = svc.createPolicy('agent-ins-1', 'slippage', 10_000);

    expect(() =>
      svc.submitClaim(policy.id, 'agent-ins-2', 1_000, 'Valid reason for the claim submission', 'evidence'),
    ).toThrow('Agent does not own this policy');
  });

  // ── 10. Get agent claims ──────────────────────────────────────────
  it('returns claims for a specific agent', async () => {
    const { svc } = await createService();
    svc.contribute('agent-ins-1', 100_000);

    const policy1 = svc.createPolicy('agent-ins-1', 'slippage', 10_000);
    const policy2 = svc.createPolicy('agent-ins-1', 'black-swan', 20_000);

    svc.submitClaim(policy1.id, 'agent-ins-1', 1_000, 'Slippage exceeded expected amount on trade', 'tx-1');
    svc.submitClaim(policy2.id, 'agent-ins-1', 5_000, 'Black swan crash caused massive losses in portfolio', 'tx-2');

    const claims = svc.getAgentClaims('agent-ins-1');
    expect(claims).toHaveLength(2);
    expect(claims.every((c) => c.agentId === 'agent-ins-1')).toBe(true);
  });

  // ── 11. Premium calculation ───────────────────────────────────────
  it('calculates premium with risk factors for known agent', async () => {
    const { svc } = await createService();

    const quote = svc.calculatePremium('agent-ins-1', 'smart-contract-risk', 50_000);

    expect(quote.agentId).toBe('agent-ins-1');
    expect(quote.coverageType).toBe('smart-contract-risk');
    expect(quote.coverageAmountUsd).toBe(50_000);
    expect(quote.premiumUsd).toBeGreaterThan(0);
    expect(quote.deductibleUsd).toBeGreaterThan(0);
    expect(quote.riskScore).toBeGreaterThanOrEqual(0);
    expect(quote.riskScore).toBeLessThanOrEqual(100);
    expect(quote.riskFactors.length).toBeGreaterThanOrEqual(1);
    expect(quote.validUntil).toBeTruthy();
  });

  // ── 12. Premium varies by coverage type ──────────────────────────
  it('returns different premiums for different coverage types', async () => {
    const { svc } = await createService();

    const slippageQuote = svc.calculatePremium('agent-ins-1', 'slippage', 10_000);
    const blackSwanQuote = svc.calculatePremium('agent-ins-1', 'black-swan', 10_000);

    // Black swan should have higher premium than slippage
    expect(blackSwanQuote.premiumUsd).toBeGreaterThan(slippageQuote.premiumUsd);
  });

  // ── 13. Mutual insurance offer creation ───────────────────────────
  it('creates a mutual insurance offer', async () => {
    const { svc } = await createService();

    const offer = svc.createMutualOffer('agent-ins-1', 'smart-contract-risk', 25_000, 3);

    expect(offer.id).toMatch(/^mutual-/);
    expect(offer.backerId).toBe('agent-ins-1');
    expect(offer.coverageType).toBe('smart-contract-risk');
    expect(offer.maxCoverageUsd).toBe(25_000);
    expect(offer.premiumRatePct).toBe(3);
    expect(offer.active).toBe(true);
  });

  // ── 14. Accept mutual insurance offer ────────────────────────────
  it('accepts a mutual insurance offer creating a peer-backed policy', async () => {
    const { svc } = await createService();

    const offer = svc.createMutualOffer('agent-ins-1', 'slippage', 20_000, 2.5);
    const policy = svc.acceptMutualOffer(offer.id, 'agent-ins-2', 10_000);

    expect(policy.agentId).toBe('agent-ins-2');
    expect(policy.backerId).toBe('agent-ins-1');
    expect(policy.coverageAmountUsd).toBe(10_000);
    expect(policy.status).toBe('active');
    expect(policy.premiumUsd).toBe(250); // 10000 * 2.5%
  });

  // ── 15. Cannot self-insure via mutual ─────────────────────────────
  it('prevents an agent from insuring itself via mutual offer', async () => {
    const { svc } = await createService();

    const offer = svc.createMutualOffer('agent-ins-1', 'slippage', 20_000, 2);

    expect(() => svc.acceptMutualOffer(offer.id, 'agent-ins-1', 5_000)).toThrow('cannot insure itself');
  });

  // ── 16. List mutual offers filtered by type ───────────────────────
  it('lists mutual offers filtered by coverage type', async () => {
    const { svc } = await createService();

    svc.createMutualOffer('agent-ins-1', 'slippage', 10_000, 2);
    svc.createMutualOffer('agent-ins-2', 'black-swan', 30_000, 5);
    svc.createMutualOffer('agent-ins-1', 'slippage', 20_000, 3);

    const slippageOffers = svc.getMutualOffers('slippage');
    expect(slippageOffers).toHaveLength(2);
    expect(slippageOffers.every((o) => o.coverageType === 'slippage')).toBe(true);
    // Should be sorted by premium rate ascending
    expect(slippageOffers[0].premiumRatePct).toBeLessThanOrEqual(slippageOffers[1].premiumRatePct);

    const allOffers = svc.getMutualOffers();
    expect(allOffers).toHaveLength(3);
  });

  // ── 17. Claim exceeding coverage is rejected ──────────────────────
  it('rejects a claim that exceeds coverage amount', async () => {
    const { svc } = await createService();
    svc.contribute('agent-ins-1', 100_000);

    const policy = svc.createPolicy('agent-ins-1', 'slippage', 5_000);

    expect(() =>
      svc.submitClaim(policy.id, 'agent-ins-1', 10_000, 'Claim exceeds coverage amount limit', 'evidence'),
    ).toThrow('exceeds coverage');
  });

  // ── 18. Coverage ratio affects pool status ────────────────────────
  it('tracks coverage ratio correctly', async () => {
    const { svc } = await createService();
    svc.contribute('agent-ins-1', 20_000);

    // Pool starts at 20k with no exposure → ratio should be 1
    let pool = svc.getPoolStatus();
    expect(pool.coverageRatio).toBe(1);

    // Create a policy — adds premium to pool, adds coverage exposure
    svc.createPolicy('agent-ins-1', 'slippage', 10_000);

    pool = svc.getPoolStatus();
    expect(pool.activePolicies).toBe(1);
    expect(pool.coverageRatio).toBeGreaterThan(0);
  });
});
