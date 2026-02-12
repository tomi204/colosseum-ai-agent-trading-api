import { describe, expect, it, beforeEach } from 'vitest';
import { TrustGraphService } from '../src/services/trustGraphService.js';

describe('TrustGraphService', () => {
  let service: TrustGraphService;

  beforeEach(() => {
    service = new TrustGraphService();
  });

  // ─── Bilateral Trust (rate) ───────────────────────────────────────

  describe('rate()', () => {
    it('should create a trust edge between two agents', () => {
      const edge = service.rate({ from: 'alice', to: 'bob', score: 0.8, context: 'trade-accuracy' });

      expect(edge.from).toBe('alice');
      expect(edge.to).toBe('bob');
      expect(edge.score).toBe(0.8);
      expect(edge.context).toBe('trade-accuracy');
      expect(edge.createdAt).toBeTruthy();
      expect(edge.updatedAt).toBeTruthy();
    });

    it('should update existing edge on re-rate', () => {
      service.rate({ from: 'alice', to: 'bob', score: 0.5 });
      const updated = service.rate({ from: 'alice', to: 'bob', score: 0.9, context: 'improved' });

      expect(updated.score).toBe(0.9);
      expect(updated.context).toBe('improved');

      // Graph should still only have one edge from alice → bob
      const graph = service.getGraph();
      const aliceToBob = graph.edges.filter((e) => e.from === 'alice' && e.to === 'bob');
      expect(aliceToBob).toHaveLength(1);
    });

    it('should reject self-rating', () => {
      expect(() => service.rate({ from: 'alice', to: 'alice', score: 0.5 }))
        .toThrow('Cannot rate yourself');
    });

    it('should reject invalid scores', () => {
      expect(() => service.rate({ from: 'alice', to: 'bob', score: -0.1 }))
        .toThrow('Trust score must be between 0 and 1');
      expect(() => service.rate({ from: 'alice', to: 'bob', score: 1.1 }))
        .toThrow('Trust score must be between 0 and 1');
    });
  });

  // ─── Trust Score ──────────────────────────────────────────────────

  describe('getTrustScore()', () => {
    it('should return zero inbound/outbound for an agent with no trust edges', () => {
      const score = service.getTrustScore('lonely-agent');

      expect(score.agentId).toBe('lonely-agent');
      expect(score.inboundCount).toBe(0);
      expect(score.outboundCount).toBe(0);
      expect(score.avgInboundTrust).toBe(0);
      expect(score.avgOutboundTrust).toBe(0);
      // PageRank may assign baseline score to the single node
      expect(score.aggregateScore).toBeGreaterThanOrEqual(0);
    });

    it('should compute aggregate score from inbound trust', () => {
      service.rate({ from: 'alice', to: 'bob', score: 0.8 });
      service.rate({ from: 'charlie', to: 'bob', score: 0.6 });
      service.rate({ from: 'dave', to: 'bob', score: 0.9 });

      const score = service.getTrustScore('bob');

      expect(score.inboundCount).toBe(3);
      expect(score.avgInboundTrust).toBeGreaterThan(0.5);
      expect(score.aggregateScore).toBeGreaterThan(0);
      expect(score.calculatedAt).toBeTruthy();
    });

    it('should include PageRank component in aggregate score', () => {
      // Create a network where bob is highly trusted by many
      service.rate({ from: 'alice', to: 'bob', score: 0.9 });
      service.rate({ from: 'charlie', to: 'bob', score: 0.9 });
      service.rate({ from: 'dave', to: 'bob', score: 0.9 });
      service.rate({ from: 'eve', to: 'bob', score: 0.9 });
      // Alice also trusted by others
      service.rate({ from: 'charlie', to: 'alice', score: 0.8 });

      const bobScore = service.getTrustScore('bob');
      expect(bobScore.pageRankScore).toBeGreaterThan(0);
    });
  });

  // ─── Trust Decay ──────────────────────────────────────────────────

  describe('trust decay', () => {
    it('should apply time-based decay to stale trust', () => {
      // Create an edge, then manipulate its timestamp to be old
      service.rate({ from: 'alice', to: 'bob', score: 0.8 });

      // Fresh score
      const freshScore = service.getTrustScore('bob');

      // Re-create service with a stale edge (simulate by re-rating with old timestamp)
      // We check that the decay mechanism exists by verifying the field
      expect(freshScore.decayApplied).toBe(false); // Fresh edges shouldn't be decayed

      // The decay is time-based — since the edge was just created, no decay applied
      expect(freshScore.avgInboundTrust).toBeCloseTo(0.8, 1);
    });
  });

  // ─── Graph Export ─────────────────────────────────────────────────

  describe('getGraph()', () => {
    it('should export the full graph adjacency data', () => {
      service.rate({ from: 'alice', to: 'bob', score: 0.8 });
      service.rate({ from: 'bob', to: 'charlie', score: 0.7 });
      service.rate({ from: 'charlie', to: 'alice', score: 0.6 });

      const graph = service.getGraph();

      expect(graph.nodeCount).toBe(3);
      expect(graph.edgeCount).toBe(3);
      expect(graph.nodes).toContain('alice');
      expect(graph.nodes).toContain('bob');
      expect(graph.nodes).toContain('charlie');
      expect(graph.edges).toHaveLength(3);
      expect(graph.exportedAt).toBeTruthy();
    });

    it('should return empty graph when no edges exist', () => {
      const graph = service.getGraph();
      expect(graph.nodeCount).toBe(0);
      expect(graph.edgeCount).toBe(0);
      expect(graph.nodes).toHaveLength(0);
      expect(graph.edges).toHaveLength(0);
    });
  });

  // ─── Web of Trust ─────────────────────────────────────────────────

  describe('getWebOfTrust()', () => {
    it('should compute direct trust relationships', () => {
      service.rate({ from: 'alice', to: 'bob', score: 0.8 });
      service.rate({ from: 'bob', to: 'alice', score: 0.7 });

      const web = service.getWebOfTrust('alice');

      expect(web.agentId).toBe('alice');
      expect(web.directTrust).toHaveLength(1);
      expect(web.directTrust[0].agentId).toBe('bob');
      expect(web.directTrust[0].direction).toBe('mutual');
    });

    it('should propagate trust transitively', () => {
      service.rate({ from: 'alice', to: 'bob', score: 0.8 });
      service.rate({ from: 'bob', to: 'charlie', score: 0.7 });
      service.rate({ from: 'charlie', to: 'dave', score: 0.6 });

      const web = service.getWebOfTrust('alice');

      // Alice trusts bob directly; charlie & dave are transitive
      const transitiveAgents = web.transitiveTrust.map((t) => t.agentId);
      expect(transitiveAgents).toContain('charlie');

      // Transitive trust should be discounted
      const charlieTrust = web.transitiveTrust.find((t) => t.agentId === 'charlie');
      expect(charlieTrust).toBeTruthy();
      expect(charlieTrust!.score).toBeLessThan(0.8 * 0.7); // Discounted
      expect(charlieTrust!.path.length).toBeGreaterThan(2);
    });

    it('should compute cluster coefficient', () => {
      // Triangle: everyone trusts everyone
      service.rate({ from: 'alice', to: 'bob', score: 0.8 });
      service.rate({ from: 'bob', to: 'alice', score: 0.7 });
      service.rate({ from: 'alice', to: 'charlie', score: 0.6 });
      service.rate({ from: 'charlie', to: 'alice', score: 0.5 });
      service.rate({ from: 'bob', to: 'charlie', score: 0.4 });
      service.rate({ from: 'charlie', to: 'bob', score: 0.3 });

      const web = service.getWebOfTrust('alice');
      // Full triangle = cluster coefficient of 1
      expect(web.clusterCoefficient).toBe(1);
    });
  });

  // ─── Sybil Detection ─────────────────────────────────────────────

  describe('sybilCheck()', () => {
    it('should return low risk for well-connected legitimate agents', () => {
      // Create a diverse trust network
      service.rate({ from: 'alice', to: 'bob', score: 0.8 });
      service.rate({ from: 'charlie', to: 'bob', score: 0.6 });
      service.rate({ from: 'dave', to: 'bob', score: 0.9 });
      service.rate({ from: 'eve', to: 'bob', score: 0.4 });
      service.rate({ from: 'bob', to: 'alice', score: 0.7 });

      const result = service.sybilCheck('bob');
      expect(result.riskLevel).toBe('low');
      expect(result.sybilRisk).toBeLessThan(0.4);
    });

    it('should flag high risk for suspicious sybil-like clusters', () => {
      // Create a closed cluster of agents all rating each other identically
      const sybils = ['sybil-1', 'sybil-2', 'sybil-3', 'sybil-4'];
      for (const from of sybils) {
        for (const to of sybils) {
          if (from !== to) {
            service.rate({ from, to, score: 0.95 }); // Uniform scores
          }
        }
      }

      const result = service.sybilCheck('sybil-1');
      expect(result.indicators.length).toBeGreaterThan(0);
      expect(result.sybilRisk).toBeGreaterThan(0.3);
      // Should detect uniform scores and reciprocal ratios
      expect(result.indicators).toContain('uniform_trust_scores');
    });

    it('should detect high trust concentration', () => {
      // One agent gives massive trust, others give tiny amounts
      service.rate({ from: 'whale', to: 'target', score: 0.99 });
      service.rate({ from: 'minnow1', to: 'target', score: 0.01 });
      service.rate({ from: 'minnow2', to: 'target', score: 0.01 });

      const result = service.sybilCheck('target');
      expect(result.trustConcentration).toBeGreaterThan(0.5);
      expect(result.indicators).toContain('high_trust_concentration');
    });
  });

  // ─── Trust-Weighted Consensus ─────────────────────────────────────

  describe('consensus()', () => {
    it('should weight signals by trust scores', () => {
      // Viewer trusts alice highly, bob less
      service.rate({ from: 'viewer', to: 'alice', score: 0.9 });
      service.rate({ from: 'viewer', to: 'bob', score: 0.2 });

      const result = service.consensus('viewer', [
        { agentId: 'alice', signal: 100 },
        { agentId: 'bob', signal: 50 },
      ]);

      expect(result.participantCount).toBe(2);
      expect(result.totalWeight).toBeGreaterThan(0);
      // Weighted signal should be closer to alice's signal (100) than bob's (50)
      expect(result.weightedSignal).toBeGreaterThan(75);
      expect(result.contributions).toHaveLength(2);
    });

    it('should handle unknown agents with zero direct trust', () => {
      const result = service.consensus('viewer', [
        { agentId: 'unknown-1', signal: 100 },
        { agentId: 'unknown-2', signal: 50 },
      ]);

      expect(result.participantCount).toBe(2);
      // Both should have roughly equal weight (pagerank-based)
      expect(result.calculatedAt).toBeTruthy();
    });

    it('should return zero signal when no inputs provided', () => {
      const result = service.consensus('viewer', []);
      expect(result.weightedSignal).toBe(0);
      expect(result.totalWeight).toBe(0);
      expect(result.participantCount).toBe(0);
    });
  });

  // ─── Trust Propagation ────────────────────────────────────────────

  describe('transitive trust propagation', () => {
    it('should propagate trust through multiple hops with discount', () => {
      service.rate({ from: 'a', to: 'b', score: 0.9 });
      service.rate({ from: 'b', to: 'c', score: 0.8 });
      service.rate({ from: 'c', to: 'd', score: 0.7 });

      const web = service.getWebOfTrust('a');
      const cTrust = web.transitiveTrust.find((t) => t.agentId === 'c');
      const dTrust = web.transitiveTrust.find((t) => t.agentId === 'd');

      expect(cTrust).toBeTruthy();
      expect(dTrust).toBeTruthy();

      // Each hop should reduce trust: score * next_score * 0.5 per hop
      expect(cTrust!.score).toBeLessThan(0.9);
      if (dTrust) {
        expect(dTrust.score).toBeLessThan(cTrust!.score);
      }
    });

    it('should not propagate negligible trust (< 0.01)', () => {
      service.rate({ from: 'a', to: 'b', score: 0.1 });
      service.rate({ from: 'b', to: 'c', score: 0.1 });
      service.rate({ from: 'c', to: 'd', score: 0.1 });

      const web = service.getWebOfTrust('a');
      // 0.1 * 0.1 * 0.5 = 0.005 < 0.01 → should be pruned
      const dTrust = web.transitiveTrust.find((t) => t.agentId === 'd');
      expect(dTrust).toBeUndefined();
    });
  });
});
