import { describe, expect, it, vi } from 'vitest';
import { GovernanceService } from '../src/services/governanceService.js';
import { AppState, Agent } from '../src/types.js';
import { createDefaultState } from '../src/infra/storage/defaultState.js';

function createMockStore(state: AppState) {
  return {
    snapshot: () => structuredClone(state),
    transaction: vi.fn(),
    init: vi.fn(),
    flush: vi.fn(),
  } as any;
}

function makeAgent(id: string, name: string): Agent {
  return {
    id,
    name,
    apiKey: `key-${id}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    startingCapitalUsd: 10000,
    cashUsd: 10000,
    realizedPnlUsd: 0,
    peakEquityUsd: 10000,
    riskLimits: {
      maxPositionSizePct: 0.25,
      maxOrderNotionalUsd: 2500,
      maxGrossExposureUsd: 7500,
      dailyLossCapUsd: 1000,
      maxDrawdownPct: 0.2,
      cooldownSeconds: 3,
    },
    positions: {},
    dailyRealizedPnlUsd: {},
    riskRejectionsByReason: {},
    strategyId: 'momentum-v1',
  };
}

describe('GovernanceService', () => {
  const baseInput = {
    proposerId: 'agent-1',
    type: 'strategy_change' as const,
    title: 'Switch to mean reversion',
    description: 'Mean reversion performs better in current market conditions.',
    params: { strategyId: 'mean-reversion-v1' },
  };

  function setup(agentCount = 3) {
    const state = createDefaultState();
    for (let i = 1; i <= agentCount; i++) {
      state.agents[`agent-${i}`] = makeAgent(`agent-${i}`, `Agent ${i}`);
    }
    const store = createMockStore(state);
    const service = new GovernanceService(store);
    return { state, store, service };
  }

  it('creates a proposal successfully', () => {
    const { service } = setup();
    const proposal = service.createProposal(baseInput);

    expect(proposal.id).toBeDefined();
    expect(proposal.proposerId).toBe('agent-1');
    expect(proposal.type).toBe('strategy_change');
    expect(proposal.status).toBe('active');
    expect(proposal.votes).toEqual([]);
    expect(proposal.expiresAt).toBeDefined();
  });

  it('rejects proposal from unknown agent', () => {
    const { service } = setup();
    expect(() =>
      service.createProposal({ ...baseInput, proposerId: 'ghost' }),
    ).toThrow('Proposer agent not found');
  });

  it('allows agents to vote and resolves majority', () => {
    const { service } = setup(3);
    const proposal = service.createProposal(baseInput);

    // Agent 2 votes for
    const afterVote1 = service.vote(proposal.id, { agentId: 'agent-2', value: 'for' });
    expect(afterVote1.votes.length).toBe(1);
    expect(afterVote1.status).toBe('active'); // 1/3, need 2

    // Agent 3 votes for → majority (2/3)
    const afterVote2 = service.vote(proposal.id, { agentId: 'agent-3', value: 'for' });
    expect(afterVote2.votes.length).toBe(2);
    expect(afterVote2.status).toBe('approved');
    expect(afterVote2.resolvedAt).toBeDefined();
  });

  it('rejects proposal when majority votes against', () => {
    const { service } = setup(3);
    const proposal = service.createProposal(baseInput);

    service.vote(proposal.id, { agentId: 'agent-2', value: 'against' });
    const final = service.vote(proposal.id, { agentId: 'agent-3', value: 'against' });

    expect(final.status).toBe('rejected');
  });

  it('prevents duplicate votes from the same agent', () => {
    const { service } = setup();
    const proposal = service.createProposal(baseInput);

    service.vote(proposal.id, { agentId: 'agent-2', value: 'for' });

    expect(() =>
      service.vote(proposal.id, { agentId: 'agent-2', value: 'against' }),
    ).toThrow('already voted');
  });

  it('prevents voting on non-existent proposal', () => {
    const { service } = setup();
    expect(() =>
      service.vote('nonexistent', { agentId: 'agent-1', value: 'for' }),
    ).toThrow('Proposal not found');
  });

  it('prevents voting by unknown agent', () => {
    const { service } = setup();
    const proposal = service.createProposal(baseInput);

    expect(() =>
      service.vote(proposal.id, { agentId: 'ghost', value: 'for' }),
    ).toThrow('Voting agent not found');
  });

  it('lists active proposals', () => {
    const { service } = setup();
    service.createProposal(baseInput);
    service.createProposal({ ...baseInput, title: 'Another proposal' });

    const list = service.listProposals('active');
    expect(list.length).toBe(2);
  });

  it('expires proposals past their expiry time', async () => {
    const { service } = setup();
    const proposal = service.createProposal({
      ...baseInput,
      expiresInMs: 5, // 5ms
    });

    // Wait for expiry
    await new Promise((resolve) => setTimeout(resolve, 20));

    const fetched = service.getProposal(proposal.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.status).toBe('expired');
  });

  it('prevents voting on expired proposals', async () => {
    const { service } = setup();
    const proposal = service.createProposal({
      ...baseInput,
      expiresInMs: 5,
    });

    // Wait for expiry
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(() =>
      service.vote(proposal.id, { agentId: 'agent-2', value: 'for' }),
    ).toThrow('expired');
  });

  it('returns proposals filtered by status', () => {
    const { service } = setup(3);

    // Create one that will be approved
    const p1 = service.createProposal(baseInput);
    service.vote(p1.id, { agentId: 'agent-2', value: 'for' });
    service.vote(p1.id, { agentId: 'agent-3', value: 'for' });

    // Create one that stays active
    service.createProposal({ ...baseInput, title: 'Still active' });

    const approved = service.listProposals('approved');
    expect(approved.length).toBe(1);
    expect(approved[0].id).toBe(p1.id);

    const active = service.listProposals('active');
    expect(active.length).toBe(1);
  });
});
