// Colosseum AI-Agent Trading API — SDK entry point
export { TradingAPIClient, TradingAPIError } from './client.js';
export type { TradingAPIClientOptions } from './client.js';
export type {
  // Core enums / unions
  Side,
  IntentStatus,
  ExecutionMode,
  StrategyId,

  // Agent
  RiskLimits,
  RegisterAgentOpts,
  Agent,
  RegisterAgentResponse,
  Position,

  // Portfolio
  Portfolio,

  // Risk
  RiskTelemetry,

  // Trade Intents
  TradeIntentInput,
  TradeIntent,
  TradeIntentResult,

  // Executions
  ExecutionRecord,

  // Receipts
  ExecutionReceipt,
  ReceiptVerification,

  // Autonomous
  AutonomousStatus,

  // System
  HealthResponse,
  MetricsResponse,

  // Errors
  APIErrorEnvelope,
} from './types.js';
