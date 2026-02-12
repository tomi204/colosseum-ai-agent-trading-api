/**
 * DeFi Protocol Aggregator Service
 *
 * Unified interface to multiple DeFi protocols on Solana:
 *
 *   - Protocol registry (Raydium, Orca, Marinade, Jupiter, Drift, Kamino)
 *   - Unified swap interface (route through best protocol)
 *   - Protocol TVL tracking and comparison
 *   - Protocol health scoring (TVL, audit status, incident history)
 *   - Cross-protocol yield comparison
 *   - Protocol risk alerts (TVL drops, depegs, exploits)
 */

import { isoNow } from '../utils/time.js';

// ─── Types ──────────────────────────────────────────────────────────────

export type ProtocolCategory = 'dex' | 'liquid-staking' | 'lending' | 'perpetuals' | 'aggregator';
export type AuditStatus = 'fully-audited' | 'partially-audited' | 'unaudited';
export type AlertSeverity = 'info' | 'warning' | 'critical';
export type AlertType = 'tvl-drop' | 'depeg' | 'exploit' | 'governance-risk' | 'smart-contract-risk';

export interface ProtocolIncident {
  id: string;
  date: string;
  severity: AlertSeverity;
  title: string;
  description: string;
  lossUsd: number;
  resolved: boolean;
}

export interface ProtocolYieldPool {
  poolId: string;
  name: string;
  tokenA: string;
  tokenB: string | null;
  apy: number;
  tvlUsd: number;
  riskTier: 'low' | 'medium' | 'high';
}

export interface ProtocolInfo {
  id: string;
  name: string;
  category: ProtocolCategory;
  chain: string;
  website: string;
  tvlUsd: number;
  tvlChange24hPct: number;
  auditStatus: AuditStatus;
  auditors: string[];
  launchDate: string;
  ageMonths: number;
  incidents: ProtocolIncident[];
  yieldPools: ProtocolYieldPool[];
  supportedTokens: string[];
  swapFeeRate: number;       // e.g. 0.003 = 0.3%
  healthScore: number;       // 0-100
  riskGrade: string;         // A, B, C, D, F
  lastUpdated: string;
}

export interface SwapQuote {
  protocol: string;
  inputToken: string;
  outputToken: string;
  inputAmount: number;
  outputAmount: number;
  priceImpactPct: number;
  feeUsd: number;
  estimatedSlippagePct: number;
  route: string[];
}

export interface UnifiedSwapRequest {
  inputToken: string;
  outputToken: string;
  amountUsd: number;
  maxSlippagePct?: number;
  preferredProtocol?: string;
}

export interface UnifiedSwapResult {
  bestQuote: SwapQuote;
  allQuotes: SwapQuote[];
  selectedProtocol: string;
  savings: {
    vsWorstQuoteUsd: number;
    vsAverageUsd: number;
  };
  executedAt: string;
}

export interface ProtocolComparison {
  protocols: Array<{
    id: string;
    name: string;
    category: ProtocolCategory;
    tvlUsd: number;
    healthScore: number;
    riskGrade: string;
    auditStatus: AuditStatus;
    incidentCount: number;
    totalLossUsd: number;
    avgYieldApy: number;
    swapFeeRate: number;
  }>;
  rankedBy: string;
  comparedAt: string;
}

export interface TvlRanking {
  rankings: Array<{
    rank: number;
    protocolId: string;
    name: string;
    tvlUsd: number;
    tvlChange24hPct: number;
    marketSharePct: number;
  }>;
  totalTvlUsd: number;
  asOf: string;
}

export interface ProtocolAlert {
  id: string;
  protocolId: string;
  protocolName: string;
  type: AlertType;
  severity: AlertSeverity;
  title: string;
  description: string;
  detectedAt: string;
  resolved: boolean;
  resolvedAt: string | null;
  metadata: Record<string, unknown>;
}

// ─── Service ────────────────────────────────────────────────────────────

export class ProtocolAggregatorService {
  private protocols: Map<string, ProtocolInfo> = new Map();
  private alerts: ProtocolAlert[] = [];
  private alertIdCounter = 0;

  constructor() {
    this.seedProtocols();
    this.generateAlerts();
  }

  // ── Protocol Registry ───────────────────────────────────────────────

  listProtocols(): ProtocolInfo[] {
    return Array.from(this.protocols.values());
  }

  getProtocol(id: string): ProtocolInfo | null {
    return this.protocols.get(id) ?? null;
  }

