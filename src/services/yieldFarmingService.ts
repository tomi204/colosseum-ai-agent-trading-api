/**
 * Yield Farming Optimizer Service
 *
 * Provides DeFi yield optimization tools for AI agents:
 *
 *   - Yield opportunity scanner (find best APY across protocols)
 *   - Impermanent loss adjusted returns
 *   - Auto-compounding calculator (optimal compound frequency)
 *   - Risk-adjusted yield ranking (Sharpe ratio on yield)
 *   - Yield farming position tracker
 *   - Protocol risk scoring (TVL, audit status, age, insurance coverage)
 */

import { isoNow } from '../utils/time.js';

// ─── Types ──────────────────────────────────────────────────────────────

export type RiskTier = 'low' | 'medium' | 'high' | 'very-high';

export interface YieldOpportunity {
  id: string;
  protocol: string;
  pool: string;
  tokenA: string;
  tokenB: string | null;
  baseApy: number;          // Annual % (e.g. 12.5)
  rewardApy: number;        // Extra incentive APY
  totalApy: number;         // baseApy + rewardApy
  tvlUsd: number;
  chain: string;
  riskTier: RiskTier;
  ilRiskPct: number;        // Impermanent loss risk estimate (0-100)
  lastUpdated: string;
}

export interface CompoundResult {
  principalUsd: number;
  apy: number;
  compoundsPerYear: number;
  finalValueUsd: number;
  earnedUsd: number;
  effectiveApy: number;
  optimalCompoundsPerYear: number;
  optimalEffectiveApy: number;
  gasCostPerCompoundUsd: number;
  netGainAtOptimal: number;
}

export interface YieldPosition {
  id: string;
  agentId: string;
  opportunityId: string;
  protocol: string;
  pool: string;
  depositedUsd: number;
  currentValueUsd: number;
  earnedUsd: number;
  entryApy: number;
  currentApy: number;
  impermanentLossUsd: number;
  enteredAt: string;
  lastHarvestAt: string | null;
  status: 'active' | 'exited';
}

export interface ProtocolRiskScore {
  protocol: string;
  overallScore: number;         // 0-100
  tvlUsd: number;
  tvlScore: number;             // 0-100
  auditStatus: 'audited' | 'partial' | 'unaudited';
  auditScore: number;           // 0-100
  ageMonths: number;
  ageScore: number;             // 0-100
  insuranceCoverage: boolean;
  insuranceScore: number;       // 0-100
  riskTier: RiskTier;
  description: string;
}

export interface RiskAdjustedYield {
  opportunityId: string;
  protocol: string;
  pool: string;
  totalApy: number;
  volatility: number;
  sharpeRatio: number;
  ilAdjustedApy: number;
  riskAdjustedRank: number;
}

export interface ImpermanentLossResult {
  priceChangeRatio: number;
  ilPct: number;
  holdValueUsd: number;
  lpValueUsd: number;
  ilUsd: number;
  feeCompensationApy: number;
  netApyAfterIl: number;
  breakEvenDays: number | null;
}

// ─── Seed Data ──────────────────────────────────────────────────────────

