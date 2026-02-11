// ─── SDK Types ─────────────────────────────────────────────────────────────
// Clean, self-contained types for the Colosseum AI-Agent Trading API SDK.
// These mirror the API responses but are decoupled from internal server types.
// ────────────────────────────────────────────────────────────────────────────

export type Side = 'buy' | 'sell';
export type IntentStatus = 'pending' | 'processing' | 'executed' | 'rejected' | 'failed';
export type ExecutionMode = 'paper' | 'live';
export type StrategyId = 'momentum-v1' | 'mean-reversion-v1';

// ─── Agent ─────────────────────────────────────────────────────────────────

export interface RiskLimits {
  maxPositionSizePct: number;
  maxOrderNotionalUsd: number;
  maxGrossExposureUsd: number;
  dailyLossCapUsd: number;
  maxDrawdownPct: number;
  cooldownSeconds: number;
}

export interface RegisterAgentOpts {
  name: string;
  startingCapitalUsd?: number;
  strategyId?: StrategyId;
  riskOverrides?: Partial<RiskLimits>;
}

export interface Agent {
  id: string;
  name: string;
  createdAt: string;
  updatedAt?: string;
  startingCapitalUsd: number;
  cashUsd?: number;
  realizedPnlUsd?: number;
  peakEquityUsd?: number;
  riskLimits: RiskLimits;
  strategyId: StrategyId;
  positions?: Position[];
  lastTradeAt?: string;
}

export interface RegisterAgentResponse {
  agent: Agent;
  apiKey: string;
  note: string;
}

export interface Position {
  symbol: string;
  quantity: number;
  avgEntryPriceUsd: number;
}

// ─── Portfolio ─────────────────────────────────────────────────────────────

export interface Portfolio {
  agentId: string;
  cashUsd: number;
  inventoryValueUsd: number;
  equityUsd: number;
  realizedPnlUsd: number;
  positions: Position[];
  marketPricesUsd: Record<string, number>;
  strategyId: StrategyId;
}

// ─── Risk Telemetry ────────────────────────────────────────────────────────

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

// ─── Trade Intents ─────────────────────────────────────────────────────────

export interface TradeIntentInput {
  agentId: string;
  symbol: string;
  side: Side;
  quantity?: number;
  notionalUsd?: number;
  requestedMode?: ExecutionMode;
  meta?: Record<string, unknown>;
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
  createdAt: string;
  updatedAt: string;
  status: IntentStatus;
  statusReason?: string;
  executionId?: string;
}

export interface TradeIntentResult {
  message: 'intent_queued' | 'intent_replayed';
  replayed: boolean;
  intent: TradeIntent;
}

// ─── Executions ────────────────────────────────────────────────────────────

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

// ─── Receipts ──────────────────────────────────────────────────────────────

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
    status: 'filled' | 'failed';
    failureReason?: string;
    txSignature?: string;
    timestamp: string;
  };
  payloadHash: string;
  prevReceiptHash?: string;
  receiptHash: string;
  signaturePayload: {
    scheme: string;
    message: string;
    messageHash: string;
  };
  createdAt: string;
}

export interface ReceiptVerification {
  ok: boolean;
  expectedPayloadHash: string;
  expectedReceiptHash: string;
  expectedSignaturePayloadHash: string;
}

// ─── Autonomous ────────────────────────────────────────────────────────────

export interface AutonomousStatus {
  enabled: boolean;
  intervalMs: number;
  loopCount: number;
  lastRunAt: string | null;
  agentStates: Record<string, {
    cooldownUntilMs: number;
    halted: boolean;
    haltReason: string | null;
    consecutiveFailures: number;
    totalEvaluations: number;
    totalIntentsCreated: number;
    totalSkipped: number;
    lastEvaluationAt: string | null;
    lastIntentCreatedAt: string | null;
  }>;
}

// ─── System ────────────────────────────────────────────────────────────────

export interface HealthResponse {
  status: string;
  env: string;
  uptimeSeconds: number;
  pendingIntents: number;
  processPid: number;
  defaultMode: ExecutionMode;
  liveModeEnabled: boolean;
  stateSummary: {
    agents: number;
    intents: number;
    executions: number;
    receipts: number;
  };
}

export interface MetricsResponse {
  runtime: {
    uptimeSeconds: number;
    pendingIntents: number;
    processPid: number;
  };
  metrics: {
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
  };
  treasury: {
    totalFeesUsd: number;
    entries: Array<{
      id: string;
      source: string;
      amountUsd: number;
      refId: string;
      createdAt: string;
      notes?: string;
    }>;
  };
  monetization: Record<string, unknown>;
}

// ─── Errors ────────────────────────────────────────────────────────────────

export interface APIErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}
