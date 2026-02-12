/**
 * On-Chain Governance Participation Service.
 *
 * Agents participate in DAO governance: proposal analysis, voting strategy,
 * delegation management, governance calendar, vote impact analysis, and
 * historical governance participation tracking.
 */

import { v4 as uuid } from 'uuid';
import { DomainError, ErrorCode } from '../errors/taxonomy.js';
import { StateStore } from '../infra/storage/stateStore.js';
import { isoNow } from '../utils/time.js';

// ─── Types ──────────────────────────────────────────────────────────────

export type ProposalCategory =
  | 'treasury'
  | 'protocol-upgrade'
  | 'parameter-change'
  | 'grant'
  | 'fee-structure'
  | 'other';

export type ProposalRiskLevel = 'low' | 'medium' | 'high' | 'critical';

export type VoteChoice = 'for' | 'against' | 'abstain';

export interface DAOProposal {
  id: string;
  daoName: string;
  title: string;
  description: string;
  category: ProposalCategory;
  proposer: string;
  status: 'active' | 'passed' | 'rejected' | 'expired' | 'queued' | 'executed';
  createdAt: string;
  votingStartsAt: string;
  votingEndsAt: string;
  forVotes: number;
  againstVotes: number;
  abstainVotes: number;
  quorumRequired: number;
  url?: string;
}

export interface ProposalAnalysis {
  proposalId: string;
  summary: string;
  riskLevel: ProposalRiskLevel;
  score: number;               // 0–100 overall quality score
  impactAreas: string[];
  pros: string[];
  cons: string[];
  recommendation: VoteChoice;
  confidence: number;          // 0–1
  analyzedAt: string;
}

export interface VoteRecord {
  id: string;
  agentId: string;
  proposalId: string;
  daoName: string;
  choice: VoteChoice;
  votingPower: number;
  rationale: string;
  castedAt: string;
  txSignature?: string;
}

export interface Delegation {
  id: string;
  fromAgentId: string;
  toDelegate: string;
  daoName: string;
  votingPower: number;
  delegatedAt: string;
  expiresAt?: string;
  active: boolean;
}

export interface CalendarEvent {
  proposalId: string;
  daoName: string;
  title: string;
  eventType: 'voting-start' | 'voting-end' | 'execution';
  scheduledAt: string;
  status: 'upcoming' | 'in-progress' | 'completed';
}

export interface VoteImpact {
  proposalId: string;
  agentId: string;
  affectedPositions: Array<{
    symbol: string;
    currentValue: number;
    estimatedChangePercent: number;
    riskDelta: ProposalRiskLevel;
  }>;
  overallPortfolioImpactPct: number;
  liquidityImpact: 'positive' | 'negative' | 'neutral';
  recommendedAction: string;
  analyzedAt: string;
}

export interface GovernanceHistory {
  agentId: string;
  totalVotesCast: number;
  proposalsAnalyzed: number;
  activeDelegations: number;
  participationRate: number;   // 0–1
  votingPowerUtilized: number;
  votes: VoteRecord[];
  analyses: ProposalAnalysis[];
  delegations: Delegation[];
}

// ─── Service ────────────────────────────────────────────────────────────

export class OnChainGovernanceService {
  private proposals: Map<string, DAOProposal> = new Map();
  private analyses: Map<string, ProposalAnalysis> = new Map();
  private votes: VoteRecord[] = [];
  private delegations: Delegation[] = [];

  constructor(private readonly store: StateStore) {
    this.seedProposals();
  }

  // ─── Proposals ──────────────────────────────────────────────────────

