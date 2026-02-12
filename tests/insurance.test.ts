import { describe, expect, it, vi } from 'vitest';
import {
  InsuranceService,
  CoverageType,
  InsurancePool,
  InsurancePolicy,
  InsuranceClaim,
  PremiumQuote,
  MutualInsuranceOffer,
} from '../src/services/insuranceService.js';
import { AppState, Agent, ExecutionRecord, TradeIntent } from '../src/types.js';
import { createDefaultState } from '../src/infra/storage/defaultState.js';

function createMockStore(state: AppState) {
  return {
    snapshot: () => structuredClone(state),
    transaction: vi.fn(),
    init: vi.fn(),
    flush: vi.fn(),
  } as any;
}

function makeAgent(id: string, name: string, overrides?: Partial<Agent>): Agent {
  return {
    id,
    name,
    apiKey: `key-${id}`,
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
    ...overrides,
  };
}

function makeExecution(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    id: 'exec-1',
    intentId: 'intent-1',
    agentId: 'agent-1',
    symbol: 'SOL',
    side: 'sell',
    quantity: 1,
    priceUsd: 110,
    grossNotionalUsd: 110,
    feeUsd: 0.11,
    netUsd: 109.89,
    realizedPnlUsd: 10,
    pnlSnapshotUsd: 10,
    mode: 'paper',
    status: 'filled',
    failureReason: undefined,
    txSignature: undefined,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as ExecutionRecord;
}

function stateWithAgents(): AppState {
  const state = createDefaultState();
  state.agents['agent-1'] = makeAgent('agent-1', 'Agent One');
  state.agents['agent-2'] = makeAgent('agent-2', 'Agent Two', { startingCapitalUsd: 50_000 });
  return state;
}

