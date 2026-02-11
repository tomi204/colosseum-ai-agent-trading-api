export const ErrorCode = {
  InvalidPayload: 'invalid_payload',
  UnsupportedSymbol: 'unsupported_symbol',
  AgentNotFound: 'agent_not_found',
  AgentKeyMismatch: 'agent_key_mismatch',
  MissingAgentApiKey: 'missing_agent_api_key',
  InvalidAgentApiKey: 'invalid_agent_api_key',
  IntentNotFound: 'intent_not_found',
  ExecutionNotFound: 'execution_not_found',
  ReceiptNotFound: 'receipt_not_found',
  IdempotencyKeyConflict: 'idempotency_key_conflict',
  PaymentRequired: 'payment_required',
  IntegrationMisconfigured: 'integration_misconfigured',
  IntegrationUnavailable: 'integration_unavailable',
  UpstreamRateLimited: 'upstream_rate_limited',
  SquadNotFound: 'squad_not_found',
  SquadCollision: 'squad_collision',
  RateLimited: 'rate_limited',
  PipelineNotFound: 'pipeline_not_found',
  SimulationFailed: 'simulation_failed',
  ProposalNotFound: 'proposal_not_found',
  ProofNotFound: 'proof_not_found',
  ListingNotFound: 'listing_not_found',
  BacktestFailed: 'backtest_failed',
  OrderNotFound: 'order_not_found',
  RecommendationNotFound: 'recommendation_not_found',
  TournamentNotFound: 'tournament_not_found',
  SubscriptionNotFound: 'subscription_not_found',
  SandboxNotFound: 'sandbox_not_found',
  InternalError: 'internal_error',
} as const;

export type ErrorCode = typeof ErrorCode[keyof typeof ErrorCode];

export class DomainError extends Error {
  constructor(
    public readonly code: ErrorCode,
    public readonly statusCode: number,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const toErrorEnvelope = (
  code: ErrorCode,
  message: string,
  details?: unknown,
): {
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
  };
} => ({
  error: {
    code,
    message,
    ...(details === undefined ? {} : { details }),
  },
});