const SEED_PROTOCOLS: ProtocolRiskScore[] = [
  {
    protocol: 'raydium',
    overallScore: 78,
    tvlUsd: 850_000_000,
    tvlScore: 85,
    auditStatus: 'audited',
    auditScore: 90,
    ageMonths: 36,
    ageScore: 80,
    insuranceCoverage: false,
    insuranceScore: 0,
    riskTier: 'medium',
    description: 'Leading Solana AMM with deep liquidity and multiple audits.',
  },
  {
    protocol: 'orca',
    overallScore: 82,
    tvlUsd: 420_000_000,
    tvlScore: 75,
    auditStatus: 'audited',
    auditScore: 95,
    ageMonths: 30,
    ageScore: 75,
    insuranceCoverage: false,
    insuranceScore: 0,
    riskTier: 'low',
    description: 'User-friendly Solana DEX with concentrated liquidity (Whirlpools).',
  },
  {
    protocol: 'marinade',
    overallScore: 88,
    tvlUsd: 1_200_000_000,
    tvlScore: 95,
    auditStatus: 'audited',
    auditScore: 92,
    ageMonths: 28,
    ageScore: 72,
    insuranceCoverage: true,
    insuranceScore: 80,
    riskTier: 'low',
    description: 'Liquid staking protocol for SOL with broad validator set.',
  },
  {
    protocol: 'meteora',
    overallScore: 65,
    tvlUsd: 180_000_000,
    tvlScore: 55,
    auditStatus: 'partial',
    auditScore: 60,
    ageMonths: 14,
    ageScore: 45,
    insuranceCoverage: false,
    insuranceScore: 0,
    riskTier: 'medium',
    description: 'Dynamic liquidity provider on Solana with DLMM pools.',
  },
  {
    protocol: 'tulip',
    overallScore: 52,
    tvlUsd: 45_000_000,
    tvlScore: 30,
    auditStatus: 'partial',
    auditScore: 45,
    ageMonths: 24,
    ageScore: 65,
    insuranceCoverage: false,
    insuranceScore: 0,
    riskTier: 'high',
    description: 'Yield aggregator on Solana; moderate TVL with partial audit coverage.',
  },
  {
    protocol: 'kamino',
    overallScore: 75,
    tvlUsd: 350_000_000,
    tvlScore: 70,
    auditStatus: 'audited',
    auditScore: 85,
    ageMonths: 18,
    ageScore: 55,
    insuranceCoverage: true,
    insuranceScore: 70,
    riskTier: 'medium',
    description: 'Automated liquidity management with lending/borrowing on Solana.',
  },
];

const SEED_OPPORTUNITIES: YieldOpportunity[] = [
  {
    id: 'yield-raydium-sol-usdc',
    protocol: 'raydium',
    pool: 'SOL-USDC',
    tokenA: 'SOL',
    tokenB: 'USDC',
    baseApy: 8.5,
    rewardApy: 4.2,
    totalApy: 12.7,
    tvlUsd: 120_000_000,
    chain: 'solana',
    riskTier: 'medium',
    ilRiskPct: 15,
    lastUpdated: isoNow(),
  },
  {
    id: 'yield-orca-sol-usdc',
    protocol: 'orca',
    pool: 'SOL-USDC Whirlpool',
    tokenA: 'SOL',
    tokenB: 'USDC',
    baseApy: 11.2,
    rewardApy: 3.8,
    totalApy: 15.0,
    tvlUsd: 85_000_000,
    chain: 'solana',
    riskTier: 'medium',
    ilRiskPct: 18,
    lastUpdated: isoNow(),
  },
  {
    id: 'yield-marinade-msol',
    protocol: 'marinade',
    pool: 'mSOL Staking',
    tokenA: 'SOL',
    tokenB: null,
    baseApy: 6.8,
    rewardApy: 0.5,
    totalApy: 7.3,
    tvlUsd: 800_000_000,
    chain: 'solana',
    riskTier: 'low',
    ilRiskPct: 0,
    lastUpdated: isoNow(),
  },
  {
    id: 'yield-meteora-sol-usdt',
    protocol: 'meteora',
    pool: 'SOL-USDT DLMM',
    tokenA: 'SOL',
    tokenB: 'USDT',
    baseApy: 22.4,
    rewardApy: 8.1,
    totalApy: 30.5,
    tvlUsd: 35_000_000,
    chain: 'solana',
    riskTier: 'high',
    ilRiskPct: 28,
    lastUpdated: isoNow(),
  },
  {
    id: 'yield-kamino-sol-bonk',
    protocol: 'kamino',
    pool: 'SOL-BONK Vault',
    tokenA: 'SOL',
    tokenB: 'BONK',
    baseApy: 45.0,
    rewardApy: 12.0,
    totalApy: 57.0,
    tvlUsd: 15_000_000,
    chain: 'solana',
    riskTier: 'very-high',
    ilRiskPct: 55,
    lastUpdated: isoNow(),
  },
  {
    id: 'yield-raydium-ray-usdc',
    protocol: 'raydium',
    pool: 'RAY-USDC',
    tokenA: 'RAY',
    tokenB: 'USDC',
    baseApy: 14.3,
    rewardApy: 6.5,
    totalApy: 20.8,
    tvlUsd: 42_000_000,
    chain: 'solana',
    riskTier: 'medium',
    ilRiskPct: 22,
    lastUpdated: isoNow(),
  },
  {
    id: 'yield-orca-msol-sol',
    protocol: 'orca',
    pool: 'mSOL-SOL Whirlpool',
    tokenA: 'mSOL',
    tokenB: 'SOL',
    baseApy: 5.2,
    rewardApy: 2.1,
    totalApy: 7.3,
    tvlUsd: 65_000_000,
    chain: 'solana',
    riskTier: 'low',
    ilRiskPct: 2,
    lastUpdated: isoNow(),
  },
  {
    id: 'yield-tulip-sol-lending',
    protocol: 'tulip',
    pool: 'SOL Lending Vault',
    tokenA: 'SOL',
    tokenB: null,
    baseApy: 3.8,
    rewardApy: 1.2,
    totalApy: 5.0,
    tvlUsd: 18_000_000,
    chain: 'solana',
    riskTier: 'high',
    ilRiskPct: 0,
    lastUpdated: isoNow(),
  },
];

