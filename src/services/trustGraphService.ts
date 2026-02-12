/**
 * Agent Reputation Graph — Trust Graph Service
 *
 * A social graph of bilateral trust relationships between agents with:
 * - Trust scoring between agent pairs (bilateral trust)
 * - Trust propagation (transitive trust through the graph)
 * - Sybil resistance (detect fake trust clusters)
 * - Trust decay over time (stale trust loses value)
 * - Web of trust visualization data (graph adjacency export)
 * - Trust-weighted consensus (aggregate signals weighted by trust)
 */

import { isoNow } from '../utils/time.js';

// ─── Types ──────────────────────────────────────────────────────────────

export interface TrustEdge {
  from: string;
  to: string;
  score: number;       // 0–1 bilateral trust score
  context: string;     // e.g. "trade-execution", "signal-accuracy"
  createdAt: string;
  updatedAt: string;
}

export interface TrustNode {
  agentId: string;
  inboundEdges: TrustEdge[];
  outboundEdges: TrustEdge[];
  aggregateScore: number;  // 0–1 aggregate trust score
  sybilRisk: number;       // 0–1 probability of being sybil
}

export interface TrustGraphSnapshot {
  nodes: string[];
  edges: Array<{ from: string; to: string; score: number; context: string; updatedAt: string }>;
  nodeCount: number;
  edgeCount: number;
  exportedAt: string;
}

export interface WebOfTrust {
  agentId: string;
  directTrust: Array<{ agentId: string; score: number; direction: 'inbound' | 'outbound' | 'mutual' }>;
  transitiveTrust: Array<{ agentId: string; score: number; path: string[] }>;
  clusterCoefficient: number;
  depth: number;
  exportedAt: string;
}

export interface SybilCheckResult {
  agentId: string;
  sybilRisk: number;          // 0–1
  riskLevel: 'low' | 'medium' | 'high';
  indicators: string[];
  clusterSize: number;
  reciprocalRatio: number;    // ratio of mutual trust edges
  trustConcentration: number; // HHI of trust sources
  checkedAt: string;
}

export interface ConsensusInput {
  agentId: string;
  signal: number;            // numeric signal value (e.g. price prediction)
}

export interface ConsensusResult {
  weightedSignal: number;
  totalWeight: number;
  participantCount: number;
  contributions: Array<{ agentId: string; signal: number; weight: number; contribution: number }>;
  calculatedAt: string;
}

export interface TrustScoreResult {
  agentId: string;
  aggregateScore: number;
  inboundCount: number;
  outboundCount: number;
  avgInboundTrust: number;
  avgOutboundTrust: number;
  pageRankScore: number;
  decayApplied: boolean;
  calculatedAt: string;
}

export interface RateInput {
  from: string;
  to: string;
  score: number;
  context?: string;
}

// ─── Constants ──────────────────────────────────────────────────────────

/** Trust scores decay by 50% after this many ms without update */
const DECAY_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

/** Maximum transitive trust propagation depth */
const MAX_PROPAGATION_DEPTH = 3;

/** Transitive trust discount factor per hop */
const PROPAGATION_DISCOUNT = 0.5;

/** PageRank damping factor */
const PAGERANK_DAMPING = 0.85;

/** PageRank iterations */
const PAGERANK_ITERATIONS = 20;

/** Sybil detection thresholds */
const SYBIL_HIGH_THRESHOLD = 0.7;
const SYBIL_MEDIUM_THRESHOLD = 0.4;

// ─── Service ────────────────────────────────────────────────────────────

export class TrustGraphService {
  /** Adjacency list: from → [edges] */
  private edges: Map<string, TrustEdge[]> = new Map();
  /** All known node IDs */
  private nodes: Set<string> = new Set();

  /**
   * Rate another agent — creates or updates a trust edge.
   */
  rate(input: RateInput): TrustEdge {
    const { from, to, score, context = 'general' } = input;

    if (from === to) throw new Error('Cannot rate yourself');
    if (score < 0 || score > 1) throw new Error('Trust score must be between 0 and 1');

    this.nodes.add(from);
    this.nodes.add(to);

    const existing = this.getEdge(from, to);
    const now = isoNow();

    if (existing) {
      existing.score = score;
      existing.context = context;
      existing.updatedAt = now;
      return { ...existing };
    }

    const edge: TrustEdge = {
      from,
      to,
      score,
      context,
      createdAt: now,
      updatedAt: now,
    };

    const fromEdges = this.edges.get(from) ?? [];
    fromEdges.push(edge);
    this.edges.set(from, fromEdges);

    return { ...edge };
  }

