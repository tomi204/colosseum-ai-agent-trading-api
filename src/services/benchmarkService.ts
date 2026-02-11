/**
 * Agent Performance Benchmark Service.
 *
 * Benchmarks agent trading performance against multiple criteria:
 * - Execution speed (average intent-to-execution latency)
 * - Risk compliance rate (% of intents passing risk checks)
 * - Strategy accuracy (% of profitable trades)
 * - Drawdown recovery speed (ticks to recover from max drawdown)
 * - Fee efficiency (fees as % of gross profits)
 *
 * Provides individual agent report cards with letter grades and system-wide benchmarks.
 */

import { v4 as uuid } from 'uuid';
import { StateStore } from '../infra/storage/stateStore.js';
import { eventBus } from '../infra/eventBus.js';
import { isoNow } from '../utils/time.js';
import type { Agent, ExecutionRecord, TradeIntent } from '../types.js';

// ─── Types ──────────────────────────────────────────────────────────────

export interface BenchmarkMetrics {
  executionSpeedMs: number;
  riskComplianceRate: number;
  strategyAccuracy: number;
  drawdownRecoveryTicks: number;
  feeEfficiencyPct: number;
}

export type LetterGrade = 'A+' | 'A' | 'B' | 'C' | 'D' | 'F';

export interface GradedMetric {
  value: number;
  grade: LetterGrade;
  systemAvg: number;
  percentile: number;
}

export interface AgentBenchmark {
  id: string;
  agentId: string;
  metrics: BenchmarkMetrics;
  overallGrade: LetterGrade;
  ranAt: string;
}

export interface AgentReport {
  agentId: string;
  agentName: string;
  totalTrades: number;
  totalIntents: number;
  executionSpeed: GradedMetric;
  riskCompliance: GradedMetric;
  strategyAccuracy: GradedMetric;
  drawdownRecovery: GradedMetric;
  feeEfficiency: GradedMetric;
  overallGrade: LetterGrade;
  generatedAt: string;
}

export interface SystemBenchmarks {
  agentCount: number;
  avgExecutionSpeedMs: number;
  avgRiskComplianceRate: number;
  avgStrategyAccuracy: number;
  avgDrawdownRecoveryTicks: number;
  avgFeeEfficiencyPct: number;
  topAgentId: string | null;
  topAgentGrade: LetterGrade | null;
  benchmarks: AgentBenchmark[];
  generatedAt: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────

function assignGrade(value: number, thresholds: { aPlus: number; a: number; b: number; c: number; d: number }, higherIsBetter: boolean): LetterGrade {
  const cmp = higherIsBetter
    ? (v: number, t: number) => v >= t
    : (v: number, t: number) => v <= t;

  if (cmp(value, thresholds.aPlus)) return 'A+';
  if (cmp(value, thresholds.a)) return 'A';
  if (cmp(value, thresholds.b)) return 'B';
  if (cmp(value, thresholds.c)) return 'C';
  if (cmp(value, thresholds.d)) return 'D';
  return 'F';
}

function computePercentile(value: number, allValues: number[], higherIsBetter: boolean): number {
  if (allValues.length === 0) return 100;
  const count = higherIsBetter
    ? allValues.filter((v) => v <= value).length
    : allValues.filter((v) => v >= value).length;
  return Number(((count / allValues.length) * 100).toFixed(1));
}

function gradeToScore(grade: LetterGrade): number {
  switch (grade) {
    case 'A+': return 6;
    case 'A': return 5;
    case 'B': return 4;
    case 'C': return 3;
    case 'D': return 2;
    case 'F': return 1;
  }
}

function scoreToGrade(score: number): LetterGrade {
  if (score >= 5.5) return 'A+';
  if (score >= 4.5) return 'A';
  if (score >= 3.5) return 'B';
  if (score >= 2.5) return 'C';
  if (score >= 1.5) return 'D';
  return 'F';
}

function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

// ─── Service ────────────────────────────────────────────────────────────

export class BenchmarkService {
  private benchmarks: Map<string, AgentBenchmark> = new Map();

  constructor(private readonly store: StateStore) {}

  /**
   * Run a full benchmark for a given agent.
   */
  runBenchmark(agentId: string): AgentBenchmark | null {
    const state = this.store.snapshot();
    const agent = state.agents[agentId];
    if (!agent) return null;

    const intents = Object.values(state.tradeIntents).filter((i) => i.agentId === agentId);
    const executions = Object.values(state.executions).filter((e) => e.agentId === agentId && e.status === 'filled');

    const metrics = this.computeMetrics(agent, intents, executions);
    const overallGrade = this.computeOverallGrade(metrics);

    const benchmark: AgentBenchmark = {
      id: uuid(),
      agentId,
      metrics,
      overallGrade,
      ranAt: isoNow(),
    };

    this.benchmarks.set(agentId, benchmark);

    eventBus.emit('improve.analyzed' as any, {
      type: 'benchmark',
      agentId,
      overallGrade,
      metrics,
    });

    return benchmark;
  }