// ─── Helpers ────────────────────────────────────────────────────────────

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, value));
}

function round4(n: number): number {
  return Number(n.toFixed(4));
}

function round2(n: number): number {
  return Number(n.toFixed(2));
}

function riskTierFromScore(score: number): RiskTier {
  if (score >= 80) return 'low';
  if (score >= 60) return 'medium';
  if (score >= 40) return 'high';
  return 'very-high';
}

let positionCounter = 0;

// ─── Service ────────────────────────────────────────────────────────────

export class YieldFarmingService {
  private opportunities: Map<string, YieldOpportunity> = new Map();
  private positions: Map<string, YieldPosition> = new Map();
  private protocolScores: Map<string, ProtocolRiskScore> = new Map();

  constructor() {
    // Seed data
    for (const opp of SEED_OPPORTUNITIES) {
      this.opportunities.set(opp.id, opp);
    }
    for (const ps of SEED_PROTOCOLS) {
      this.protocolScores.set(ps.protocol, ps);
    }
  }

  // ─── Yield Opportunity Scanner ──────────────────────────────────────

  /**
   * Scan yield opportunities with optional filters.
   */
  scanOpportunities(filters?: {
    protocol?: string;
    minApy?: number;
    maxRisk?: RiskTier;
    chain?: string;
    sortBy?: 'apy' | 'tvl' | 'risk';
  }): YieldOpportunity[] {
    let results = Array.from(this.opportunities.values());

    if (filters?.protocol) {
      results = results.filter((o) => o.protocol === filters.protocol);
    }

    if (filters?.minApy !== undefined) {
      results = results.filter((o) => o.totalApy >= filters.minApy!);
    }

    if (filters?.maxRisk) {
      const riskOrder: Record<RiskTier, number> = { low: 1, medium: 2, high: 3, 'very-high': 4 };
      const maxLevel = riskOrder[filters.maxRisk];
      results = results.filter((o) => riskOrder[o.riskTier] <= maxLevel);
    }

    if (filters?.chain) {
      results = results.filter((o) => o.chain === filters.chain);
    }

    const sortBy = filters?.sortBy ?? 'apy';
    if (sortBy === 'apy') {
      results.sort((a, b) => b.totalApy - a.totalApy);
    } else if (sortBy === 'tvl') {
      results.sort((a, b) => b.tvlUsd - a.tvlUsd);
    } else if (sortBy === 'risk') {
      const riskOrder: Record<RiskTier, number> = { low: 1, medium: 2, high: 3, 'very-high': 4 };
      results.sort((a, b) => riskOrder[a.riskTier] - riskOrder[b.riskTier]);
    }

    return results;
  }

