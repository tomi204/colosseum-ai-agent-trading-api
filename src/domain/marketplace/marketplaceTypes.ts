export interface PerformanceStats {
  totalReturnPct: number;
  maxDrawdownPct: number;
  sharpeRatio: number;
  tradeCount: number;
  winRate: number;
}

export interface StrategyListing {
  id: string;
  agentId: string;
  strategyId: string;
  description: string;
  performanceStats: PerformanceStats;
  fee: number;
  subscribers: string[];
  reputationScore: number;
  createdAt: string;
  updatedAt: string;
}

export interface Subscription {
  subscriberId: string;
  listingId: string;
  subscribedAt: string;
}
