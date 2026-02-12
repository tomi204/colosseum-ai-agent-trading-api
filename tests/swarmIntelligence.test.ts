import { describe, expect, it, beforeEach } from 'vitest';
import { SwarmIntelligenceService } from '../src/services/swarmIntelligenceService.js';

describe('SwarmIntelligenceService', () => {
  let service: SwarmIntelligenceService;

  beforeEach(() => {
    service = new SwarmIntelligenceService();
  });

  // ─── Voting ──────────────────────────────────────────────────────────

  it('should submit a vote and return it', () => {
    const vote = service.submitVote({
      topic: 'SOL-trade-1',
      agentId: 'agent-1',
      side: 'buy',
      confidence: 0.8,
    });

    expect(vote.id).toBeDefined();
    expect(vote.topic).toBe('SOL-trade-1');
    expect(vote.agentId).toBe('agent-1');
    expect(vote.side).toBe('buy');
    expect(vote.confidence).toBe(0.8);
    expect(vote.weight).toBe(1);
  });

  it('should prevent duplicate votes from same agent on same topic', () => {
    service.submitVote({ topic: 'topic-1', agentId: 'agent-1', side: 'buy', confidence: 0.7 });

    expect(() =>
      service.submitVote({ topic: 'topic-1', agentId: 'agent-1', side: 'sell', confidence: 0.9 }),
    ).toThrow(/already voted/);
  });

  it('should reject invalid confidence values', () => {
    expect(() =>
      service.submitVote({ topic: 'topic-1', agentId: 'agent-1', side: 'buy', confidence: 1.5 }),
    ).toThrow(/Confidence must be between/);

    expect(() =>
      service.submitVote({ topic: 'topic-1', agentId: 'agent-2', side: 'buy', confidence: -0.1 }),
    ).toThrow(/Confidence must be between/);
  });

  // ─── Consensus ────────────────────────────────────────────────────────

  it('should compute simple majority consensus', () => {
    service.submitVote({ topic: 'trade-1', agentId: 'a1', side: 'buy', confidence: 0.8 });
    service.submitVote({ topic: 'trade-1', agentId: 'a2', side: 'buy', confidence: 0.6 });
    service.submitVote({ topic: 'trade-1', agentId: 'a3', side: 'sell', confidence: 0.9 });

    const consensus = service.getConsensus('trade-1', 'simple_majority');

    expect(consensus.decision).toBe('buy');
    expect(consensus.totalVotes).toBe(3);
    expect(consensus.method).toBe('simple_majority');
    expect(consensus.breakdown.buy.count).toBe(2);
    expect(consensus.breakdown.sell.count).toBe(1);
    expect(consensus.quorumReached).toBe(true);
  });

  it('should compute weighted consensus', () => {
    // Agent with high weight + confidence on sell should override two low-weight buys
    service.submitVote({ topic: 'trade-2', agentId: 'a1', side: 'buy', confidence: 0.5, weight: 1 });
    service.submitVote({ topic: 'trade-2', agentId: 'a2', side: 'buy', confidence: 0.5, weight: 1 });
    service.submitVote({ topic: 'trade-2', agentId: 'a3', side: 'sell', confidence: 0.9, weight: 5 });

    const consensus = service.getConsensus('trade-2', 'weighted');

    // sell weighted score: 0.9 * 5 = 4.5, buy weighted score: 0.5*1 + 0.5*1 = 1.0
    expect(consensus.decision).toBe('sell');
    expect(consensus.method).toBe('weighted');
  });

  it('should compute supermajority consensus and check quorum', () => {
    // 3 buys, 1 sell → buy has 75% of weight (3/4), above 66.7% threshold
    service.submitVote({ topic: 'trade-3', agentId: 'a1', side: 'buy', confidence: 0.8 });
    service.submitVote({ topic: 'trade-3', agentId: 'a2', side: 'buy', confidence: 0.7 });
    service.submitVote({ topic: 'trade-3', agentId: 'a3', side: 'buy', confidence: 0.6 });
    service.submitVote({ topic: 'trade-3', agentId: 'a4', side: 'sell', confidence: 0.9 });

    const consensus = service.getConsensus('trade-3', 'supermajority');

    expect(consensus.decision).toBe('buy');
    expect(consensus.quorumReached).toBe(true);
    expect(consensus.unanimity).toBe(false);
  });

  it('should detect unanimity', () => {
    service.submitVote({ topic: 'trade-4', agentId: 'a1', side: 'sell', confidence: 0.9 });
    service.submitVote({ topic: 'trade-4', agentId: 'a2', side: 'sell', confidence: 0.8 });

    const consensus = service.getConsensus('trade-4');
    expect(consensus.unanimity).toBe(true);
    expect(consensus.decision).toBe('sell');
  });

  it('should throw when no votes exist for topic', () => {
    expect(() => service.getConsensus('nonexistent')).toThrow(/No votes found/);
  });

  // ─── Signal Aggregation ────────────────────────────────────────────

  it('should aggregate signals with confidence weighting', () => {
    const result = service.aggregateSignals([
      { agentId: 'a1', symbol: 'SOL', side: 'buy', confidence: 0.9, weight: 2 },
      { agentId: 'a2', symbol: 'SOL', side: 'buy', confidence: 0.7, weight: 1 },
      { agentId: 'a3', symbol: 'SOL', side: 'sell', confidence: 0.6, weight: 1 },
    ]);

    expect(result.symbol).toBe('SOL');
    expect(result.side).toBe('buy');
    expect(result.signalCount).toBe(3);
    expect(result.aggregatedConfidence).toBeGreaterThan(0);
    // buy score: 0.9*2 + 0.7*1 = 2.5, sell score: 0.6*1 = 0.6, total weight = 4
    // aggregatedConfidence = 2.5/4 = 0.625
    expect(result.aggregatedConfidence).toBeCloseTo(0.625, 3);
  });

  it('should reject empty signals', () => {
    expect(() => service.aggregateSignals([])).toThrow(/At least one signal/);
  });

  it('should reject mixed-symbol signals', () => {
    expect(() =>
      service.aggregateSignals([
        { agentId: 'a1', symbol: 'SOL', side: 'buy', confidence: 0.8 },
        { agentId: 'a2', symbol: 'BONK', side: 'sell', confidence: 0.6 },
      ]),
    ).toThrow(/same symbol/);
  });

  // ─── Performance Tracking ──────────────────────────────────────────

  it('should track performance: swarm vs individual', () => {
    // Topic 1: swarm says buy, actual is buy
    service.submitVote({ topic: 'perf-1', agentId: 'a1', side: 'buy', confidence: 0.8 });
    service.submitVote({ topic: 'perf-1', agentId: 'a2', side: 'buy', confidence: 0.7 });
    service.submitVote({ topic: 'perf-1', agentId: 'a3', side: 'sell', confidence: 0.9 });
    service.recordOutcome('perf-1', 'buy');

    // Topic 2: swarm says sell, actual is sell
    service.submitVote({ topic: 'perf-2', agentId: 'a1', side: 'sell', confidence: 0.8 });
    service.submitVote({ topic: 'perf-2', agentId: 'a2', side: 'sell', confidence: 0.7 });
    service.submitVote({ topic: 'perf-2', agentId: 'a3', side: 'sell', confidence: 0.6 });
    service.recordOutcome('perf-2', 'sell');

    const perf = service.getPerformance();

    expect(perf.totalDecisions).toBe(2);
    expect(perf.swarmAccuracy).toBe(1); // 2/2
    expect(perf.recentRecords).toHaveLength(2);

    // a3 was wrong on perf-1 (voted sell, outcome buy), correct on perf-2
    expect(perf.individualAccuracies['a3'].accuracy).toBe(0.5);
    // a1 was right on both
    expect(perf.individualAccuracies['a1'].accuracy).toBe(1);
    // Swarm outperforms: swarm (1.0) >= a1 (1.0), a2 (1.0), a3 (0.5) → 3/3 = 1.0
    expect(perf.swarmOutperformsPct).toBe(1);
  });

  // ─── Dissent Tracking ──────────────────────────────────────────────

  it('should track dissenting agents', () => {
    // a3 dissents on topic 1, agrees on topic 2
    service.submitVote({ topic: 'dissent-1', agentId: 'a1', side: 'buy', confidence: 0.8 });
    service.submitVote({ topic: 'dissent-1', agentId: 'a2', side: 'buy', confidence: 0.7 });
    service.submitVote({ topic: 'dissent-1', agentId: 'a3', side: 'sell', confidence: 0.9 });

    service.submitVote({ topic: 'dissent-2', agentId: 'a1', side: 'hold', confidence: 0.6 });
    service.submitVote({ topic: 'dissent-2', agentId: 'a2', side: 'hold', confidence: 0.7 });
    service.submitVote({ topic: 'dissent-2', agentId: 'a3', side: 'hold', confidence: 0.5 });

    const dissents = service.getDissent();
    expect(dissents.length).toBeGreaterThanOrEqual(1);

    const a3 = dissents.find((d) => d.agentId === 'a3');
    expect(a3).toBeDefined();
    expect(a3!.dissents).toBe(1);
    expect(a3!.totalVotes).toBe(2);
    expect(a3!.dissentRate).toBe(0.5);
  });

  // ─── Composition Optimizer ──────────────────────────────────────────

  it('should find optimal agent combination', () => {
    // Set up performance data with known outcomes
    service.submitVote({ topic: 'opt-1', agentId: 'a1', side: 'buy', confidence: 0.8 });
    service.submitVote({ topic: 'opt-1', agentId: 'a2', side: 'buy', confidence: 0.7 });
    service.submitVote({ topic: 'opt-1', agentId: 'a3', side: 'sell', confidence: 0.9 });
    service.recordOutcome('opt-1', 'buy');

    service.submitVote({ topic: 'opt-2', agentId: 'a1', side: 'sell', confidence: 0.7 });
    service.submitVote({ topic: 'opt-2', agentId: 'a2', side: 'sell', confidence: 0.8 });
    service.submitVote({ topic: 'opt-2', agentId: 'a3', side: 'buy', confidence: 0.6 });
    service.recordOutcome('opt-2', 'sell');

    const result = service.optimizeComposition(2);

    expect(result.bestCombination).toBeDefined();
    expect(result.bestCombination.length).toBeGreaterThanOrEqual(2);
    expect(result.accuracy).toBeGreaterThanOrEqual(0);
    expect(result.allCombinations.length).toBeGreaterThan(0);
    expect(result.computedAt).toBeDefined();

    // a1+a2 combo should be 100% accurate (both correct on both topics)
    const a1a2 = result.allCombinations.find(
      (c) => c.agents.includes('a1') && c.agents.includes('a2') && c.agents.length === 2,
    );
    expect(a1a2).toBeDefined();
    expect(a1a2!.accuracy).toBe(1);
  });

  it('should throw when no performance records for optimization', () => {
    expect(() => service.optimizeComposition()).toThrow(/No performance records/);
  });
});