  /**
   * Get details for a specific opportunity.
   */
  getOpportunity(id: string): YieldOpportunity | null {
    return this.opportunities.get(id) ?? null;
  }

  // ─── Auto-Compounding Calculator ────────────────────────────────────

  /**
   * Calculate compound returns and find optimal compounding frequency.
   * Uses the formula: A = P × (1 + r/n)^(n×t)
   * Optimal frequency balances gas costs against compounding gains.
   */
  calculateCompound(params: {
    principalUsd: number;
    apy: number;
    compoundsPerYear: number;
    durationYears?: number;
    gasCostPerCompoundUsd?: number;
  }): CompoundResult {
    const {
      principalUsd,
      apy,
      compoundsPerYear,
      durationYears = 1,
      gasCostPerCompoundUsd = 0.01,
    } = params;

    const rate = apy / 100;
    const n = Math.max(1, compoundsPerYear);

    // Compound interest: A = P × (1 + r/n)^(n×t)
    const finalValueUsd = principalUsd * Math.pow(1 + rate / n, n * durationYears);
    const earnedUsd = finalValueUsd - principalUsd;
    const effectiveApy = ((finalValueUsd / principalUsd) - 1) * 100 / durationYears;

    // Find optimal compounding frequency
    // Net gain = compounded_return - gas_costs
    let bestN = 1;
    let bestNetGain = -Infinity;

    // Test common frequencies: 1 (annual), 4 (quarterly), 12 (monthly), 52 (weekly), 365 (daily), 730 (twice daily)
    const candidates = [1, 2, 4, 12, 26, 52, 104, 365, 730, 1460];
    for (const testN of candidates) {
      const testFinal = principalUsd * Math.pow(1 + rate / testN, testN * durationYears);
      const testEarned = testFinal - principalUsd;
      const totalGas = testN * durationYears * gasCostPerCompoundUsd;
      const netGain = testEarned - totalGas;

      if (netGain > bestNetGain) {
        bestNetGain = netGain;
        bestN = testN;
      }
    }

    const optimalFinal = principalUsd * Math.pow(1 + rate / bestN, bestN * durationYears);
    const optimalEffectiveApy = ((optimalFinal / principalUsd) - 1) * 100 / durationYears;

    return {
      principalUsd: round2(principalUsd),
      apy: round4(apy),
      compoundsPerYear: n,
      finalValueUsd: round2(finalValueUsd),
      earnedUsd: round2(earnedUsd),
      effectiveApy: round4(effectiveApy),
      optimalCompoundsPerYear: bestN,
      optimalEffectiveApy: round4(optimalEffectiveApy),
      gasCostPerCompoundUsd: round4(gasCostPerCompoundUsd),
      netGainAtOptimal: round2(bestNetGain),
    };
  }

  // ─── Impermanent Loss Calculator ────────────────────────────────────