  listProposals(filters?: {
    daoName?: string;
    status?: DAOProposal['status'];
    category?: ProposalCategory;
  }): DAOProposal[] {
    let proposals = Array.from(this.proposals.values());

    if (filters?.daoName) {
      proposals = proposals.filter((p) => p.daoName === filters.daoName);
    }
    if (filters?.status) {
      proposals = proposals.filter((p) => p.status === filters.status);
    }
    if (filters?.category) {
      proposals = proposals.filter((p) => p.category === filters.category);
    }

    return proposals.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getProposal(proposalId: string): DAOProposal | null {
    return this.proposals.get(proposalId) ?? null;
  }

  // ─── Proposal Analysis ─────────────────────────────────────────────

  analyzeProposal(proposalId: string, agentId: string): ProposalAnalysis {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) {
      throw new DomainError(ErrorCode.InvalidPayload, 404, 'Proposal not found.');
    }

    const state = this.store.snapshot();
    const agent = state.agents[agentId];
    if (!agent) {
      throw new DomainError(ErrorCode.AgentNotFound, 404, 'Agent not found.');
    }

    // Determine risk based on category and proposal characteristics
    const riskLevel = this.assessRisk(proposal);
    const score = this.scoreProposal(proposal, riskLevel);
    const { pros, cons } = this.evaluateProsCons(proposal);
    const recommendation = this.deriveRecommendation(score, riskLevel, agent);
    const confidence = this.calculateConfidence(proposal);

    const analysis: ProposalAnalysis = {
      proposalId,
      summary: `${proposal.title}: ${proposal.description.slice(0, 200)}`,
      riskLevel,
      score,
      impactAreas: this.identifyImpactAreas(proposal),
      pros,
      cons,
      recommendation,
      confidence,
      analyzedAt: isoNow(),
    };

    this.analyses.set(`${proposalId}:${agentId}`, analysis);
    return analysis;
  }

  // ─── Voting ─────────────────────────────────────────────────────────

  castVote(input: {
    agentId: string;
    proposalId: string;
    choice: VoteChoice;
    votingPower?: number;
    rationale?: string;
  }): VoteRecord {
    const state = this.store.snapshot();
    const agent = state.agents[input.agentId];
    if (!agent) {
      throw new DomainError(ErrorCode.AgentNotFound, 404, 'Agent not found.');
    }

    const proposal = this.proposals.get(input.proposalId);
    if (!proposal) {
      throw new DomainError(ErrorCode.InvalidPayload, 404, 'Proposal not found.');
    }

    if (proposal.status !== 'active') {
      throw new DomainError(
        ErrorCode.InvalidPayload,
        400,
        `Proposal is ${proposal.status}, voting is closed.`,
      );
    }

    // Check for duplicate votes
    const existing = this.votes.find(
      (v) => v.agentId === input.agentId && v.proposalId === input.proposalId,
    );
    if (existing) {
      throw new DomainError(
        ErrorCode.InvalidPayload,
        400,
        'Agent has already voted on this proposal.',
      );
    }

    const votingPower = input.votingPower ?? 1;

    const record: VoteRecord = {
      id: uuid(),
      agentId: input.agentId,
      proposalId: input.proposalId,
      daoName: proposal.daoName,
      choice: input.choice,
      votingPower,
      rationale: input.rationale ?? '',
      castedAt: isoNow(),
    };

    this.votes.push(record);

    // Update proposal tallies
    if (input.choice === 'for') proposal.forVotes += votingPower;
    else if (input.choice === 'against') proposal.againstVotes += votingPower;
    else proposal.abstainVotes += votingPower;

    return structuredClone(record);
  }

  // ─── Delegation ─────────────────────────────────────────────────────

  getDelegations(agentId: string): Delegation[] {
    return this.delegations
      .filter((d) => d.fromAgentId === agentId)
      .map((d) => structuredClone(d));
  }

  delegate(input: {
    fromAgentId: string;
    toDelegate: string;
    daoName: string;
    votingPower: number;
    expiresAt?: string;
  }): Delegation {
    const state = this.store.snapshot();
    if (!state.agents[input.fromAgentId]) {
      throw new DomainError(ErrorCode.AgentNotFound, 404, 'Delegating agent not found.');
    }

    // Check for existing active delegation to same delegate in same DAO
    const existingActive = this.delegations.find(
      (d) =>
        d.fromAgentId === input.fromAgentId &&
        d.toDelegate === input.toDelegate &&
        d.daoName === input.daoName &&
        d.active,
    );
    if (existingActive) {
      throw new DomainError(
        ErrorCode.InvalidPayload,
        400,
        'Active delegation already exists to this delegate in this DAO.',
      );
    }

    const delegation: Delegation = {
      id: uuid(),
      fromAgentId: input.fromAgentId,
      toDelegate: input.toDelegate,
      daoName: input.daoName,
      votingPower: input.votingPower,
      delegatedAt: isoNow(),
      expiresAt: input.expiresAt,
      active: true,
    };

    this.delegations.push(delegation);
    return structuredClone(delegation);
  }

  // ─── Calendar ───────────────────────────────────────────────────────

