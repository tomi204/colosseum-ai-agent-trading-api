import { AppState } from '../../types.js';
import { isoNow } from '../../utils/time.js';

const defaultMarketPricesUsd = {
  SOL: 100,
  USDC: 1,
  BONK: 0.00002,
  JUP: 0.8,
};

export const createDefaultState = (): AppState => {
  const now = isoNow();

  return {
    agents: {},
    tradeIntents: {},
    executions: {},
    executionReceipts: {},
    idempotencyRecords: {},
    treasury: {
      totalFeesUsd: 0,
      entries: [],
    },
    tokenRevenue: {
      clawpumpLaunchAttempts: [],
    },
    marketPricesUsd: {
      ...defaultMarketPricesUsd,
    },
    marketPriceHistoryUsd: Object.fromEntries(
      Object.entries(defaultMarketPricesUsd).map(([symbol, priceUsd]) => [
        symbol,
        [{ ts: now, priceUsd }],
      ]),
    ),
    metrics: {
      startedAt: now,
      workerLoops: 0,
      intentsReceived: 0,
      intentsExecuted: 0,
      intentsRejected: 0,
      intentsFailed: 0,
      riskRejectionsByReason: {},
      apiPaymentDenials: 0,
      idempotencyReplays: 0,
      receiptCount: 0,
      quoteRetries: 0,
      rateLimitDenials: 0,
      webhooksSent: 0,
      simulationsRun: 0,
    },
    autonomous: {
      enabled: false,
      intervalMs: 30000,
      loopCount: 0,
      lastRunAt: null,
      agentStates: {},
    },
    lending: {
      positions: {},
      alerts: {},
      lastScanAt: null,
    },
    tournaments: {},
  };
};
