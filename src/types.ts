export type Side = 'buy' | 'sell';
export type IntentStatus = 'pending' | 'processing' | 'executed' | 'rejected' | 'failed';
export type ExecutionMode = 'paper' | 'live';
export type StrategyId = 'momentum-v1' | 'mean-reversion-v1';

export interface RiskLimits {
  maxPositionSizePct: number;
  maxOrderNotionalUsd: number;
  maxGrossExposureUsd: number;
  dailyLossCapUsd: number;
  maxDrawdownPct: number;
  cooldownSeconds: number;
}

export interface Position {
  symbol: string;
  quantity: number;
  avgEntryPriceUsd: number;
}

export interface Agent {
  id: string;
  name: string;
  apiKey: string;
  createdAt: string;
  updatedAt: string;
  startingCapitalUsd: number;
  cashUsd: number;
  realizedPnlUsd: number;
  peakEquityUsd: number;
  riskLimits: RiskLimits;
  positions: Record<string, Position>;
  dailyRealizedPnlUsd: Record<string, number>;
  riskRejectionsByReason: Record<string, number>;
  strategyId: StrategyId;
  lastTradeAt?: string;
}

export interface TradeIntent {
  id: string;
  agentId: string;
  symbol: string;
  side: Side;
  quantity?: number;
  notionalUsd?: number;
  requestedMode?: ExecutionMode;
  meta?: Record<string, unknown>;
  idempotencyKey?: string;
  requestHash?: string;
  createdAt: string;
  updatedAt: string;
  status: IntentStatus;
  statusReason?: string;
  executionId?: string;
}

export interface ExecutionRecord {
  id: string;
  intentId: string;
  agentId: string;
  symbol: string;
  side: Side;
  quantity: number;
  priceUsd: number;
  grossNotionalUsd: number;
  feeUsd: number;
  netUsd: number;
  realizedPnlUsd: number;
  pnlSnapshotUsd: number;
  mode: ExecutionMode;
  status: 'filled' | 'failed';
  failureReason?: string;
  txSignature?: string;
  receiptHash?: string;
  createdAt: string;
}

export interface ExecutionReceipt {
  version: 'v1';
  executionId: string;
  payload: {
    executionId: string;
    intentId: string;
    agentId: string;
    symbol: string;
    side: Side;
    quantity: number;
    priceUsd: number;
    grossNotionalUsd: number;
    feeUsd: number;
    netUsd: number;
    realizedPnlUsd: number;
    pnlSnapshotUsd: number;
    mode: ExecutionMode;
    status: ExecutionRecord['status'];
    failureReason?: string;
    txSignature?: string;
    timestamp: string;
  };
  payloadHash: string;
  prevReceiptHash?: string;
  receiptHash: string;
  signaturePayload: {
    scheme: 'colosseum-receipt-signature-v1';
    message: string;
    messageHash: string;
  };
  createdAt: string;
}

export interface IdempotencyRecord {
  key: string;
  agentId: string;
  requestHash: string;
  intentId: string;
  createdAt: string;
}

export interface MarketPricePoint {
  ts: string;
  priceUsd: number;
}

export interface TreasuryEntry {
  id: string;
  source: 'execution-fee' | 'api-payment';
  amountUsd: number;
  refId: string;
  createdAt: string;
  notes?: string;
}

export interface TreasuryState {
  totalFeesUsd: number;
  entries: TreasuryEntry[];
}

export interface ClawpumpLaunchAttempt {
  id: string;
  ts: string;
  status: 'success' | 'failed';
  request: {
    name: string;
    symbol: string;
    description: string;
    website?: string;
    twitter?: string;
    telegram?: string;
    imagePath?: string;
  };
  walletAddress: string;
  errorCode?: string;
  errorMessage?: string;
  errorDetails?: Record<string, unknown>;
}

export interface TokenRevenueState {
  clawpumpLaunchAttempts: ClawpumpLaunchAttempt[];
}

export interface RiskDecision {
  approved: boolean;
  reason?: string;
  computedNotionalUsd: number;
  computedQuantity: number;
}

export interface MetricsState {
  startedAt: string;
  workerLoops: number;
  intentsReceived: number;
  intentsExecuted: number;
  intentsRejected: number;
  intentsFailed: number;
  riskRejectionsByReason: Record<string, number>;
  lastWorkerRunAt?: string;
  apiPaymentDenials: number;
  idempotencyReplays: number;
  receiptCount: number;
  quoteRetries: number;
}

export interface AppState {
  agents: Record<string, Agent>;
  tradeIntents: Record<string, TradeIntent>;
  executions: Record<string, ExecutionRecord>;
  executionReceipts: Record<string, ExecutionReceipt>;
  latestReceiptHash?: string;
  idempotencyRecords: Record<string, IdempotencyRecord>;
  treasury: TreasuryState;
  tokenRevenue: TokenRevenueState;
  marketPricesUsd: Record<string, number>;
  marketPriceHistoryUsd: Record<string, MarketPricePoint[]>;
  metrics: MetricsState;
}

export interface RuntimeMetrics {
  uptimeSeconds: number;
  pendingIntents: number;
  processPid: number;
}

export interface RiskTelemetry {
  agentId: string;
  asOf: string;
  strategyId: StrategyId;
  cashUsd: number;
  equityUsd: number;
  grossExposureUsd: number;
  realizedPnlUsd: number;
  dailyPnlUsd: number;
  peakEquityUsd: number;
  drawdownPct: number;
  rejectCountersByReason: Record<string, number>;
  globalRejectCountersByReason: Record<string, number>;
  cooldown: {
    active: boolean;
    cooldownSeconds: number;
    remainingSeconds: number;
    lastTradeAt?: string;
    cooldownUntil?: string;
  };
  limits: RiskLimits;
}