  /**
   * Calculate impermanent loss for an AMM LP position.
   * IL formula: IL = 2 × √(priceRatio) / (1 + priceRatio) - 1
   */
  calculateImpermanentLoss(params: {
    initialPriceRatio: number;
    currentPriceRatio: number;
    depositValueUsd: number;
    baseApy?: number;
    durationDays?: number;
  }): ImpermanentLossResult {
    const {
      initialPriceRatio,
      currentPriceRatio,
      depositValueUsd,
      baseApy = 0,
      durationDays = 365,
    } = params;

    const priceChangeRatio = currentPriceRatio / initialPriceRatio;

    // IL formula: IL = 2×√(r)/(1+r) - 1
    const sqrtR = Math.sqrt(priceChangeRatio);
    const ilPct = (2 * sqrtR / (1 + priceChangeRatio)) - 1;
    const ilPctAbsolute = Math.abs(ilPct) * 100;

    // Hold value (just holding the tokens)
    const holdValueUsd = depositValueUsd * (1 + priceChangeRatio) / 2;

    // LP value considering IL
    const lpValueUsd = depositValueUsd * (2 * sqrtR / (1 + priceChangeRatio));

    const ilUsd = holdValueUsd - lpValueUsd;

    // Fee compensation needed to offset IL
    const feeCompensationApy = durationDays > 0
      ? (ilPctAbsolute / (durationDays / 365)) 
      : 0;

    const netApyAfterIl = baseApy - feeCompensationApy;

    // Break-even days: how long until fees earned > IL
    let breakEvenDays: number | null = null;
    if (baseApy > 0 && ilPctAbsolute > 0) {
      const dailyFeeRate = baseApy / 100 / 365;
      breakEvenDays = Math.ceil(ilPctAbsolute / 100 / dailyFeeRate);
    }

    return {
      priceChangeRatio: round4(priceChangeRatio),
      ilPct: round4(ilPctAbsolute),
      holdValueUsd: round2(holdValueUsd),
      lpValueUsd: round2(lpValueUsd),
      ilUsd: round2(ilUsd),
      feeCompensationApy: round4(feeCompensationApy),
      netApyAfterIl: round4(netApyAfterIl),
      breakEvenDays,
    };
  }

  // ─── Risk-Adjusted Yield Ranking ────────────────────────────────────

  /**
   * Rank yield opportunities by risk-adjusted return (Sharpe-like ratio).
   */
  getRiskAdjustedRanking(): RiskAdjustedYield[] {
    const riskFreeRate = 5.0; // SOL staking baseline ~5% APY

    const rankings: RiskAdjustedYield[] = Array.from(this.opportunities.values()).map((opp) => {
      // Estimate volatility based on risk tier
      const volatilityMap: Record<RiskTier, number> = {
        low: 5,
        medium: 15,
        high: 30,
        'very-high': 55,
      };
      const volatility = volatilityMap[opp.riskTier];

      // IL-adjusted APY
      const ilDrag = opp.ilRiskPct * 0.3; // rough adjustment
      const ilAdjustedApy = round4(opp.totalApy - ilDrag);

      // Sharpe = (return - riskFree) / volatility
      const sharpeRatio = volatility > 0
        ? round4((ilAdjustedApy - riskFreeRate) / volatility)
        : 0;

      return {
        opportunityId: opp.id,
        protocol: opp.protocol,
        pool: opp.pool,
        totalApy: opp.totalApy,
        volatility,
        sharpeRatio,
        ilAdjustedApy,
        riskAdjustedRank: 0, // set below
      };
    });

    // Sort by Sharpe ratio descending
    rankings.sort((a, b) => b.sharpeRatio - a.sharpeRatio);
    rankings.forEach((r, i) => { r.riskAdjustedRank = i + 1; });

    return rankings;
  }

  // ─── Position Tracker ───────────────────────────────────────────────

  /**
   * Enter a yield farming position.
   */
  enterPosition(params: {
    agentId: string;
    opportunityId: string;
    depositedUsd: number;
  }): YieldPosition {
    const opp = this.opportunities.get(params.opportunityId);
    if (!opp) {
      throw new Error(`Opportunity not found: ${params.opportunityId}`);
    }

    positionCounter += 1;
    const id = `yp-${Date.now()}-${positionCounter}`;

    const position: YieldPosition = {
      id,
      agentId: params.agentId,
      opportunityId: params.opportunityId,
      protocol: opp.protocol,
      pool: opp.pool,
      depositedUsd: round2(params.depositedUsd),
      currentValueUsd: round2(params.depositedUsd),
      earnedUsd: 0,
      entryApy: opp.totalApy,
      currentApy: opp.totalApy,
      impermanentLossUsd: 0,
      enteredAt: isoNow(),
      lastHarvestAt: null,
      status: 'active',
    };

    this.positions.set(id, position);
    return position;
  }

  /**
   * Get all positions for an agent.
   */
  getPositions(agentId: string): YieldPosition[] {
    return Array.from(this.positions.values())
      .filter((p) => p.agentId === agentId)
      .sort((a, b) => b.enteredAt.localeCompare(a.enteredAt));
  }

