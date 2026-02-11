/**
 * Governance / strategy voting types.
 *
 * Agents can propose changes to strategy parameters.
 * Other agents vote; majority approval auto-applies the change.
 */

export type ProposalStatus = 'active' | 'approved' | 'rejected' | 'expired';

export type ProposalType =
  | 'strategy_change'
  | 'risk_parameter'
  | 'fee_adjustment'
  | 'general';

export interface Proposal {
  id: string;
  proposerId: string;
  type: ProposalType;
  title: string;
  description: string;
  params: Record<string, unknown>;
  votes: Vote[];
  status: ProposalStatus;
  createdAt: string;
  expiresAt: string;
  resolvedAt?: string;
}

export interface Vote {
  agentId: string;
  proposalId: string;
  value: 'for' | 'against';
  castAt: string;
}

export interface GovernanceState {
  proposals: Record<string, Proposal>;
}
