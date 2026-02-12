/**
 * Agent Swarm Intelligence Service.
 *
 * Collective decision-making from multiple agents. Supports:
 * - Swarm voting (agents vote on trade decisions, majority wins)
 * - Signal aggregation (combine signals with confidence weighting)
 * - Consensus mechanisms (simple majority, supermajority, weighted)
 * - Swarm performance tracking (swarm vs individual performance)
 * - Dissent tracking (which agents disagree most with the swarm?)
 * - Swarm composition optimizer (which combination performs best?)
 */

import { v4 as uuid } from 'uuid';
import { DomainError, ErrorCode } from '../errors/taxonomy.js';
import { eventBus } from '../infra/eventBus.js';
import { isoNow } from '../utils/time.js';

// ─── Types ──────────────────────────────────────────────────────────────

export type VoteSide = 'buy' | 'sell' | 'hold';
export type ConsensusMethod = 'simple_majority' | 'supermajority' | 'weighted';

export interface SwarmVote {
  id: string;
  topic: string;
  agentId: string;
  side: VoteSide;
  confidence: number; // 0–1
  weight: number;     // agent weight in swarm (default 1)
  reasoning?: string;
  createdAt: string;
}

export interface SwarmConsensus {
  topic: string;
  method: ConsensusMethod;
  decision: VoteSide;
  confidence: number;
  totalVotes: number;
  breakdown: Record<VoteSide, { count: number; totalWeight: number; avgConfidence: number }>;
  quorumReached: boolean;
  unanimity: boolean;
  createdAt: string;
}

export interface AggregatedSignal {
  id: string;
  symbol: string;
  side: VoteSide;
  aggregatedConfidence: number;
  signalCount: number;
  weightedScore: number;
  signals: Array<{
    agentId: string;
    side: VoteSide;
    confidence: number;
    weight: number;
  }>;
  createdAt: string;
}

export interface SwarmPerformanceRecord {
  topic: string;
  swarmDecision: VoteSide;
  actualOutcome: VoteSide;
  swarmCorrect: boolean;
  agentResults: Array<{
    agentId: string;
    vote: VoteSide;
    correct: boolean;
  }>;
  recordedAt: string;
}

export interface SwarmPerformance {
  totalDecisions: number;
  swarmAccuracy: number;
  individualAccuracies: Record<string, { correct: number; total: number; accuracy: number }>;
  swarmOutperformsPct: number;
  recentRecords: SwarmPerformanceRecord[];
}

export interface DissentRecord {
  agentId: string;
  totalVotes: number;
  dissents: number;
  dissentRate: number;
  recentDissents: Array<{ topic: string; agentVote: VoteSide; swarmDecision: VoteSide; createdAt: string }>;
}

export interface OptimizationResult {
  bestCombination: string[];
  accuracy: number;
  sampleSize: number;
  allCombinations: Array<{ agents: string[]; accuracy: number; sampleSize: number }>;
  computedAt: string;
}

// ─── Service ────────────────────────────────────────────────────────────

export class SwarmIntelligenceService {
  private votes: Map<string, SwarmVote[]> = new Map();           // topic → votes
  private performanceRecords: SwarmPerformanceRecord[] = [];
  private defaultQuorum = 2;
  private supermajorityThreshold = 0.667;

  submitVote(params: {
    topic: string;
    agentId: string;
    side: VoteSide;
    confidence: number;
    weight?: number;
    reasoning?: string;
  }): SwarmVote {
    if (params.confidence < 0 || params.confidence > 1) {
      throw new DomainError(ErrorCode.InvalidPayload, 400, 'Confidence must be between 0 and 1.');
    }
    if (params.weight !== undefined && params.weight <= 0) {
      throw new DomainError(ErrorCode.InvalidPayload, 400, 'Weight must be positive.');
    }

    const topicVotes = this.votes.get(params.topic) ?? [];

    // Prevent duplicate votes from same agent on same topic
    const existing = topicVotes.find((v) => v.agentId === params.agentId);
    if (existing) {
      throw new DomainError(ErrorCode.InvalidPayload, 400, `Agent '${params.agentId}' has already voted on topic '${params.topic}'.`);
    }

    const vote: SwarmVote = {
      id: uuid(),
      topic: params.topic,
      agentId: params.agentId,
      side: params.side,
      confidence: params.confidence,
      weight: params.weight ?? 1,
      reasoning: params.reasoning,
      createdAt: isoNow(),
    };

    topicVotes.push(vote);
    this.votes.set(params.topic, topicVotes);

    eventBus.emit('swarm.vote', {
      voteId: vote.id,
      topic: vote.topic,
      agentId: vote.agentId,
      side: vote.side,
    });

    return structuredClone(vote);
  }

