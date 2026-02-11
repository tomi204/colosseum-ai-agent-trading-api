import fs from 'node:fs/promises';
import path from 'node:path';
import {
  Agent,
  AppState,
  ExecutionRecord,
  ExecutionReceipt,
  IdempotencyRecord,
  TradeIntent,
} from '../../types.js';
import { hashObject, sha256Hex } from '../../utils/hash.js';
import { createDefaultState } from './defaultState.js';

const receiptPayloadFromExecution = (execution: ExecutionRecord): ExecutionReceipt['payload'] => ({
  executionId: execution.id,
  intentId: execution.intentId,
  agentId: execution.agentId,
  symbol: execution.symbol,
  side: execution.side,
  quantity: execution.quantity,
  priceUsd: execution.priceUsd,
  grossNotionalUsd: execution.grossNotionalUsd,
  feeUsd: execution.feeUsd,
  netUsd: execution.netUsd,
  realizedPnlUsd: execution.realizedPnlUsd,
  pnlSnapshotUsd: execution.pnlSnapshotUsd,
  mode: execution.mode,
  status: execution.status,
  failureReason: execution.failureReason,
  txSignature: execution.txSignature,
  timestamp: execution.createdAt,
});

const receiptMessage = (version: ExecutionReceipt['version'], payloadHash: string, prevReceiptHash?: string): string => (
  `${version}|${payloadHash}|${prevReceiptHash ?? 'GENESIS'}`
);

const normalizeState = (raw: unknown): AppState => {
  const defaults = createDefaultState();
  const parsed = (raw && typeof raw === 'object' ? raw : {}) as Partial<AppState> & {
    tradeIntentIdempotency?: Record<string, string>;
  };

  const agents = Object.fromEntries(
    Object.entries(parsed.agents ?? {}).map(([id, agent]) => {
      const typed = agent as Agent;
      return [id, {
        ...typed,
        strategyId: typed.strategyId ?? 'momentum-v1',
        dailyRealizedPnlUsd: typed.dailyRealizedPnlUsd ?? {},
        riskRejectionsByReason: typed.riskRejectionsByReason ?? {},
      } satisfies Agent];
    }),
  );

  const executions: Record<string, ExecutionRecord> = Object.fromEntries(
    Object.entries(parsed.executions ?? {}).map(([id, execution]) => {
      const typed = execution as ExecutionRecord;
      return [id, {
        ...typed,
        pnlSnapshotUsd: Number((typed.pnlSnapshotUsd ?? typed.realizedPnlUsd ?? 0).toFixed(8)),
      } satisfies ExecutionRecord];
    }),
  );

  const tradeIntents = Object.fromEntries(
    Object.entries(parsed.tradeIntents ?? {}).map(([id, intent]) => {
      const typed = intent as TradeIntent;
      return [id, {
        ...typed,
        symbol: typed.symbol.toUpperCase(),
      } satisfies TradeIntent];
    }),
  );

  const executionReceipts = Object.fromEntries(
    Object.entries(parsed.executionReceipts ?? {}).map(([id, receipt]) => {
      const typed = (receipt ?? {}) as Partial<ExecutionReceipt>;
      const execution = executions[id];
      const payload = typed.payload
        ?? (execution ? receiptPayloadFromExecution(execution) : {
          executionId: id,
          intentId: 'unknown',
          agentId: 'unknown',
          symbol: 'UNKNOWN',
          side: 'buy',
          quantity: 0,
          priceUsd: 0,
          grossNotionalUsd: 0,
          feeUsd: 0,
          netUsd: 0,
          realizedPnlUsd: 0,
          pnlSnapshotUsd: 0,
          mode: 'paper',
          status: 'failed',
          timestamp: typed.createdAt ?? defaults.metrics.startedAt,
        });

      const version: ExecutionReceipt['version'] = typed.version ?? 'v1';
      const prevReceiptHash = typed.prevReceiptHash;
      const payloadHash = typed.payloadHash ?? hashObject(payload);
      const message = receiptMessage(version, payloadHash, prevReceiptHash);
      const receiptHash = typed.receiptHash ?? sha256Hex(message);

      return [id, {
        version,
        executionId: typed.executionId ?? id,
        payload,
        payloadHash,
        prevReceiptHash,
        receiptHash,
        signaturePayload: typed.signaturePayload ?? {
          scheme: 'colosseum-receipt-signature-v1',
          message,
          messageHash: receiptHash,
        },
        createdAt: typed.createdAt ?? execution?.createdAt ?? defaults.metrics.startedAt,
      } satisfies ExecutionReceipt];
    }),
  );

  const legacyIdempotency = parsed.tradeIntentIdempotency ?? {};
  const idempotencyRecords: Record<string, IdempotencyRecord> = {
    ...Object.fromEntries(
      Object.entries(legacyIdempotency).flatMap(([compoundKey, intentId]) => {
        const intent = tradeIntents[intentId];
        if (!intent) return [];

        const [agentId, ...keyParts] = compoundKey.split(':');
        const key = keyParts.join(':') || compoundKey;
        const requestHash = intent.requestHash ?? hashObject({
          agentId: intent.agentId,
          symbol: intent.symbol,
          side: intent.side,
          quantity: intent.quantity,
          notionalUsd: intent.notionalUsd,
          requestedMode: intent.requestedMode,
          meta: intent.meta,
        });

        return [[compoundKey, {
          key,
          agentId: agentId || intent.agentId,
          requestHash,
          intentId,
          createdAt: intent.createdAt,
        } satisfies IdempotencyRecord]];
      }),
    ),
    ...(parsed.idempotencyRecords ?? {}),
  };

  return {
    ...defaults,
    ...parsed,
    agents,
    tradeIntents,
    executions,
    executionReceipts,
    idempotencyRecords,
    marketPriceHistoryUsd: parsed.marketPriceHistoryUsd ?? defaults.marketPriceHistoryUsd,
    tokenRevenue: {
      clawpumpLaunchAttempts: parsed.tokenRevenue?.clawpumpLaunchAttempts ?? defaults.tokenRevenue.clawpumpLaunchAttempts,
    },
    metrics: {
      ...defaults.metrics,
      ...(parsed.metrics ?? {}),
      riskRejectionsByReason: parsed.metrics?.riskRejectionsByReason ?? {},
    },
  };
};

export class StateStore {
  private state: AppState = createDefaultState();
  private lock: Promise<void> = Promise.resolve();

  constructor(private readonly stateFilePath: string) {}

  async init(): Promise<void> {
    await fs.mkdir(path.dirname(this.stateFilePath), { recursive: true });

    try {
      const raw = await fs.readFile(this.stateFilePath, 'utf-8');
      this.state = normalizeState(JSON.parse(raw));
    } catch {
      this.state = createDefaultState();
      await this.persist();
    }
  }

  snapshot(): AppState {
    return structuredClone(this.state);
  }

  async transaction<T>(work: (state: AppState) => Promise<T> | T): Promise<T> {
    const previous = this.lock;
    let release: () => void = () => {};

    this.lock = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      const result = await work(this.state);
      await this.persist();
      return result;
    } finally {
      release();
    }
  }

  async flush(): Promise<void> {
    await this.lock;
    await this.persist();
  }

  private async persist(): Promise<void> {
    await fs.writeFile(this.stateFilePath, JSON.stringify(this.state, null, 2));
  }
}