  /**
   * Get trust score summary for an agent.
   */
  getTrustScore(agentId: string): TrustScoreResult {
    this.nodes.add(agentId); // ensure node exists for query

    const inbound = this.getInboundEdges(agentId);
    const outbound = this.getOutboundEdges(agentId);
    const now = Date.now();

    // Apply decay to inbound edges for scoring
    const decayedInbound = inbound.map((e) => ({
      ...e,
      effectiveScore: this.applyDecay(e.score, e.updatedAt, now),
    }));

    const hasDecay = decayedInbound.some((e) => e.effectiveScore < e.score);

    const avgInbound = decayedInbound.length > 0
      ? decayedInbound.reduce((sum, e) => sum + e.effectiveScore, 0) / decayedInbound.length
      : 0;

    const avgOutbound = outbound.length > 0
      ? outbound.reduce((sum, e) => sum + e.score, 0) / outbound.length
      : 0;

    // Compute PageRank for this node
    const pageRanks = this.computePageRank();
    const pageRankScore = pageRanks.get(agentId) ?? 0;

    // Aggregate: 60% inbound average, 40% PageRank
    const aggregateScore = Number(((avgInbound * 0.6) + (pageRankScore * 0.4)).toFixed(4));

    return {
      agentId,
      aggregateScore,
      inboundCount: inbound.length,
      outboundCount: outbound.length,
      avgInboundTrust: Number(avgInbound.toFixed(4)),
      avgOutboundTrust: Number(avgOutbound.toFixed(4)),
      pageRankScore: Number(pageRankScore.toFixed(4)),
      decayApplied: hasDecay,
      calculatedAt: isoNow(),
    };
  }

  /**
   * Get full trust graph snapshot for visualization.
   */
  getGraph(): TrustGraphSnapshot {
    const allEdges: TrustGraphSnapshot['edges'] = [];

    for (const [, edgeList] of this.edges) {
      for (const e of edgeList) {
        allEdges.push({
          from: e.from,
          to: e.to,
          score: e.score,
          context: e.context,
          updatedAt: e.updatedAt,
        });
      }
    }

    return {
      nodes: Array.from(this.nodes),
      edges: allEdges,
      nodeCount: this.nodes.size,
      edgeCount: allEdges.length,
      exportedAt: isoNow(),
    };
  }

  /**
   * Compute web of trust for an agent — direct + transitive trust.
   */
  getWebOfTrust(agentId: string, maxDepth = MAX_PROPAGATION_DEPTH): WebOfTrust {
    const inbound = this.getInboundEdges(agentId);
    const outbound = this.getOutboundEdges(agentId);

    // Direct trust
    const directMap = new Map<string, { score: number; direction: 'inbound' | 'outbound' | 'mutual' }>();

    for (const e of inbound) {
      directMap.set(e.from, { score: e.score, direction: 'inbound' });
    }

    for (const e of outbound) {
      const existing = directMap.get(e.to);
      if (existing) {
        directMap.set(e.to, { score: (existing.score + e.score) / 2, direction: 'mutual' });
      } else {
        directMap.set(e.to, { score: e.score, direction: 'outbound' });
      }
    }

    const directTrust = Array.from(directMap.entries()).map(([id, data]) => ({
      agentId: id,
      ...data,
    }));

    // Transitive trust (BFS from agentId)
    const transitiveTrust = this.computeTransitiveTrust(agentId, maxDepth);

    // Cluster coefficient
    const clusterCoefficient = this.computeClusterCoefficient(agentId);

    return {
      agentId,
      directTrust,
      transitiveTrust,
      clusterCoefficient: Number(clusterCoefficient.toFixed(4)),
      depth: maxDepth,
      exportedAt: isoNow(),
    };
  }