  getConsensus(topic: string, method: ConsensusMethod = 'simple_majority'): SwarmConsensus {
    const topicVotes = this.votes.get(topic);
    if (!topicVotes || topicVotes.length === 0) {
      throw new DomainError(ErrorCode.InvalidPayload, 404, `No votes found for topic '${topic}'.`);
    }

    const breakdown: Record<VoteSide, { count: number; totalWeight: number; avgConfidence: number }> = {
      buy: { count: 0, totalWeight: 0, avgConfidence: 0 },
      sell: { count: 0, totalWeight: 0, avgConfidence: 0 },
      hold: { count: 0, totalWeight: 0, avgConfidence: 0 },
    };

    const confidenceSums: Record<VoteSide, number> = { buy: 0, sell: 0, hold: 0 };

    for (const vote of topicVotes) {
      breakdown[vote.side].count += 1;
      breakdown[vote.side].totalWeight += vote.weight;
      confidenceSums[vote.side] += vote.confidence;
    }

    for (const side of ['buy', 'sell', 'hold'] as VoteSide[]) {
      breakdown[side].avgConfidence = breakdown[side].count > 0
        ? confidenceSums[side] / breakdown[side].count
        : 0;
    }

    let decision: VoteSide;
    let quorumReached = topicVotes.length >= this.defaultQuorum;

    if (method === 'weighted') {
      // Weighted: multiply confidence × weight, highest total weighted score wins
      const weightedScores: Record<VoteSide, number> = { buy: 0, sell: 0, hold: 0 };
      for (const vote of topicVotes) {
        weightedScores[vote.side] += vote.confidence * vote.weight;
      }
      decision = (Object.entries(weightedScores) as [VoteSide, number][])
        .sort((a, b) => b[1] - a[1])[0][0];
    } else if (method === 'supermajority') {
      // Supermajority: needs ≥ 66.7% of total weight
      const totalWeight = topicVotes.reduce((sum, v) => sum + v.weight, 0);
      const sorted = (Object.entries(breakdown) as [VoteSide, typeof breakdown['buy']][])
        .sort((a, b) => b[1].totalWeight - a[1].totalWeight);
      decision = sorted[0][0];
      quorumReached = quorumReached && (sorted[0][1].totalWeight / totalWeight) >= this.supermajorityThreshold;
    } else {
      // Simple majority: most votes wins (count-based)
      decision = (Object.entries(breakdown) as [VoteSide, typeof breakdown['buy']][])
        .sort((a, b) => b[1].count - a[1].count)[0][0];
    }

    const decisionVotes = topicVotes.filter((v) => v.side === decision);
    const overallConfidence = decisionVotes.length > 0
      ? decisionVotes.reduce((sum, v) => sum + v.confidence * v.weight, 0) /
        decisionVotes.reduce((sum, v) => sum + v.weight, 0)
      : 0;

    const unanimity = new Set(topicVotes.map((v) => v.side)).size === 1;

    const consensus: SwarmConsensus = {
      topic,
      method,
      decision,
      confidence: Number(overallConfidence.toFixed(4)),
      totalVotes: topicVotes.length,
      breakdown,
      quorumReached,
      unanimity,
      createdAt: isoNow(),
    };

    eventBus.emit('swarm.consensus', {
      topic,
      decision: consensus.decision,
      confidence: consensus.confidence,
      method,
    });

    return consensus;
  }