  /**
   * Get a comprehensive agent report card with grades and system comparison.
   */
  getAgentReport(agentId: string): AgentReport | null {
    const state = this.store.snapshot();
    const agent = state.agents[agentId];
    if (!agent) return null;

    const intents = Object.values(state.tradeIntents).filter((i) => i.agentId === agentId);
    const executions = Object.values(state.executions).filter((e) => e.agentId === agentId && e.status === 'filled');

    const metrics = this.computeMetrics(agent, intents, executions);
    const systemAvgs = this.computeSystemAverages();
    const allMetricsArrays = this.getAllAgentMetricArrays();

    const executionSpeed: GradedMetric = {
      value: metrics.executionSpeedMs,
      grade: assignGrade(metrics.executionSpeedMs, { aPlus: 10, a: 50, b: 200, c: 500, d: 1000 }, false),
      systemAvg: systemAvgs.avgExecutionSpeedMs,
      percentile: computePercentile(metrics.executionSpeedMs, allMetricsArrays.executionSpeeds, false),
    };

    const riskCompliance: GradedMetric = {
      value: metrics.riskComplianceRate,
      grade: assignGrade(metrics.riskComplianceRate, { aPlus: 0.98, a: 0.95, b: 0.85, c: 0.7, d: 0.5 }, true),
      systemAvg: systemAvgs.avgRiskComplianceRate,
      percentile: computePercentile(metrics.riskComplianceRate, allMetricsArrays.riskCompliances, true),
    };

    const strategyAccuracy: GradedMetric = {
      value: metrics.strategyAccuracy,
      grade: assignGrade(metrics.strategyAccuracy, { aPlus: 0.8, a: 0.65, b: 0.55, c: 0.45, d: 0.35 }, true),
      systemAvg: systemAvgs.avgStrategyAccuracy,
      percentile: computePercentile(metrics.strategyAccuracy, allMetricsArrays.strategyAccuracies, true),
    };

    const drawdownRecovery: GradedMetric = {
      value: metrics.drawdownRecoveryTicks,
      grade: assignGrade(metrics.drawdownRecoveryTicks, { aPlus: 2, a: 5, b: 10, c: 20, d: 50 }, false),
      systemAvg: systemAvgs.avgDrawdownRecoveryTicks,
      percentile: computePercentile(metrics.drawdownRecoveryTicks, allMetricsArrays.drawdownRecoveries, false),
    };

    const feeEfficiency: GradedMetric = {
      value: metrics.feeEfficiencyPct,
      grade: assignGrade(metrics.feeEfficiencyPct, { aPlus: 1, a: 3, b: 5, c: 10, d: 20 }, false),
      systemAvg: systemAvgs.avgFeeEfficiencyPct,
      percentile: computePercentile(metrics.feeEfficiencyPct, allMetricsArrays.feeEfficiencies, false),
    };

    const grades = [executionSpeed.grade, riskCompliance.grade, strategyAccuracy.grade, drawdownRecovery.grade, feeEfficiency.grade];
    const avgScore = avg(grades.map(gradeToScore));
    const overallGrade = scoreToGrade(avgScore);

    return {
      agentId,
      agentName: agent.name,
      totalTrades: executions.length,
      totalIntents: intents.length,
      executionSpeed,
      riskCompliance,
      strategyAccuracy,
      drawdownRecovery,
      feeEfficiency,
      overallGrade,
      generatedAt: isoNow(),
    };
  }

  /**
   * Get aggregate benchmarks across all agents.
   */
  getSystemBenchmarks(): SystemBenchmarks {
    const state = this.store.snapshot();
    const agentIds = Object.keys(state.agents);

    // Run benchmarks for all agents
    const benchmarks: AgentBenchmark[] = [];
    for (const agentId of agentIds) {
      const existing = this.benchmarks.get(agentId);
      if (existing) {
        benchmarks.push(existing);
      } else {
        const result = this.runBenchmark(agentId);
        if (result) benchmarks.push(result);
      }
    }

    const systemAvgs = this.computeSystemAverages();

    // Find top agent
    let topAgentId: string | null = null;
    let topScore = 0;
    for (const b of benchmarks) {
      const score = gradeToScore(b.overallGrade);
      if (score > topScore) {
        topScore = score;
        topAgentId = b.agentId;
      }
    }

    return {
      agentCount: benchmarks.length,
      avgExecutionSpeedMs: systemAvgs.avgExecutionSpeedMs,
      avgRiskComplianceRate: systemAvgs.avgRiskComplianceRate,
      avgStrategyAccuracy: systemAvgs.avgStrategyAccuracy,
      avgDrawdownRecoveryTicks: systemAvgs.avgDrawdownRecoveryTicks,
      avgFeeEfficiencyPct: systemAvgs.avgFeeEfficiencyPct,
      topAgentId,
      topAgentGrade: topAgentId ? (benchmarks.find((b) => b.agentId === topAgentId)?.overallGrade ?? null) : null,
      benchmarks,
      generatedAt: isoNow(),
    };
  }