describe('InsuranceService', () => {
  // ── 1. Pool contribution ──────────────────────────────────────────
  it('accepts a contribution and increases the pool balance', () => {
    const store = createMockStore(stateWithAgents());
    const svc = new InsuranceService(store);

    const contrib = svc.contribute('agent-1', 5000);

    expect(contrib.agentId).toBe('agent-1');
    expect(contrib.amountUsd).toBe(5000);
    expect(contrib.id).toMatch(/^contrib-/);
    expect(contrib.contributedAt).toBeTruthy();

    const pool = svc.getPoolStatus();
    expect(pool.totalFundUsd).toBe(5000);
    expect(pool.totalContributions).toBe(1);
  });

  // ── 2. Pool rejects invalid contribution ──────────────────────────
  it('rejects contribution with non-positive amount', () => {
    const store = createMockStore(stateWithAgents());
    const svc = new InsuranceService(store);

    expect(() => svc.contribute('agent-1', 0)).toThrow('Contribution amount must be positive');
    expect(() => svc.contribute('agent-1', -100)).toThrow('Contribution amount must be positive');
  });

  // ── 3. Pool rejects unknown agent ─────────────────────────────────
  it('rejects contribution from unknown agent', () => {
    const store = createMockStore(stateWithAgents());
    const svc = new InsuranceService(store);

    expect(() => svc.contribute('nonexistent-agent', 1000)).toThrow('not found');
  });

  // ── 4. Pool status analytics ──────────────────────────────────────
  it('returns correct pool analytics with multiple contributors', () => {
    const store = createMockStore(stateWithAgents());
    const svc = new InsuranceService(store);

    svc.contribute('agent-1', 3000);
    svc.contribute('agent-2', 2000);
    svc.contribute('agent-1', 1000);

    const pool = svc.getPoolStatus();
    expect(pool.totalFundUsd).toBe(6000);
    expect(pool.totalContributions).toBe(3);
    expect(pool.contributors).toHaveLength(2);

    // agent-1 contributed 4000 total, should be first
    expect(pool.contributors[0].agentId).toBe('agent-1');
    expect(pool.contributors[0].totalContributedUsd).toBe(4000);
    expect(pool.contributors[1].agentId).toBe('agent-2');
    expect(pool.contributors[1].totalContributedUsd).toBe(2000);
  });

  // ── 5. Create policy ─────────────────────────────────────────────
  it('creates an insurance policy with premium and deductible', () => {
    const store = createMockStore(stateWithAgents());
    const svc = new InsuranceService(store);

    // Seed the pool first
    svc.contribute('agent-1', 50_000);

    const policy = svc.createPolicy('agent-1', 'smart-contract-risk', 10_000);

    expect(policy.id).toMatch(/^policy-/);
    expect(policy.agentId).toBe('agent-1');
    expect(policy.coverageType).toBe('smart-contract-risk');
    expect(policy.coverageAmountUsd).toBe(10_000);
    expect(policy.premiumUsd).toBeGreaterThan(0);
    expect(policy.deductibleUsd).toBeGreaterThan(0);
    expect(policy.status).toBe('active');
    expect(policy.backerId).toBeNull();
    expect(policy.expiresAt).toBeTruthy();
  });

  // ── 6. Get agent policies ─────────────────────────────────────────
  it('returns policies for a specific agent', () => {
    const store = createMockStore(stateWithAgents());
    const svc = new InsuranceService(store);
    svc.contribute('agent-1', 100_000);

    svc.createPolicy('agent-1', 'slippage', 5_000);
    svc.createPolicy('agent-1', 'black-swan', 20_000);
    svc.createPolicy('agent-2', 'liquidation', 10_000);

    const agent1Policies = svc.getAgentPolicies('agent-1');
    expect(agent1Policies).toHaveLength(2);
    expect(agent1Policies.every((p) => p.agentId === 'agent-1')).toBe(true);

    const agent2Policies = svc.getAgentPolicies('agent-2');
    expect(agent2Policies).toHaveLength(1);
    expect(agent2Policies[0].coverageType).toBe('liquidation');
  });

  // ── 7. Submit and approve a claim ─────────────────────────────────
  it('submits a claim that gets approved and paid', () => {
    const store = createMockStore(stateWithAgents());
    const svc = new InsuranceService(store);
    svc.contribute('agent-1', 100_000);

    const policy = svc.createPolicy('agent-1', 'slippage', 10_000);

    const claim = svc.submitClaim(
      policy.id,
      'agent-1',
      2_000,
      'Excessive slippage on SOL/USDC trade due to low liquidity',
      'tx-hash-abc123',
    );

    expect(claim.id).toMatch(/^claim-/);
    expect(claim.policyId).toBe(policy.id);
    expect(claim.agentId).toBe('agent-1');
    expect(claim.status).toBe('paid');
    expect(claim.approvedAmountUsd).toBeGreaterThan(0);
    // Approved amount = claimed - deductible
    expect(claim.approvedAmountUsd).toBeLessThanOrEqual(2_000);
  });

  // ── 8. Claim denied for insufficient reason ──────────────────────
  it('denies a claim with insufficient reason', () => {
    const store = createMockStore(stateWithAgents());
    const svc = new InsuranceService(store);
    svc.contribute('agent-1', 100_000);

    const policy = svc.createPolicy('agent-1', 'slippage', 10_000);

    const claim = svc.submitClaim(
      policy.id,
      'agent-1',
      2_000,
      'short',       // Too short (<10 chars)
      'evidence',
    );

    expect(claim.status).toBe('denied');
    expect(claim.approvedAmountUsd).toBe(0);
  });

  // ── 9. Claim rejected for wrong agent ─────────────────────────────
  it('rejects a claim from a different agent', () => {
    const store = createMockStore(stateWithAgents());
    const svc = new InsuranceService(store);
    svc.contribute('agent-1', 100_000);

    const policy = svc.createPolicy('agent-1', 'slippage', 10_000);

    expect(() =>
      svc.submitClaim(policy.id, 'agent-2', 1_000, 'Valid reason for the claim submission', 'evidence'),
    ).toThrow('Agent does not own this policy');
  });

  // ── 10. Get agent claims ──────────────────────────────────────────
  it('returns claims for a specific agent', () => {
    const store = createMockStore(stateWithAgents());
    const svc = new InsuranceService(store);
    svc.contribute('agent-1', 100_000);

    const policy1 = svc.createPolicy('agent-1', 'slippage', 10_000);
    const policy2 = svc.createPolicy('agent-1', 'black-swan', 20_000);

    svc.submitClaim(policy1.id, 'agent-1', 1_000, 'Slippage exceeded expected amount on trade', 'tx-1');
    svc.submitClaim(policy2.id, 'agent-1', 5_000, 'Black swan crash caused massive losses in portfolio', 'tx-2');

    const claims = svc.getAgentClaims('agent-1');
    expect(claims).toHaveLength(2);
    expect(claims.every((c) => c.agentId === 'agent-1')).toBe(true);
  });

  // ── 11. Premium calculation ───────────────────────────────────────
  it('calculates premium with risk factors for known agent', () => {
    const store = createMockStore(stateWithAgents());
    const svc = new InsuranceService(store);

    const quote = svc.calculatePremium('agent-1', 'smart-contract-risk', 50_000);

    expect(quote.agentId).toBe('agent-1');
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
  it('returns different premiums for different coverage types', () => {
    const store = createMockStore(stateWithAgents());
    const svc = new InsuranceService(store);

    const slippageQuote = svc.calculatePremium('agent-1', 'slippage', 10_000);
    const blackSwanQuote = svc.calculatePremium('agent-1', 'black-swan', 10_000);

    // Black swan should have higher premium than slippage
    expect(blackSwanQuote.premiumUsd).toBeGreaterThan(slippageQuote.premiumUsd);
  });

  // ── 13. Mutual insurance offer creation ───────────────────────────
  it('creates a mutual insurance offer', () => {
    const store = createMockStore(stateWithAgents());
    const svc = new InsuranceService(store);

    const offer = svc.createMutualOffer('agent-1', 'smart-contract-risk', 25_000, 3);

    expect(offer.id).toMatch(/^mutual-/);
    expect(offer.backerId).toBe('agent-1');
    expect(offer.coverageType).toBe('smart-contract-risk');
    expect(offer.maxCoverageUsd).toBe(25_000);
    expect(offer.premiumRatePct).toBe(3);
    expect(offer.active).toBe(true);
  });

  // ── 14. Accept mutual insurance offer ────────────────────────────
  it('accepts a mutual insurance offer creating a peer-backed policy', () => {
    const store = createMockStore(stateWithAgents());
    const svc = new InsuranceService(store);

    const offer = svc.createMutualOffer('agent-1', 'slippage', 20_000, 2.5);
    const policy = svc.acceptMutualOffer(offer.id, 'agent-2', 10_000);

    expect(policy.agentId).toBe('agent-2');
    expect(policy.backerId).toBe('agent-1');
    expect(policy.coverageAmountUsd).toBe(10_000);
    expect(policy.status).toBe('active');
    expect(policy.premiumUsd).toBe(250); // 10000 * 2.5%
  });

  // ── 15. Cannot self-insure via mutual ─────────────────────────────
  it('prevents an agent from insuring itself via mutual offer', () => {
    const store = createMockStore(stateWithAgents());
    const svc = new InsuranceService(store);

    const offer = svc.createMutualOffer('agent-1', 'slippage', 20_000, 2);

    expect(() => svc.acceptMutualOffer(offer.id, 'agent-1', 5_000)).toThrow('cannot insure itself');
  });

  // ── 16. List mutual offers filtered by type ───────────────────────
  it('lists mutual offers filtered by coverage type', () => {
    const store = createMockStore(stateWithAgents());
    const svc = new InsuranceService(store);

    svc.createMutualOffer('agent-1', 'slippage', 10_000, 2);
    svc.createMutualOffer('agent-2', 'black-swan', 30_000, 5);
    svc.createMutualOffer('agent-1', 'slippage', 20_000, 3);

    const slippageOffers = svc.getMutualOffers('slippage');
    expect(slippageOffers).toHaveLength(2);
    expect(slippageOffers.every((o) => o.coverageType === 'slippage')).toBe(true);
    // Should be sorted by premium rate ascending
    expect(slippageOffers[0].premiumRatePct).toBeLessThanOrEqual(slippageOffers[1].premiumRatePct);

    const allOffers = svc.getMutualOffers();
    expect(allOffers).toHaveLength(3);
  });

  // ── 17. Claim exceeding coverage is rejected ──────────────────────
  it('rejects a claim that exceeds coverage amount', () => {
    const store = createMockStore(stateWithAgents());
    const svc = new InsuranceService(store);
    svc.contribute('agent-1', 100_000);

    const policy = svc.createPolicy('agent-1', 'slippage', 5_000);

    expect(() =>
      svc.submitClaim(policy.id, 'agent-1', 10_000, 'Claim exceeds coverage amount limit', 'evidence'),
    ).toThrow('exceeds coverage');
  });

  // ── 18. Coverage ratio tracking ───────────────────────────────────
  it('tracks coverage ratio correctly', () => {
    const store = createMockStore(stateWithAgents());
    const svc = new InsuranceService(store);
    svc.contribute('agent-1', 20_000);

    // Pool starts at 20k with no exposure → ratio should be 1
    let pool = svc.getPoolStatus();
    expect(pool.coverageRatio).toBe(1);

    // Create a policy — adds premium to pool, adds coverage exposure
    svc.createPolicy('agent-1', 'slippage', 10_000);

    pool = svc.getPoolStatus();
    expect(pool.activePolicies).toBe(1);
    expect(pool.coverageRatio).toBeGreaterThan(0);
  });
});