  getProtocolWithHealth(id: string): (ProtocolInfo & { healthBreakdown: Record<string, number> }) | null {
    const protocol = this.protocols.get(id);
    if (!protocol) return null;

    return {
      ...protocol,
      healthBreakdown: this.computeHealthBreakdown(protocol),
    };
  }

  // ── TVL Tracking ────────────────────────────────────────────────────

  getTvlRankings(): TvlRanking {
    const protocols = this.listProtocols();
    const totalTvl = protocols.reduce((sum, p) => sum + p.tvlUsd, 0);

    const sorted = [...protocols].sort((a, b) => b.tvlUsd - a.tvlUsd);

    return {
      rankings: sorted.map((p, idx) => ({
        rank: idx + 1,
        protocolId: p.id,
        name: p.name,
        tvlUsd: p.tvlUsd,
        tvlChange24hPct: p.tvlChange24hPct,
        marketSharePct: totalTvl > 0 ? Number(((p.tvlUsd / totalTvl) * 100).toFixed(2)) : 0,
      })),
      totalTvlUsd: totalTvl,
      asOf: isoNow(),
    };
  }

  // ── Protocol Comparison ─────────────────────────────────────────────

  compareProtocols(protocolIds?: string[], sortBy: string = 'healthScore'): ProtocolComparison {
    let protocols = this.listProtocols();

    if (protocolIds && protocolIds.length > 0) {
      protocols = protocols.filter((p) => protocolIds.includes(p.id));
    }

    const compared = protocols.map((p) => {
      const totalLoss = p.incidents.reduce((sum, inc) => sum + inc.lossUsd, 0);
      const avgYield = p.yieldPools.length > 0
        ? p.yieldPools.reduce((sum, pool) => sum + pool.apy, 0) / p.yieldPools.length
        : 0;

      return {
        id: p.id,
        name: p.name,
        category: p.category,
        tvlUsd: p.tvlUsd,
        healthScore: p.healthScore,
        riskGrade: p.riskGrade,
        auditStatus: p.auditStatus,
        incidentCount: p.incidents.length,
        totalLossUsd: totalLoss,
        avgYieldApy: Number(avgYield.toFixed(2)),
        swapFeeRate: p.swapFeeRate,
      };
    });

    // Sort
    compared.sort((a, b) => {
      switch (sortBy) {
        case 'tvl': return b.tvlUsd - a.tvlUsd;
        case 'yield': return b.avgYieldApy - a.avgYieldApy;
        case 'risk': return a.healthScore - b.healthScore;
        default: return b.healthScore - a.healthScore;
      }
    });

    return {
      protocols: compared,
      rankedBy: sortBy,
      comparedAt: isoNow(),
    };
  }

  // ── Unified Swap ────────────────────────────────────────────────────

  executeSwap(request: UnifiedSwapRequest): UnifiedSwapResult {
    const maxSlippage = request.maxSlippagePct ?? 1.0;

    // Generate quotes from all DEX/aggregator protocols
    const swapProtocols = this.listProtocols().filter(
      (p) => p.category === 'dex' || p.category === 'aggregator',
    );

    if (swapProtocols.length === 0) {
      throw new Error('No swap-capable protocols available');
    }

    const quotes: SwapQuote[] = swapProtocols.map((protocol) => {
      // Simulate quote generation with randomized competitive pricing
      const baseFee = protocol.swapFeeRate * request.amountUsd;
      const priceImpact = this.estimatePriceImpact(request.amountUsd, protocol.tvlUsd);
      const slippage = Math.min(priceImpact * 0.5, maxSlippage);
      const outputAmount = request.amountUsd - baseFee - (request.amountUsd * priceImpact / 100);

      return {
        protocol: protocol.id,
        inputToken: request.inputToken,
        outputToken: request.outputToken,
        inputAmount: request.amountUsd,
        outputAmount: Number(outputAmount.toFixed(6)),
        priceImpactPct: Number(priceImpact.toFixed(4)),
        feeUsd: Number(baseFee.toFixed(6)),
        estimatedSlippagePct: Number(slippage.toFixed(4)),
        route: [request.inputToken, request.outputToken],
      };
    });

    // Filter by preferred protocol if specified
    let validQuotes = quotes.filter((q) => q.estimatedSlippagePct <= maxSlippage);
    if (validQuotes.length === 0) validQuotes = quotes; // fall back to all

    if (request.preferredProtocol) {
      const preferred = validQuotes.find((q) => q.protocol === request.preferredProtocol);
      if (preferred) {
        const avgOutput = validQuotes.reduce((s, q) => s + q.outputAmount, 0) / validQuotes.length;
        const worstOutput = Math.min(...validQuotes.map((q) => q.outputAmount));
        return {
          bestQuote: preferred,
          allQuotes: quotes,
          selectedProtocol: preferred.protocol,
          savings: {
            vsWorstQuoteUsd: Number((preferred.outputAmount - worstOutput).toFixed(6)),
            vsAverageUsd: Number((preferred.outputAmount - avgOutput).toFixed(6)),
          },
          executedAt: isoNow(),
        };
      }
    }

    // Sort by best output
    validQuotes.sort((a, b) => b.outputAmount - a.outputAmount);
    const best = validQuotes[0];
    const avgOutput = quotes.reduce((s, q) => s + q.outputAmount, 0) / quotes.length;
    const worstOutput = Math.min(...quotes.map((q) => q.outputAmount));

    return {
      bestQuote: best,
      allQuotes: quotes,
      selectedProtocol: best.protocol,
      savings: {
        vsWorstQuoteUsd: Number((best.outputAmount - worstOutput).toFixed(6)),
        vsAverageUsd: Number((best.outputAmount - avgOutput).toFixed(6)),
      },
      executedAt: isoNow(),
    };
  }