  /**
   * Sybil resistance check for an agent.
   * Looks for indicators of fake trust clusters.
   */
  sybilCheck(agentId: string): SybilCheckResult {
    const indicators: string[] = [];
    let sybilScore = 0;

    const inbound = this.getInboundEdges(agentId);
    const outbound = this.getOutboundEdges(agentId);

    // 1. Reciprocal ratio — high reciprocation in a small cluster is suspicious
    const inboundSet = new Set(inbound.map((e) => e.from));
    const outboundSet = new Set(outbound.map((e) => e.to));
    const mutual = [...inboundSet].filter((id) => outboundSet.has(id));
    const reciprocalRatio = inboundSet.size > 0
      ? mutual.length / inboundSet.size
      : 0;

    if (reciprocalRatio > 0.8 && inbound.length >= 3) {
      sybilScore += 0.3;
      indicators.push('high_reciprocal_ratio');
    }

    // 2. Trust concentration (HHI) — if trust comes from few sources
    const trustConcentration = this.computeHHI(inbound.map((e) => e.score));
    if (trustConcentration > 0.5 && inbound.length >= 2) {
      sybilScore += 0.25;
      indicators.push('high_trust_concentration');
    }

    // 3. Closed cluster detection — small isolated cliques
    const clusterSize = this.getClusterSize(agentId);
    if (clusterSize <= 4 && clusterSize >= 2 && reciprocalRatio > 0.7) {
      sybilScore += 0.25;
      indicators.push('small_closed_cluster');
    }

    // 4. Uniform trust scores — real trust is varied; sybils often give identical scores
    const inboundScores = inbound.map((e) => e.score);
    if (inboundScores.length >= 3) {
      const variance = this.computeVariance(inboundScores);
      if (variance < 0.01) {
        sybilScore += 0.2;
        indicators.push('uniform_trust_scores');
      }
    }

    // 5. No outbound trust — agents only receiving but never giving trust
    if (inbound.length >= 3 && outbound.length === 0) {
      sybilScore += 0.1;
      indicators.push('no_outbound_trust');
    }

    sybilScore = Math.min(sybilScore, 1);

    const riskLevel = sybilScore >= SYBIL_HIGH_THRESHOLD
      ? 'high'
      : sybilScore >= SYBIL_MEDIUM_THRESHOLD
        ? 'medium'
        : 'low';

    return {
      agentId,
      sybilRisk: Number(sybilScore.toFixed(4)),
      riskLevel,
      indicators,
      clusterSize,
      reciprocalRatio: Number(reciprocalRatio.toFixed(4)),
      trustConcentration: Number(trustConcentration.toFixed(4)),
      checkedAt: isoNow(),
    };
  }

  /**
   * Trust-weighted consensus — aggregate signals weighted by trust.
   * The viewerAgentId determines whose trust network is used for weighting.
   */
  consensus(viewerAgentId: string, inputs: ConsensusInput[]): ConsensusResult {
    const pageRanks = this.computePageRank();

    const contributions = inputs.map((input) => {
      // Weight = viewer's direct trust of the signal source, or pagerank as fallback
      const directEdge = this.getEdge(viewerAgentId, input.agentId);
      const now = Date.now();
      const directTrust = directEdge
        ? this.applyDecay(directEdge.score, directEdge.updatedAt, now)
        : 0;
      const pageRank = pageRanks.get(input.agentId) ?? 0;

      // Blend: 70% direct trust, 30% pagerank (if no direct trust, use pagerank)
      const weight = directTrust > 0
        ? Number(((directTrust * 0.7) + (pageRank * 0.3)).toFixed(4))
        : Number(pageRank.toFixed(4));

      return {
        agentId: input.agentId,
        signal: input.signal,
        weight,
        contribution: Number((input.signal * weight).toFixed(6)),
      };
    });

    const totalWeight = contributions.reduce((sum, c) => sum + c.weight, 0);
    const weightedSignal = totalWeight > 0
      ? Number((contributions.reduce((sum, c) => sum + c.contribution, 0) / totalWeight).toFixed(6))
      : 0;

    return {
      weightedSignal,
      totalWeight: Number(totalWeight.toFixed(4)),
      participantCount: inputs.length,
      contributions,
      calculatedAt: isoNow(),
    };
  }

  // ─── Internal helpers ─────────────────────────────────────────────────

  private getEdge(from: string, to: string): TrustEdge | undefined {
    const edges = this.edges.get(from) ?? [];
    return edges.find((e) => e.to === to);
  }

  private getInboundEdges(agentId: string): TrustEdge[] {
    const result: TrustEdge[] = [];
    for (const [, edgeList] of this.edges) {
      for (const e of edgeList) {
        if (e.to === agentId) result.push(e);
      }
    }
    return result;
  }

  private getOutboundEdges(agentId: string): TrustEdge[] {
    return this.edges.get(agentId) ?? [];
  }

  private applyDecay(score: number, updatedAt: string, nowMs: number): number {
    const elapsedMs = nowMs - new Date(updatedAt).getTime();
    if (elapsedMs <= 0) return score;
    const decayFactor = Math.pow(0.5, elapsedMs / DECAY_HALF_LIFE_MS);
    return Number((score * decayFactor).toFixed(4));
  }

