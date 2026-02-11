import dotenv from 'dotenv';
import path from 'node:path';

dotenv.config();

const parseBool = (input: string | undefined, fallback = false): boolean => {
  if (input === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(input.toLowerCase());
};

const parseNumber = (input: string | undefined, fallback: number): number => {
  if (input === undefined) return fallback;
  const n = Number(input);
  return Number.isFinite(n) ? n : fallback;
};

export const config = {
  app: {
    name: 'colosseum-ai-agent-trading-api',
    env: process.env.NODE_ENV ?? 'development',
    port: parseNumber(process.env.PORT, 8787),
  },
  paths: {
    dataDir: process.env.DATA_DIR ?? path.resolve(process.cwd(), 'data'),
    stateFile: process.env.STATE_FILE ?? path.resolve(process.cwd(), 'data', 'state.json'),
    logFile: process.env.LOG_FILE ?? path.resolve(process.cwd(), 'data', 'events.ndjson'),
  },
  worker: {
    intervalMs: parseNumber(process.env.WORKER_INTERVAL_MS, 1500),
    maxBatchSize: parseNumber(process.env.WORKER_MAX_BATCH_SIZE, 10),
  },
  trading: {
    defaultStartingCapitalUsd: parseNumber(process.env.DEFAULT_STARTING_CAPITAL_USD, 10000),
    defaultMode: (process.env.DEFAULT_MODE === 'live' ? 'live' : 'paper') as 'paper' | 'live',
    liveEnabled: parseBool(process.env.LIVE_TRADING_ENABLED, false),
    liveBroadcastEnabled: parseBool(process.env.LIVE_BROADCAST_ENABLED, false),
    solanaRpcUrl: process.env.SOLANA_RPC_URL,
    solanaPrivateKeyB58: process.env.SOLANA_PRIVATE_KEY_B58,
    jupiterQuoteUrl: process.env.JUPITER_QUOTE_URL ?? 'https://lite-api.jup.ag/swap/v1/quote',
    jupiterSwapUrl: process.env.JUPITER_SWAP_URL ?? 'https://lite-api.jup.ag/swap/v1/swap',
    jupiterReferralAccount: process.env.JUPITER_REFERRAL_ACCOUNT,
    jupiterPlatformFeeBps: parseNumber(process.env.JUPITER_PLATFORM_FEE_BPS, 8),
    platformFeeBps: parseNumber(process.env.PLATFORM_FEE_BPS, 8),
    supportedSymbols: (process.env.SUPPORTED_SYMBOLS ?? 'SOL,USDC,BONK,JUP').split(',').map((s) => s.trim()).filter(Boolean),
    symbolToMint: {
      SOL: process.env.MINT_SOL ?? 'So11111111111111111111111111111111111111112',
      USDC: process.env.MINT_USDC ?? 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      BONK: process.env.MINT_BONK ?? 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6Y7YaB1pPB263',
      JUP: process.env.MINT_JUP ?? 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
    } as Record<string, string>,
    quoteRetryAttempts: parseNumber(process.env.QUOTE_RETRY_ATTEMPTS, 3),
    quoteRetryBaseDelayMs: parseNumber(process.env.QUOTE_RETRY_BASE_DELAY_MS, 150),
    marketHistoryLimit: parseNumber(process.env.MARKET_HISTORY_LIMIT, 100),
  },
  risk: {
    maxPositionSizePct: parseNumber(process.env.RISK_MAX_POSITION_SIZE_PCT, 0.25),
    maxOrderNotionalUsd: parseNumber(process.env.RISK_MAX_ORDER_NOTIONAL_USD, 2500),
    maxGrossExposureUsd: parseNumber(process.env.RISK_MAX_GROSS_EXPOSURE_USD, 7500),
    dailyLossCapUsd: parseNumber(process.env.RISK_DAILY_LOSS_CAP_USD, 1000),
    maxDrawdownPct: parseNumber(process.env.RISK_MAX_DRAWDOWN_PCT, 0.2),
    cooldownSeconds: parseNumber(process.env.RISK_COOLDOWN_SECONDS, 3),
  },
  payments: {
    x402Enabled: parseBool(process.env.X402_ENABLED, false),
    x402VerifierUrl: process.env.X402_VERIFIER_URL,
    x402RequiredPaths: (process.env.X402_REQUIRED_PATHS ?? '/trade-intents').split(',').map((s) => s.trim()),
    x402PolicyFile: process.env.X402_POLICY_FILE ?? path.resolve(process.cwd(), 'config', 'x402-policy.json'),
  },
  autonomous: {
    enabled: parseBool(process.env.AUTONOMOUS_ENABLED, false),
    intervalMs: parseNumber(process.env.AUTONOMOUS_INTERVAL_MS, 30000),
    maxDrawdownStopPct: parseNumber(process.env.AUTONOMOUS_MAX_DRAWDOWN_STOP_PCT, 12),
    cooldownMs: parseNumber(process.env.AUTONOMOUS_COOLDOWN_MS, 120000),
    cooldownAfterFailures: parseNumber(process.env.AUTONOMOUS_COOLDOWN_AFTER_FAILURES, 2),
    defaultNotionalUsd: parseNumber(process.env.AUTONOMOUS_DEFAULT_NOTIONAL_USD, 100),
    minConfidence: parseNumber(process.env.AUTONOMOUS_MIN_CONFIDENCE, 0.15),
  },
  lending: {
    enabled: parseBool(process.env.LENDING_MONITOR_ENABLED, false),
    scanIntervalMs: parseNumber(process.env.LENDING_SCAN_INTERVAL_MS, 60000),
  },
  privacy: {
    encryptionEnabled: parseBool(process.env.PRIVACY_ENCRYPTION_ENABLED, false),
    serverSecret: process.env.PRIVACY_SERVER_SECRET ?? 'colosseum-default-secret-change-me',
  },
  arbitrage: {
    enabled: parseBool(process.env.ARBITRAGE_ENABLED, false),
    scanIntervalMs: parseNumber(process.env.ARBITRAGE_SCAN_INTERVAL_MS, 15000),
    minSpreadBps: parseNumber(process.env.ARBITRAGE_MIN_SPREAD_BPS, 30),
  },
  tokenRevenue: {
    baseUrl: process.env.CLAWPUMP_BASE_URL ?? 'https://www.clawpump.tech',
    apiKey: process.env.CLAWPUMP_API_KEY,
    healthPath: process.env.CLAWPUMP_HEALTH_PATH ?? '/api/health',
    launchPath: process.env.CLAWPUMP_LAUNCH_PATH ?? '/api/agents/launch',
    earningsPath: process.env.CLAWPUMP_EARNINGS_PATH ?? '/api/agents/earnings',
    timeoutMs: parseNumber(process.env.CLAWPUMP_TIMEOUT_MS, 12000),
    maxImageBytes: parseNumber(process.env.CLAWPUMP_MAX_IMAGE_BYTES, 2_000_000),
    launchAttemptHistoryLimit: parseNumber(process.env.CLAWPUMP_LAUNCH_HISTORY_LIMIT, 200),
  },
};

export type AppConfig = typeof config;