  /**
   * Get a position by ID.
   */
  getPosition(positionId: string): YieldPosition | null {
    return this.positions.get(positionId) ?? null;
  }

  // ─── Protocol Risk Scoring ──────────────────────────────────────────

  /**
   * Get risk scores for all tracked protocols.
   */
  getProtocolRiskScores(): ProtocolRiskScore[] {
    return Array.from(this.protocolScores.values())
      .sort((a, b) => b.overallScore - a.overallScore);
  }

  /**
   * Get risk score for a specific protocol.
   */
  getProtocolRiskScore(protocol: string): ProtocolRiskScore | null {
    return this.protocolScores.get(protocol) ?? null;
  }

  /**
   * Compute a custom protocol risk score from provided parameters.
   */
  computeProtocolRisk(params: {
    protocol: string;
    tvlUsd: number;
    auditStatus: 'audited' | 'partial' | 'unaudited';
    ageMonths: number;
    insuranceCoverage: boolean;
  }): ProtocolRiskScore {
    // TVL score: scale logarithmically
    //   <1M → 10, 10M → 40, 100M → 60, 500M → 75, 1B+ → 90
    let tvlScore: number;
    if (params.tvlUsd >= 1_000_000_000) tvlScore = 90 + clamp((params.tvlUsd - 1e9) / 1e10 * 10, 0, 10);
    else if (params.tvlUsd >= 500_000_000) tvlScore = 75 + (params.tvlUsd - 5e8) / 5e8 * 15;
    else if (params.tvlUsd >= 100_000_000) tvlScore = 60 + (params.tvlUsd - 1e8) / 4e8 * 15;
    else if (params.tvlUsd >= 10_000_000) tvlScore = 40 + (params.tvlUsd - 1e7) / 9e7 * 20;
    else tvlScore = clamp(params.tvlUsd / 1_000_000 * 10, 0, 40);
    tvlScore = round2(clamp(tvlScore));

    // Audit score
    const auditScoreMap: Record<string, number> = { audited: 90, partial: 55, unaudited: 10 };
    const auditScore = auditScoreMap[params.auditStatus] ?? 10;

    // Age score: 0 months → 0, 6 → 30, 12 → 50, 24 → 70, 36+ → 85
    let ageScore: number;
    if (params.ageMonths >= 36) ageScore = 85;
    else if (params.ageMonths >= 24) ageScore = 70 + (params.ageMonths - 24) / 12 * 15;
    else if (params.ageMonths >= 12) ageScore = 50 + (params.ageMonths - 12) / 12 * 20;
    else if (params.ageMonths >= 6) ageScore = 30 + (params.ageMonths - 6) / 6 * 20;
    else ageScore = params.ageMonths / 6 * 30;
    ageScore = round2(clamp(ageScore));

    // Insurance score
    const insuranceScore = params.insuranceCoverage ? 80 : 0;

    // Weights: TVL=30%, Audit=30%, Age=20%, Insurance=20%
    const overallScore = round2(clamp(
      tvlScore * 0.30 +
      auditScore * 0.30 +
      ageScore * 0.20 +
      insuranceScore * 0.20,
    ));

    const riskTier = riskTierFromScore(overallScore);

    const result: ProtocolRiskScore = {
      protocol: params.protocol,
      overallScore,
      tvlUsd: params.tvlUsd,
      tvlScore,
      auditStatus: params.auditStatus,
      auditScore,
      ageMonths: params.ageMonths,
      ageScore,
      insuranceCoverage: params.insuranceCoverage,
      insuranceScore,
      riskTier,
      description: `Computed risk score for ${params.protocol}: TVL $${(params.tvlUsd / 1e6).toFixed(1)}M, ${params.auditStatus}, ${params.ageMonths}mo old.`,
    };

    // Cache it
    this.protocolScores.set(params.protocol, result);

    return result;
  }
}