  // ─── Private helpers ──────────────────────────────────────────────────

  private computeMetrics(agent: Agent, intents: TradeIntent[], executions: ExecutionRecord[]): BenchmarkMetrics {
    // 1. Execution speed: average time from intent creation to execution
    const speedMs = this.computeExecutionSpeed(intents, executions);

    // 2. Risk compliance rate: % of intents that were not rejected
    const riskComplianceRate = this.computeRiskComplianceRate(intents);

    // 3. Strategy accuracy: % of closing trades that are profitable
    const strategyAccuracy = this.computeStrategyAccuracy(executions);

    // 4. Drawdown recovery: ticks to recover from max drawdown
    const drawdownRecoveryTicks = this.computeDrawdownRecovery(executions, agent.startingCapitalUsd);

    // 5. Fee efficiency: total fees as % of gross profits
    const feeEfficiencyPct = this.computeFeeEfficiency(executions);

    return {
      executionSpeedMs: Number(speedMs.toFixed(2)),
      riskComplianceRate: Number(riskComplianceRate.toFixed(4)),
      strategyAccuracy: Number(strategyAccuracy.toFixed(4)),
      drawdownRecoveryTicks,
      feeEfficiencyPct: Number(feeEfficiencyPct.toFixed(4)),
    };
  }

  private computeExecutionSpeed(intents: TradeIntent[], executions: ExecutionRecord[]): number {
    if (intents.length === 0 || executions.length === 0) return 0;

    const intentMap = new Map(intents.map((i) => [i.id, i]));
    const latencies: number[] = [];

    for (const ex of executions) {
      const intent = intentMap.get(ex.intentId);
      if (intent) {
        const intentTime = new Date(intent.createdAt).getTime();
        const execTime = new Date(ex.createdAt).getTime();
        const latency = execTime - intentTime;
        if (latency >= 0) latencies.push(latency);
      }
    }

    return latencies.length > 0 ? avg(latencies) : 0;
  }

  private computeRiskComplianceRate(intents: TradeIntent[]): number {
    if (intents.length === 0) return 1;

    const rejected = intents.filter((i) => i.status === 'rejected').length;
    return (intents.length - rejected) / intents.length;
  }

  private computeStrategyAccuracy(executions: ExecutionRecord[]): number {
    const closingTrades = executions.filter((ex) => ex.side === 'sell' && ex.realizedPnlUsd !== 0);
    if (closingTrades.length === 0) return 0;

    const profitable = closingTrades.filter((ex) => ex.realizedPnlUsd > 0).length;
    return profitable / closingTrades.length;
  }

  private computeDrawdownRecovery(executions: ExecutionRecord[], startingCapital: number): number {
    if (executions.length === 0) return 0;

    const sorted = [...executions].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    let cumulativePnl = 0;
    let peak = startingCapital;
    let maxDrawdownStart = -1;
    let maxDrawdownDepth = 0;
    let recoveryTicks = 0;
    let inDrawdown = false;
    let drawdownStartIdx = 0;

    for (let i = 0; i < sorted.length; i++) {
      cumulativePnl += sorted[i].realizedPnlUsd;
      const equity = startingCapital + cumulativePnl;

      if (equity >= peak) {
        if (inDrawdown) {
          const ticks = i - drawdownStartIdx;
          if (maxDrawdownStart === drawdownStartIdx) {
            recoveryTicks = ticks;
          }
          inDrawdown = false;
        }
        peak = equity;
      } else {
        if (!inDrawdown) {
          drawdownStartIdx = i;
          inDrawdown = true;
        }
        const dd = (peak - equity) / peak;
        if (dd > maxDrawdownDepth) {
          maxDrawdownDepth = dd;
          maxDrawdownStart = drawdownStartIdx;
        }
      }
    }

    // If still in max drawdown, count all remaining ticks
    if (inDrawdown && maxDrawdownStart === drawdownStartIdx) {
      recoveryTicks = sorted.length - drawdownStartIdx;
    }

    return recoveryTicks;
  }