  aggregateSignals(signals: Array<{
    agentId: string;
    symbol: string;
    side: VoteSide;
    confidence: number;
    weight?: number;
  }>): AggregatedSignal {
    if (signals.length === 0) {
      throw new DomainError(ErrorCode.InvalidPayload, 400, 'At least one signal is required.');
    }

    const symbols = new Set(signals.map((s) => s.symbol));
    if (symbols.size > 1) {
      throw new DomainError(ErrorCode.InvalidPayload, 400, 'All signals must be for the same symbol.');
    }

    const enriched = signals.map((s) => ({
      agentId: s.agentId,
      side: s.side,
      confidence: Math.max(0, Math.min(1, s.confidence)),
      weight: s.weight ?? 1,
    }));

    // Compute weighted scores per side
    const scores: Record<VoteSide, number> = { buy: 0, sell: 0, hold: 0 };
    let totalWeight = 0;

    for (const s of enriched) {
      scores[s.side] += s.confidence * s.weight;
      totalWeight += s.weight;
    }

    const winningSide = (Object.entries(scores) as [VoteSide, number][])
      .sort((a, b) => b[1] - a[1])[0][0];

    const aggregatedConfidence = totalWeight > 0 ? scores[winningSide] / totalWeight : 0;

    const result: AggregatedSignal = {
      id: uuid(),
      symbol: signals[0].symbol,
      side: winningSide,
      aggregatedConfidence: Number(aggregatedConfidence.toFixed(4)),
      signalCount: signals.length,
      weightedScore: Number(scores[winningSide].toFixed(4)),
      signals: enriched,
      createdAt: isoNow(),
    };

    eventBus.emit('swarm.aggregate', {
      signalId: result.id,
      symbol: result.symbol,
      side: result.side,
      confidence: result.aggregatedConfidence,
    });

    return result;
  }

  recordOutcome(topic: string, actualOutcome: VoteSide): SwarmPerformanceRecord {
    const topicVotes = this.votes.get(topic);
    if (!topicVotes || topicVotes.length === 0) {
      throw new DomainError(ErrorCode.InvalidPayload, 404, `No votes found for topic '${topic}'.`);
    }

    const consensus = this.getConsensus(topic);

    const record: SwarmPerformanceRecord = {
      topic,
      swarmDecision: consensus.decision,
      actualOutcome,
      swarmCorrect: consensus.decision === actualOutcome,
      agentResults: topicVotes.map((v) => ({
        agentId: v.agentId,
        vote: v.side,
        correct: v.side === actualOutcome,
      })),
      recordedAt: isoNow(),
    };

    this.performanceRecords.push(record);

    eventBus.emit('swarm.outcome', {
      topic,
      swarmCorrect: record.swarmCorrect,
      swarmDecision: record.swarmDecision,
      actualOutcome,
    });

    return structuredClone(record);
  }

  getPerformance(): SwarmPerformance {
    const totalDecisions = this.performanceRecords.length;
    const swarmCorrect = this.performanceRecords.filter((r) => r.swarmCorrect).length;
    const swarmAccuracy = totalDecisions > 0 ? swarmCorrect / totalDecisions : 0;

    // Individual accuracies
    const individualStats: Record<string, { correct: number; total: number }> = {};
    for (const record of this.performanceRecords) {
      for (const ar of record.agentResults) {
        if (!individualStats[ar.agentId]) {
          individualStats[ar.agentId] = { correct: 0, total: 0 };
        }
        individualStats[ar.agentId].total += 1;
        if (ar.correct) individualStats[ar.agentId].correct += 1;
      }
    }

    const individualAccuracies: Record<string, { correct: number; total: number; accuracy: number }> = {};
    for (const [agentId, stats] of Object.entries(individualStats)) {
      individualAccuracies[agentId] = {
        ...stats,
        accuracy: stats.total > 0 ? stats.correct / stats.total : 0,
      };
    }

    // How often does swarm outperform each individual?
    let outperformCount = 0;
    let agentCount = 0;
    for (const stats of Object.values(individualAccuracies)) {
      agentCount += 1;
      if (swarmAccuracy >= stats.accuracy) outperformCount += 1;
    }
    const swarmOutperformsPct = agentCount > 0 ? outperformCount / agentCount : 0;

    return {
      totalDecisions,
      swarmAccuracy: Number(swarmAccuracy.toFixed(4)),
      individualAccuracies,
      swarmOutperformsPct: Number(swarmOutperformsPct.toFixed(4)),
      recentRecords: this.performanceRecords.slice(-20).map((r) => structuredClone(r)),
    };
  }