  // ── Yield Comparison ────────────────────────────────────────────────

  compareYields(token?: string): Array<{
    protocolId: string;
    protocolName: string;
    pools: ProtocolYieldPool[];
    avgApy: number;
    bestApy: number;
    poolCount: number;
  }> {
    const protocols = this.listProtocols();
    const results: Array<{
      protocolId: string;
      protocolName: string;
      pools: ProtocolYieldPool[];
      avgApy: number;
      bestApy: number;
      poolCount: number;
    }> = [];

    for (const protocol of protocols) {
      let pools = protocol.yieldPools;
      if (token) {
        pools = pools.filter((p) => p.tokenA === token || p.tokenB === token);
      }
      if (pools.length === 0) continue;

      const avgApy = pools.reduce((sum, p) => sum + p.apy, 0) / pools.length;
      const bestApy = Math.max(...pools.map((p) => p.apy));

      results.push({
        protocolId: protocol.id,
        protocolName: protocol.name,
        pools,
        avgApy: Number(avgApy.toFixed(2)),
        bestApy: Number(bestApy.toFixed(2)),
        poolCount: pools.length,
      });
    }

    results.sort((a, b) => b.bestApy - a.bestApy);
    return results;
  }

  // ── Risk Alerts ─────────────────────────────────────────────────────

  getAlerts(opts?: {
    severity?: AlertSeverity;
    protocolId?: string;
    resolved?: boolean;
  }): ProtocolAlert[] {
    let filtered = [...this.alerts];

    if (opts?.severity) {
      filtered = filtered.filter((a) => a.severity === opts.severity);
    }
    if (opts?.protocolId) {
      filtered = filtered.filter((a) => a.protocolId === opts.protocolId);
    }
    if (opts?.resolved !== undefined) {
      filtered = filtered.filter((a) => a.resolved === opts.resolved);
    }

    return filtered.sort((a, b) => b.detectedAt.localeCompare(a.detectedAt));
  }

  addAlert(alert: Omit<ProtocolAlert, 'id'>): ProtocolAlert {
    this.alertIdCounter += 1;
    const newAlert: ProtocolAlert = {
      ...alert,
      id: `pa-alert-${this.alertIdCounter}`,
    };
    this.alerts.push(newAlert);
    return newAlert;
  }

  // ── Health Scoring ──────────────────────────────────────────────────

  private computeHealthBreakdown(protocol: ProtocolInfo): Record<string, number> {
    const tvlScore = Math.min(100, (protocol.tvlUsd / 5_000_000_000) * 100);
    const auditScore = protocol.auditStatus === 'fully-audited' ? 100
      : protocol.auditStatus === 'partially-audited' ? 60 : 20;
    const ageScore = Math.min(100, (protocol.ageMonths / 36) * 100);
    const incidentPenalty = Math.min(50, protocol.incidents.length * 15);
    const incidentScore = Math.max(0, 100 - incidentPenalty);
    const tvlChangeScore = protocol.tvlChange24hPct >= 0
      ? Math.min(100, 70 + protocol.tvlChange24hPct * 3)
      : Math.max(0, 70 + protocol.tvlChange24hPct * 5);

    return {
      tvlScore: Number(tvlScore.toFixed(1)),
      auditScore,
      ageScore: Number(ageScore.toFixed(1)),
      incidentScore,
      stabilityScore: Number(tvlChangeScore.toFixed(1)),
    };
  }