  private computeFeeEfficiency(executions: ExecutionRecord[]): number {
    const totalFees = executions.reduce((s, e) => s + e.feeUsd, 0);
    const grossProfits = executions
      .filter((e) => e.realizedPnlUsd > 0)
      .reduce((s, e) => s + e.realizedPnlUsd, 0);

    if (grossProfits === 0) return totalFees > 0 ? 100 : 0;

    return (totalFees / grossProfits) * 100;
  }

  private computeOverallGrade(metrics: BenchmarkMetrics): LetterGrade {
    const grades: LetterGrade[] = [
      assignGrade(metrics.executionSpeedMs, { aPlus: 10, a: 50, b: 200, c: 500, d: 1000 }, false),
      assignGrade(metrics.riskComplianceRate, { aPlus: 0.98, a: 0.95, b: 0.85, c: 0.7, d: 0.5 }, true),
      assignGrade(metrics.strategyAccuracy, { aPlus: 0.8, a: 0.65, b: 0.55, c: 0.45, d: 0.35 }, true),
      assignGrade(metrics.drawdownRecoveryTicks, { aPlus: 2, a: 5, b: 10, c: 20, d: 50 }, false),
      assignGrade(metrics.feeEfficiencyPct, { aPlus: 1, a: 3, b: 5, c: 10, d: 20 }, false),
    ];

    const avgScore = avg(grades.map(gradeToScore));
    return scoreToGrade(avgScore);
  }

  private computeSystemAverages(): {
    avgExecutionSpeedMs: number;
    avgRiskComplianceRate: number;
    avgStrategyAccuracy: number;
    avgDrawdownRecoveryTicks: number;
    avgFeeEfficiencyPct: number;
  } {
    const state = this.store.snapshot();
    const agentIds = Object.keys(state.agents);

    if (agentIds.length === 0) {
      return {
        avgExecutionSpeedMs: 0,
        avgRiskComplianceRate: 1,
        avgStrategyAccuracy: 0,
        avgDrawdownRecoveryTicks: 0,
        avgFeeEfficiencyPct: 0,
      };
    }

    const allMetrics: BenchmarkMetrics[] = [];
    for (const agentId of agentIds) {
      const agent = state.agents[agentId];
      const intents = Object.values(state.tradeIntents).filter((i) => i.agentId === agentId);
      const executions = Object.values(state.executions).filter((e) => e.agentId === agentId && e.status === 'filled');
      allMetrics.push(this.computeMetrics(agent, intents, executions));
    }

    return {
      avgExecutionSpeedMs: Number(avg(allMetrics.map((m) => m.executionSpeedMs)).toFixed(2)),
      avgRiskComplianceRate: Number(avg(allMetrics.map((m) => m.riskComplianceRate)).toFixed(4)),
      avgStrategyAccuracy: Number(avg(allMetrics.map((m) => m.strategyAccuracy)).toFixed(4)),
      avgDrawdownRecoveryTicks: Number(avg(allMetrics.map((m) => m.drawdownRecoveryTicks)).toFixed(2)),
      avgFeeEfficiencyPct: Number(avg(allMetrics.map((m) => m.feeEfficiencyPct)).toFixed(4)),
    };
  }

  private getAllAgentMetricArrays(): {
    executionSpeeds: number[];
    riskCompliances: number[];
    strategyAccuracies: number[];
    drawdownRecoveries: number[];
    feeEfficiencies: number[];
  } {
    const state = this.store.snapshot();
    const agentIds = Object.keys(state.agents);

    const executionSpeeds: number[] = [];
    const riskCompliances: number[] = [];
    const strategyAccuracies: number[] = [];
    const drawdownRecoveries: number[] = [];
    const feeEfficiencies: number[] = [];

    for (const agentId of agentIds) {
      const agent = state.agents[agentId];
      const intents = Object.values(state.tradeIntents).filter((i) => i.agentId === agentId);
      const executions = Object.values(state.executions).filter((e) => e.agentId === agentId && e.status === 'filled');
      const m = this.computeMetrics(agent, intents, executions);
      executionSpeeds.push(m.executionSpeedMs);
      riskCompliances.push(m.riskComplianceRate);
      strategyAccuracies.push(m.strategyAccuracy);
      drawdownRecoveries.push(m.drawdownRecoveryTicks);
      feeEfficiencies.push(m.feeEfficiencyPct);
    }

    return { executionSpeeds, riskCompliances, strategyAccuracies, drawdownRecoveries, feeEfficiencies };
  }
}