  private computePageRank(): Map<string, number> {
    const nodeList = Array.from(this.nodes);
    const n = nodeList.length;
    if (n === 0) return new Map();

    const ranks = new Map<string, number>();
    const initial = 1 / n;
    for (const node of nodeList) {
      ranks.set(node, initial);
    }

    for (let iter = 0; iter < PAGERANK_ITERATIONS; iter++) {
      const newRanks = new Map<string, number>();
      for (const node of nodeList) {
        newRanks.set(node, (1 - PAGERANK_DAMPING) / n);
      }

      for (const node of nodeList) {
        const outEdges = this.getOutboundEdges(node);
        if (outEdges.length === 0) {
          // Distribute rank evenly to all nodes (dangling node)
          const share = (ranks.get(node) ?? 0) / n;
          for (const target of nodeList) {
            newRanks.set(target, (newRanks.get(target) ?? 0) + PAGERANK_DAMPING * share);
          }
        } else {
          const totalWeight = outEdges.reduce((sum, e) => sum + e.score, 0);
          if (totalWeight > 0) {
            for (const edge of outEdges) {
              const share = (ranks.get(node) ?? 0) * (edge.score / totalWeight);
              newRanks.set(edge.to, (newRanks.get(edge.to) ?? 0) + PAGERANK_DAMPING * share);
            }
          }
        }
      }

      for (const node of nodeList) {
        ranks.set(node, newRanks.get(node) ?? 0);
      }
    }

    // Normalize to 0–1 range
    const maxRank = Math.max(...Array.from(ranks.values()), 0.0001);
    for (const [node, rank] of ranks) {
      ranks.set(node, rank / maxRank);
    }

    return ranks;
  }

  private computeTransitiveTrust(
    agentId: string,
    maxDepth: number,
  ): Array<{ agentId: string; score: number; path: string[] }> {
    const visited = new Set<string>([agentId]);
    const result: Array<{ agentId: string; score: number; path: string[] }> = [];

    // BFS with score propagation
    interface QueueItem {
      nodeId: string;
      score: number;
      path: string[];
      depth: number;
    }

    const queue: QueueItem[] = [];

    // Seed with direct outbound trust
    const outbound = this.getOutboundEdges(agentId);
    for (const edge of outbound) {
      visited.add(edge.to);
      queue.push({ nodeId: edge.to, score: edge.score, path: [agentId, edge.to], depth: 1 });
    }

    while (queue.length > 0) {
      const item = queue.shift()!;
      if (item.depth >= maxDepth) continue;

      const nextEdges = this.getOutboundEdges(item.nodeId);
      for (const edge of nextEdges) {
        if (visited.has(edge.to)) continue;
        visited.add(edge.to);

        const propagatedScore = Number((item.score * edge.score * PROPAGATION_DISCOUNT).toFixed(4));
        if (propagatedScore < 0.01) continue; // Prune negligible trust

        const path = [...item.path, edge.to];
        result.push({ agentId: edge.to, score: propagatedScore, path });
        queue.push({ nodeId: edge.to, score: propagatedScore, path, depth: item.depth + 1 });
      }
    }

    return result;
  }

  private computeClusterCoefficient(agentId: string): number {
    // Get all neighbors (both inbound and outbound)
    const neighbors = new Set<string>();
    for (const e of this.getInboundEdges(agentId)) neighbors.add(e.from);
    for (const e of this.getOutboundEdges(agentId)) neighbors.add(e.to);

    const neighborList = Array.from(neighbors);
    const k = neighborList.length;
    if (k < 2) return 0;

    // Count edges between neighbors
    let connections = 0;
    for (let i = 0; i < k; i++) {
      for (let j = i + 1; j < k; j++) {
        const hasEdge =
          this.getEdge(neighborList[i], neighborList[j]) !== undefined ||
          this.getEdge(neighborList[j], neighborList[i]) !== undefined;
        if (hasEdge) connections++;
      }
    }

    // Max possible edges: k*(k-1)/2
    return connections / (k * (k - 1) / 2);
  }

  private getClusterSize(agentId: string): number {
    // BFS to find connected component size
    const visited = new Set<string>();
    const queue = [agentId];
    visited.add(agentId);

    while (queue.length > 0) {
      const node = queue.shift()!;
      for (const e of this.getOutboundEdges(node)) {
        if (!visited.has(e.to)) {
          visited.add(e.to);
          queue.push(e.to);
        }
      }
      for (const e of this.getInboundEdges(node)) {
        if (!visited.has(e.from)) {
          visited.add(e.from);
          queue.push(e.from);
        }
      }
    }

    return visited.size;
  }

  private computeHHI(values: number[]): number {
    if (values.length === 0) return 0;
    const total = values.reduce((sum, v) => sum + v, 0);
    if (total === 0) return 0;
    return values.reduce((hhi, v) => hhi + Math.pow(v / total, 2), 0);
  }

  private computeVariance(values: number[]): number {
    if (values.length < 2) return 0;
    const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
    return values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / (values.length - 1);
  }
}