  getCalendar(filters?: { daoName?: string; status?: CalendarEvent['status'] }): CalendarEvent[] {
    const events: CalendarEvent[] = [];
    const now = Date.now();

    for (const proposal of this.proposals.values()) {
      if (filters?.daoName && proposal.daoName !== filters.daoName) continue;

      const votingStart = new Date(proposal.votingStartsAt).getTime();
      const votingEnd = new Date(proposal.votingEndsAt).getTime();

      const startStatus: CalendarEvent['status'] =
        now < votingStart ? 'upcoming' : now <= votingEnd ? 'in-progress' : 'completed';

      const endStatus: CalendarEvent['status'] =
        now < votingEnd ? 'upcoming' : 'completed';

      if (!filters?.status || filters.status === startStatus) {
        events.push({
          proposalId: proposal.id,
          daoName: proposal.daoName,
          title: `Voting starts: ${proposal.title}`,
          eventType: 'voting-start',
          scheduledAt: proposal.votingStartsAt,
          status: startStatus,
        });
      }

      if (!filters?.status || filters.status === endStatus) {
        events.push({
          proposalId: proposal.id,
          daoName: proposal.daoName,
          title: `Voting ends: ${proposal.title}`,
          eventType: 'voting-end',
          scheduledAt: proposal.votingEndsAt,
          status: endStatus,
        });
      }
    }

    return events.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
  }

  // ─── Vote Impact Analysis ──────────────────────────────────────────

  analyzeVoteImpact(proposalId: string, agentId: string): VoteImpact {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) {
      throw new DomainError(ErrorCode.InvalidPayload, 404, 'Proposal not found.');
    }

    const state = this.store.snapshot();
    const agent = state.agents[agentId];
    if (!agent) {
      throw new DomainError(ErrorCode.AgentNotFound, 404, 'Agent not found.');
    }

    const positions = agent.positions ?? {};
    const marketPrices = state.marketPricesUsd ?? {};

    const affectedPositions = Object.entries(positions).map(([symbol, pos]) => {
      const price = marketPrices[symbol] ?? (pos as any).avgEntryPriceUsd ?? 0;
      const quantity = (pos as any).quantity ?? 0;
      const currentValue = price * quantity;

      // Estimate impact based on proposal category
      const changePct = this.estimatePositionImpact(proposal, symbol);

      return {
        symbol,
        currentValue,
        estimatedChangePercent: changePct,
        riskDelta: Math.abs(changePct) > 10 ? 'high' as ProposalRiskLevel :
                   Math.abs(changePct) > 5 ? 'medium' as ProposalRiskLevel : 'low' as ProposalRiskLevel,
      };
    });

    const totalValue = affectedPositions.reduce((sum, p) => sum + p.currentValue, 0);
    const weightedImpact = totalValue > 0
      ? affectedPositions.reduce(
          (sum, p) => sum + (p.estimatedChangePercent * p.currentValue) / totalValue,
          0,
        )
      : 0;

    const impact: VoteImpact = {
      proposalId,
      agentId,
      affectedPositions,
      overallPortfolioImpactPct: Math.round(weightedImpact * 100) / 100,
      liquidityImpact:
        proposal.category === 'fee-structure' ? 'negative' :
        proposal.category === 'treasury' ? 'positive' : 'neutral',
      recommendedAction: weightedImpact > 5
        ? 'Hedge positions before vote outcome'
        : weightedImpact < -5
        ? 'Consider reducing exposure'
        : 'No action needed',
      analyzedAt: isoNow(),
    };