  computeHealthScore(protocol: ProtocolInfo): number {
    const breakdown = this.computeHealthBreakdown(protocol);
    const weighted =
      breakdown.tvlScore * 0.25 +
      breakdown.auditScore * 0.25 +
      breakdown.ageScore * 0.15 +
      breakdown.incidentScore * 0.20 +
      breakdown.stabilityScore * 0.15;

    return Number(Math.min(100, Math.max(0, weighted)).toFixed(1));
  }

  private riskGradeFromScore(score: number): string {
    if (score >= 85) return 'A';
    if (score >= 70) return 'B';
    if (score >= 55) return 'C';
    if (score >= 40) return 'D';
    return 'F';
  }

  // ── Price Impact Estimation ─────────────────────────────────────────

  private estimatePriceImpact(amountUsd: number, poolTvlUsd: number): number {
    if (poolTvlUsd <= 0) return 10;
    // Simplified constant-product AMM impact approximation
    const ratio = amountUsd / poolTvlUsd;
    return Number((ratio * 100).toFixed(4));
  }

  // ── Seed Data ───────────────────────────────────────────────────────

  private seedProtocols(): void {
    const protocolData: Array<Omit<ProtocolInfo, 'healthScore' | 'riskGrade' | 'lastUpdated'>> = [
      {
        id: 'raydium',
        name: 'Raydium',
        category: 'dex',
        chain: 'solana',
        website: 'https://raydium.io',
        tvlUsd: 850_000_000,
        tvlChange24hPct: 1.2,
        auditStatus: 'fully-audited',
        auditors: ['Kudelski Security', 'MadShield'],
        launchDate: '2021-02-21',
        ageMonths: 48,
        incidents: [],
        yieldPools: [
          { poolId: 'ray-sol-usdc', name: 'SOL-USDC', tokenA: 'SOL', tokenB: 'USDC', apy: 18.5, tvlUsd: 120_000_000, riskTier: 'low' },
          { poolId: 'ray-ray-usdc', name: 'RAY-USDC', tokenA: 'RAY', tokenB: 'USDC', apy: 32.1, tvlUsd: 45_000_000, riskTier: 'medium' },
        ],
        supportedTokens: ['SOL', 'USDC', 'USDT', 'RAY', 'mSOL', 'ETH'],
        swapFeeRate: 0.0025,
      },
      {
        id: 'orca',
        name: 'Orca',
        category: 'dex',
        chain: 'solana',
        website: 'https://orca.so',
        tvlUsd: 520_000_000,
        tvlChange24hPct: -0.8,
        auditStatus: 'fully-audited',
        auditors: ['Neodyme', 'Kudelski Security'],
        launchDate: '2021-02-15',
        ageMonths: 48,
        incidents: [],
        yieldPools: [
          { poolId: 'orca-sol-usdc', name: 'SOL-USDC Whirlpool', tokenA: 'SOL', tokenB: 'USDC', apy: 22.3, tvlUsd: 80_000_000, riskTier: 'low' },
          { poolId: 'orca-msol-sol', name: 'mSOL-SOL', tokenA: 'mSOL', tokenB: 'SOL', apy: 7.8, tvlUsd: 35_000_000, riskTier: 'low' },
        ],
        supportedTokens: ['SOL', 'USDC', 'USDT', 'mSOL', 'ETH', 'ORCA'],
        swapFeeRate: 0.003,
      },
      {
        id: 'marinade',
        name: 'Marinade Finance',
        category: 'liquid-staking',
        chain: 'solana',
        website: 'https://marinade.finance',
        tvlUsd: 1_200_000_000,
        tvlChange24hPct: 0.5,
        auditStatus: 'fully-audited',
        auditors: ['Neodyme', 'Ackee Blockchain'],
        launchDate: '2021-08-01',
        ageMonths: 42,
        incidents: [],
        yieldPools: [
          { poolId: 'mnde-msol-staking', name: 'mSOL Staking', tokenA: 'SOL', tokenB: null, apy: 7.2, tvlUsd: 900_000_000, riskTier: 'low' },
          { poolId: 'mnde-native', name: 'Native Staking', tokenA: 'SOL', tokenB: null, apy: 6.8, tvlUsd: 300_000_000, riskTier: 'low' },
        ],
        supportedTokens: ['SOL', 'mSOL', 'MNDE'],
        swapFeeRate: 0.001,
      },
      {
        id: 'jupiter',
        name: 'Jupiter',
        category: 'aggregator',
        chain: 'solana',
        website: 'https://jup.ag',
        tvlUsd: 680_000_000,
        tvlChange24hPct: 2.1,
        auditStatus: 'fully-audited',
        auditors: ['OtterSec', 'Offside Labs'],
        launchDate: '2021-10-01',
        ageMonths: 40,
        incidents: [],
        yieldPools: [
          { poolId: 'jup-jlp', name: 'JLP Pool', tokenA: 'JUP', tokenB: 'USDC', apy: 42.5, tvlUsd: 200_000_000, riskTier: 'medium' },
        ],
        supportedTokens: ['SOL', 'USDC', 'USDT', 'JUP', 'ETH', 'BTC', 'mSOL'],
        swapFeeRate: 0.002,
      },
      {
        id: 'drift',
        name: 'Drift Protocol',
        category: 'perpetuals',
        chain: 'solana',
        website: 'https://drift.trade',
        tvlUsd: 430_000_000,
        tvlChange24hPct: -1.5,
        auditStatus: 'partially-audited',
        auditors: ['OtterSec'],
        launchDate: '2021-11-01',
        ageMonths: 39,
        incidents: [
          {
            id: 'drift-inc-1',
            date: '2022-05-15',
            severity: 'warning',
            title: 'Price oracle lag',
            description: 'Temporary oracle lag caused brief liquidation anomalies',
            lossUsd: 500_000,
            resolved: true,
          },
        ],
        yieldPools: [
          { poolId: 'drift-usdc-lending', name: 'USDC Lending', tokenA: 'USDC', tokenB: null, apy: 12.4, tvlUsd: 100_000_000, riskTier: 'medium' },
          { poolId: 'drift-sol-lending', name: 'SOL Lending', tokenA: 'SOL', tokenB: null, apy: 8.9, tvlUsd: 80_000_000, riskTier: 'medium' },
        ],
        supportedTokens: ['SOL', 'USDC', 'BTC', 'ETH', 'DRIFT'],
        swapFeeRate: 0.001,
      },
      {
        id: 'kamino',
        name: 'Kamino Finance',
        category: 'lending',
        chain: 'solana',
        website: 'https://kamino.finance',
        tvlUsd: 1_800_000_000,
        tvlChange24hPct: 0.9,
        auditStatus: 'fully-audited',
        auditors: ['OtterSec', 'Offside Labs', 'MadShield'],
        launchDate: '2022-06-01',
        ageMonths: 32,
        incidents: [],
        yieldPools: [
          { poolId: 'kamino-usdc-lending', name: 'USDC Lending', tokenA: 'USDC', tokenB: null, apy: 9.8, tvlUsd: 400_000_000, riskTier: 'low' },
          { poolId: 'kamino-sol-lending', name: 'SOL Lending', tokenA: 'SOL', tokenB: null, apy: 6.5, tvlUsd: 300_000_000, riskTier: 'low' },
          { poolId: 'kamino-jitosol', name: 'JitoSOL Multiply', tokenA: 'JitoSOL', tokenB: null, apy: 15.2, tvlUsd: 200_000_000, riskTier: 'medium' },
        ],
        supportedTokens: ['SOL', 'USDC', 'USDT', 'mSOL', 'JitoSOL', 'ETH'],
        swapFeeRate: 0.002,
      },
    ];

    for (const data of protocolData) {
      const healthScore = this.computeHealthScore(data as ProtocolInfo);
      const riskGrade = this.riskGradeFromScore(healthScore);
      this.protocols.set(data.id, {
        ...data,
        healthScore,
        riskGrade,
        lastUpdated: isoNow(),
      });
    }
  }

  private generateAlerts(): void {
    this.addAlert({
      protocolId: 'drift',
      protocolName: 'Drift Protocol',
      type: 'tvl-drop',
      severity: 'warning',
      title: 'TVL decreased 1.5% in 24h',
      description: 'Drift Protocol TVL dropped from $436M to $430M in the last 24 hours.',
      detectedAt: isoNow(),
      resolved: false,
      resolvedAt: null,
      metadata: { tvlBefore: 436_500_000, tvlAfter: 430_000_000, changePct: -1.5 },
    });

    this.addAlert({
      protocolId: 'orca',
      protocolName: 'Orca',
      type: 'tvl-drop',
      severity: 'info',
      title: 'Minor TVL fluctuation',
      description: 'Orca TVL saw a minor 0.8% decrease, within normal volatility range.',
      detectedAt: isoNow(),
      resolved: true,
      resolvedAt: isoNow(),
      metadata: { changePct: -0.8 },
    });
  }
}