  getDissent(): DissentRecord[] {
    // Build per-agent dissent stats from all topics with consensus
    const agentDissent: Map<string, DissentRecord> = new Map();

    for (const [topic, topicVotes] of this.votes.entries()) {
      if (topicVotes.length < 2) continue;

      let consensus: SwarmConsensus;
      try {
        consensus = this.getConsensus(topic);
      } catch {
        continue;
      }

      for (const vote of topicVotes) {
        if (!agentDissent.has(vote.agentId)) {
          agentDissent.set(vote.agentId, {
            agentId: vote.agentId,
            totalVotes: 0,
            dissents: 0,
            dissentRate: 0,
            recentDissents: [],
          });
        }
        const record = agentDissent.get(vote.agentId)!;
        record.totalVotes += 1;

        if (vote.side !== consensus.decision) {
          record.dissents += 1;
          record.recentDissents.push({
            topic,
            agentVote: vote.side,
            swarmDecision: consensus.decision,
            createdAt: vote.createdAt,
          });
        }
      }
    }

    // Compute dissent rates and sort by highest dissent
    const results: DissentRecord[] = [];
    for (const record of agentDissent.values()) {
      record.dissentRate = record.totalVotes > 0
        ? Number((record.dissents / record.totalVotes).toFixed(4))
        : 0;
      record.recentDissents = record.recentDissents.slice(-10);
      results.push(record);
    }

    return results.sort((a, b) => b.dissentRate - a.dissentRate);
  }

  optimizeComposition(minGroupSize: number = 2): OptimizationResult {
    if (this.performanceRecords.length === 0) {
      throw new DomainError(ErrorCode.InvalidPayload, 400, 'No performance records available for optimization.');
    }

    // Collect all unique agent IDs from performance records
    const allAgents = new Set<string>();
    for (const record of this.performanceRecords) {
      for (const ar of record.agentResults) {
        allAgents.add(ar.agentId);
      }
    }
    const agentList = [...allAgents];

    if (agentList.length < minGroupSize) {
      throw new DomainError(ErrorCode.InvalidPayload, 400, `Need at least ${minGroupSize} agents for optimization, found ${agentList.length}.`);
    }

    // Generate all combinations of size >= minGroupSize
    const combinations = this.generateCombinations(agentList, minGroupSize);
    const results: Array<{ agents: string[]; accuracy: number; sampleSize: number }> = [];

    for (const combo of combinations) {
      const comboSet = new Set(combo);
      let correct = 0;
      let total = 0;

      for (const record of this.performanceRecords) {
        // Only count records where at least minGroupSize agents from this combo participated
        const participating = record.agentResults.filter((ar) => comboSet.has(ar.agentId));
        if (participating.length < minGroupSize) continue;

        total += 1;

        // Simulate simple majority among this subset
        const sideCount: Record<VoteSide, number> = { buy: 0, sell: 0, hold: 0 };
        for (const ar of participating) {
          sideCount[ar.vote] += 1;
        }
        const subDecision = (Object.entries(sideCount) as [VoteSide, number][])
          .sort((a, b) => b[1] - a[1])[0][0];

        if (subDecision === record.actualOutcome) correct += 1;
      }

      if (total > 0) {
        results.push({
          agents: combo,
          accuracy: Number((correct / total).toFixed(4)),
          sampleSize: total,
        });
      }
    }

    results.sort((a, b) => b.accuracy - a.accuracy || b.sampleSize - a.sampleSize);

    const best = results[0] ?? { agents: agentList, accuracy: 0, sampleSize: 0 };

    return {
      bestCombination: best.agents,
      accuracy: best.accuracy,
      sampleSize: best.sampleSize,
      allCombinations: results.slice(0, 20),
      computedAt: isoNow(),
    };
  }

  /** Get all votes for a given topic. */
  getVotes(topic: string): SwarmVote[] {
    return (this.votes.get(topic) ?? []).map((v) => structuredClone(v));
  }

  /** List all known topics. */
  listTopics(): string[] {
    return [...this.votes.keys()];
  }

  // ─── Private helpers ──────────────────────────────────────────────

  private generateCombinations(items: string[], minSize: number): string[][] {
    const results: string[][] = [];
    const n = items.length;

    // Cap at reasonable size to prevent explosion (max 6 agents = 57 combos)
    const cappedN = Math.min(n, 6);
    const cappedItems = items.slice(0, cappedN);

    for (let size = minSize; size <= cappedN; size++) {
      this.combineHelper(cappedItems, size, 0, [], results);
    }

    return results;
  }

  private combineHelper(
    items: string[],
    size: number,
    start: number,
    current: string[],
    results: string[][],
  ): void {
    if (current.length === size) {
      results.push([...current]);
      return;
    }
    for (let i = start; i < items.length; i++) {
      current.push(items[i]);
      this.combineHelper(items, size, i + 1, current, results);
      current.pop();
    }
  }
}