    return impact;
  }

  // ─── History ────────────────────────────────────────────────────────

  getHistory(agentId: string): GovernanceHistory {
    const state = this.store.snapshot();
    if (!state.agents[agentId]) {
      throw new DomainError(ErrorCode.AgentNotFound, 404, 'Agent not found.');
    }

    const agentVotes = this.votes.filter((v) => v.agentId === agentId);
    const agentAnalyses = Array.from(this.analyses.entries())
      .filter(([key]) => key.endsWith(`:${agentId}`))
      .map(([, a]) => a);
    const agentDelegations = this.delegations.filter((d) => d.fromAgentId === agentId);
    const activeDelegations = agentDelegations.filter((d) => d.active);
    const totalProposals = this.proposals.size;
    const participationRate = totalProposals > 0
      ? agentVotes.length / totalProposals
      : 0;

    return {
      agentId,
      totalVotesCast: agentVotes.length,
      proposalsAnalyzed: agentAnalyses.length,
      activeDelegations: activeDelegations.length,
      participationRate: Math.round(participationRate * 1000) / 1000,
      votingPowerUtilized: agentVotes.reduce((sum, v) => sum + v.votingPower, 0),
      votes: agentVotes.map((v) => structuredClone(v)),
      analyses: agentAnalyses,
      delegations: agentDelegations.map((d) => structuredClone(d)),
    };
  }

  // ─── Internal Helpers ─────────────────────────────────────────────

  private assessRisk(proposal: DAOProposal): ProposalRiskLevel {
    if (proposal.category === 'protocol-upgrade') return 'high';
    if (proposal.category === 'treasury' && proposal.description.toLowerCase().includes('large'))
      return 'critical';
    if (proposal.category === 'parameter-change') return 'medium';
    if (proposal.category === 'grant') return 'low';
    if (proposal.category === 'fee-structure') return 'medium';
    return 'low';
  }

  private scoreProposal(proposal: DAOProposal, riskLevel: ProposalRiskLevel): number {
    let score = 50;

    // Higher quorum indicates more community interest
    if (proposal.quorumRequired > 0) {
      const totalVotes = proposal.forVotes + proposal.againstVotes + proposal.abstainVotes;
      const quorumProgress = totalVotes / proposal.quorumRequired;
      score += Math.min(quorumProgress * 20, 20);
    }

    // Risk adjustment
    const riskPenalty: Record<ProposalRiskLevel, number> = {
      low: 0,
      medium: -5,
      high: -15,
      critical: -25,
    };
    score += riskPenalty[riskLevel];

    // Support ratio bonus
    const totalVotes = proposal.forVotes + proposal.againstVotes;
    if (totalVotes > 0) {
      const supportRatio = proposal.forVotes / totalVotes;
      score += (supportRatio - 0.5) * 30;
    }

    return Math.max(0, Math.min(100, Math.round(score)));
  }

  private evaluateProsCons(proposal: DAOProposal): { pros: string[]; cons: string[] } {
    const pros: string[] = [];
    const cons: string[] = [];

    switch (proposal.category) {
      case 'treasury':
        pros.push('Potential for ecosystem growth');
        cons.push('Reduces treasury reserves');
        break;
      case 'protocol-upgrade':
        pros.push('Improved protocol functionality');
        cons.push('Technical risk during migration');
        break;
      case 'parameter-change':
        pros.push('Optimizes existing parameters');
        cons.push('May affect existing user strategies');
        break;
      case 'grant':
        pros.push('Supports ecosystem development');
        cons.push('Opportunity cost of grant funds');
        break;
      case 'fee-structure':
        pros.push('May improve protocol revenue');
        cons.push('Could reduce user participation');
        break;
      default:
        pros.push('Community-driven improvement');
        cons.push('Unknown long-term effects');
    }

    if (proposal.forVotes > proposal.againstVotes * 2) {
      pros.push('Strong community support');
    }
    if (proposal.againstVotes > proposal.forVotes) {
      cons.push('Significant community opposition');
    }

    return { pros, cons };
  }

  private deriveRecommendation(
    score: number,
    riskLevel: ProposalRiskLevel,
    _agent: any,
  ): VoteChoice {
    if (riskLevel === 'critical') return 'against';
    if (score >= 65) return 'for';
    if (score <= 35) return 'against';
    return 'abstain';
  }

  private calculateConfidence(proposal: DAOProposal): number {
    const totalVotes = proposal.forVotes + proposal.againstVotes + proposal.abstainVotes;
    // More votes → higher confidence
    const voteConfidence = Math.min(totalVotes / 100, 0.5);
    // Longer description → more info
    const infoConfidence = Math.min(proposal.description.length / 1000, 0.3);
    return Math.round((0.2 + voteConfidence + infoConfidence) * 100) / 100;
  }

  private identifyImpactAreas(proposal: DAOProposal): string[] {
    const areas: string[] = [];
    switch (proposal.category) {
      case 'treasury':
        areas.push('Treasury', 'Token Supply');
        break;
      case 'protocol-upgrade':
        areas.push('Smart Contracts', 'Security', 'Functionality');
        break;
      case 'parameter-change':
        areas.push('Protocol Parameters', 'User Experience');
        break;
      case 'grant':
        areas.push('Ecosystem Growth', 'Treasury');
        break;
      case 'fee-structure':
        areas.push('Trading Fees', 'Revenue', 'Liquidity');
        break;
      default:
        areas.push('General');
    }
    return areas;
  }

  private estimatePositionImpact(proposal: DAOProposal, _symbol: string): number {
    // Simplified estimation based on category
    switch (proposal.category) {
      case 'protocol-upgrade':
        return 3.5;
      case 'fee-structure':
        return -2.0;
      case 'treasury':
        return 1.5;
      case 'parameter-change':
        return -0.5;
      default:
        return 0;
    }
  }

  private seedProposals(): void {
    const now = Date.now();
    const hour = 60 * 60 * 1000;
    const day = 24 * hour;

    const seeds: DAOProposal[] = [
      {
        id: 'prop-jup-001',
        daoName: 'Jupiter DAO',
        title: 'Increase JUP Staking Rewards',
        description: 'Proposal to increase staking rewards for JUP token holders from 5% to 8% APY to incentivize long-term holding and reduce sell pressure.',
        category: 'parameter-change',
        proposer: 'jupiter-core-team',
        status: 'active',
        createdAt: new Date(now - 2 * day).toISOString(),
        votingStartsAt: new Date(now - 1 * day).toISOString(),
        votingEndsAt: new Date(now + 5 * day).toISOString(),
        forVotes: 1_250_000,
        againstVotes: 340_000,
        abstainVotes: 85_000,
        quorumRequired: 2_000_000,
      },
      {
        id: 'prop-marinade-001',
        daoName: 'Marinade Finance',
        title: 'Treasury Diversification',
        description: 'Allocate 10% of treasury funds to a diversified basket of Solana DeFi tokens to reduce single-asset risk.',
        category: 'treasury',
        proposer: 'marinade-multisig',
        status: 'active',
        createdAt: new Date(now - 3 * day).toISOString(),
        votingStartsAt: new Date(now - 2 * day).toISOString(),
        votingEndsAt: new Date(now + 4 * day).toISOString(),
        forVotes: 800_000,
        againstVotes: 600_000,
        abstainVotes: 120_000,
        quorumRequired: 1_500_000,
      },
      {
        id: 'prop-raydium-001',
        daoName: 'Raydium',
        title: 'Protocol V3 Upgrade',
        description: 'Major protocol upgrade introducing concentrated liquidity, improved routing, and reduced gas costs for swaps.',
        category: 'protocol-upgrade',
        proposer: 'raydium-labs',
        status: 'active',
        createdAt: new Date(now - 1 * day).toISOString(),
        votingStartsAt: new Date(now).toISOString(),
        votingEndsAt: new Date(now + 7 * day).toISOString(),
        forVotes: 2_100_000,
        againstVotes: 150_000,
        abstainVotes: 50_000,
        quorumRequired: 3_000_000,
      },
      {
        id: 'prop-jup-002',
        daoName: 'Jupiter DAO',
        title: 'Ecosystem Development Grant',
        description: 'Grant of 500,000 JUP tokens to fund development of new integrations and tooling for the Jupiter ecosystem.',
        category: 'grant',
        proposer: 'community-member-42',
        status: 'passed',
        createdAt: new Date(now - 10 * day).toISOString(),
        votingStartsAt: new Date(now - 9 * day).toISOString(),
        votingEndsAt: new Date(now - 3 * day).toISOString(),
        forVotes: 3_500_000,
        againstVotes: 500_000,
        abstainVotes: 200_000,
        quorumRequired: 2_000_000,
      },
      {
        id: 'prop-drift-001',
        daoName: 'Drift Protocol',
        title: 'Trading Fee Restructure',
        description: 'Restructure trading fees: reduce maker fees by 25% and increase taker fees by 10% to incentivize liquidity provision.',
        category: 'fee-structure',
        proposer: 'drift-governance',
        status: 'active',
        createdAt: new Date(now - 1 * day).toISOString(),
        votingStartsAt: new Date(now + 1 * day).toISOString(),
        votingEndsAt: new Date(now + 8 * day).toISOString(),
        forVotes: 0,
        againstVotes: 0,
        abstainVotes: 0,
        quorumRequired: 1_000_000,
      },
    ];

    for (const p of seeds) {
      this.proposals.set(p.id, p);
    }
  }
}
