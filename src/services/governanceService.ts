/**
 * Governance / strategy voting service.
 *
 * Agents can propose strategy parameter changes. Other agents vote.
 * If majority of registered agents approves before expiry, the proposal
 * is automatically approved. Expired proposals are marked as such.
 */

import { v4 as uuid } from 'uuid';
import {
  GovernanceState,
  Proposal,
  ProposalStatus,
  ProposalType,
  Vote,
} from '../domain/governance/governanceTypes.js';
import { StateStore } from '../infra/storage/stateStore.js';
import { DomainError, ErrorCode } from '../errors/taxonomy.js';
import { isoNow } from '../utils/time.js';

/** Default proposal lifetime: 24 hours. */
const DEFAULT_EXPIRY_MS = 24 * 60 * 60 * 1000;

export interface CreateProposalInput {
  proposerId: string;
  type: ProposalType;
  title: string;
  description: string;
  params: Record<string, unknown>;
  expiresInMs?: number;
}

export interface CastVoteInput {
  agentId: string;
  value: 'for' | 'against';
}

export class GovernanceService {
  private state: GovernanceState = { proposals: {} };

  constructor(private readonly store: StateStore) {}

  /**
   * Create a new governance proposal.
   */
  createProposal(input: CreateProposalInput): Proposal {
    const state = this.store.snapshot();
    const agent = state.agents[input.proposerId];
    if (!agent) {
      throw new DomainError(ErrorCode.AgentNotFound, 404, 'Proposer agent not found.');
    }

    const now = isoNow();
    const expiresAt = new Date(
      Date.now() + (input.expiresInMs ?? DEFAULT_EXPIRY_MS),
    ).toISOString();

    const proposal: Proposal = {
      id: uuid(),
      proposerId: input.proposerId,
      type: input.type,
      title: input.title,
      description: input.description,
      params: input.params,
      votes: [],
      status: 'active',
      createdAt: now,
      expiresAt,
    };

    this.state.proposals[proposal.id] = proposal;
    return structuredClone(proposal);
  }

  /**
   * Cast a vote on a proposal.
   * Each agent can vote only once per proposal.
   */
  vote(proposalId: string, input: CastVoteInput): Proposal {
    const proposal = this.state.proposals[proposalId];
    if (!proposal) {
      throw new DomainError(ErrorCode.InvalidPayload, 404, 'Proposal not found.');
    }

    // Expire check.
    this.expireIfNeeded(proposal);
    if (proposal.status !== 'active') {
      throw new DomainError(
        ErrorCode.InvalidPayload,
        400,
        `Proposal is ${proposal.status}, voting is closed.`,
      );
    }

    // Verify voter exists.
    const state = this.store.snapshot();
    if (!state.agents[input.agentId]) {
      throw new DomainError(ErrorCode.AgentNotFound, 404, 'Voting agent not found.');
    }

    // Check duplicate vote.
    const alreadyVoted = proposal.votes.some((v) => v.agentId === input.agentId);
    if (alreadyVoted) {
      throw new DomainError(
        ErrorCode.InvalidPayload,
        400,
        'Agent has already voted on this proposal.',
      );
    }

    const vote: Vote = {
      agentId: input.agentId,
      proposalId,
      value: input.value,
      castAt: isoNow(),
    };

    proposal.votes.push(vote);

    // Check majority.
    this.resolveMajority(proposal);

    return structuredClone(proposal);
  }

  /**
   * List proposals, optionally filtered by status.
   */
  listProposals(statusFilter?: ProposalStatus): Proposal[] {
    // Expire any stale proposals first.
    for (const proposal of Object.values(this.state.proposals)) {
      this.expireIfNeeded(proposal);
    }

    const proposals = Object.values(this.state.proposals);

    const filtered = statusFilter
      ? proposals.filter((p) => p.status === statusFilter)
      : proposals;

    return filtered
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((p) => structuredClone(p));
  }

  /**
   * Get a single proposal by ID.
   */
  getProposal(proposalId: string): Proposal | null {
    const proposal = this.state.proposals[proposalId];
    if (!proposal) return null;
    this.expireIfNeeded(proposal);
    return structuredClone(proposal);
  }

  /**
   * Get the governance state snapshot.
   */
  getState(): GovernanceState {
    return structuredClone(this.state);
  }

  // ─── Internals ──────────────────────────────────────────────────────

  private expireIfNeeded(proposal: Proposal): void {
    if (proposal.status !== 'active') return;

    if (new Date(proposal.expiresAt).getTime() <= Date.now()) {
      proposal.status = 'expired';
      proposal.resolvedAt = isoNow();
    }
  }

  private resolveMajority(proposal: Proposal): void {
    const state = this.store.snapshot();
    const totalAgents = Object.keys(state.agents).length;

    if (totalAgents === 0) return;

    const forVotes = proposal.votes.filter((v) => v.value === 'for').length;
    const againstVotes = proposal.votes.filter((v) => v.value === 'against').length;

    const majority = Math.floor(totalAgents / 2) + 1;

    if (forVotes >= majority) {
      proposal.status = 'approved';
      proposal.resolvedAt = isoNow();
    } else if (againstVotes >= majority) {
      proposal.status = 'rejected';
      proposal.resolvedAt = isoNow();
    }
  }
}
