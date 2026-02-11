import { StateStore } from '../infra/storage/stateStore.js';
import { IntentStatus, TradeIntent } from '../types.js';

export interface OrderBookLevel {
  priceUsd: number;
  totalNotionalUsd: number;
  intentCount: number;
}

export interface OrderBookSnapshot {
  symbol: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  totalBidNotionalUsd: number;
  totalAskNotionalUsd: number;
  pendingIntentCount: number;
  asOf: string;
}

export interface IntentFlowBucket {
  window: string;
  submitted: number;
  processing: number;
  executed: number;
  rejected: number;
  failed: number;
}

export interface IntentFlowStats {
  windows: IntentFlowBucket[];
  asOf: string;
}

const FLOW_WINDOWS: { label: string; ms: number }[] = [
  { label: '1m', ms: 60_000 },
  { label: '5m', ms: 5 * 60_000 },
  { label: '15m', ms: 15 * 60_000 },
  { label: '1h', ms: 60 * 60_000 },
];

const PRICE_BUCKET_PCT = 0.005; // 0.5% price buckets

export class OrderBookService {
  constructor(private readonly store: StateStore) {}

  getDepth(symbol: string): OrderBookSnapshot {
    const state = this.store.snapshot();
    const normalizedSymbol = symbol.toUpperCase();

    const intents = Object.values(state.tradeIntents).filter(
      (intent) => intent.symbol === normalizedSymbol && intent.status === 'pending',
    );

    const currentPrice = state.marketPricesUsd[normalizedSymbol] ?? 0;

    const bidIntents = intents.filter((i) => i.side === 'buy');
    const askIntents = intents.filter((i) => i.side === 'sell');

    const bids = this.aggregateLevels(bidIntents, currentPrice, 'buy');
    const asks = this.aggregateLevels(askIntents, currentPrice, 'sell');

    const totalBidNotionalUsd = bids.reduce((sum, l) => sum + l.totalNotionalUsd, 0);
    const totalAskNotionalUsd = asks.reduce((sum, l) => sum + l.totalNotionalUsd, 0);

    return {
      symbol: normalizedSymbol,
      bids,
      asks,
      totalBidNotionalUsd: Number(totalBidNotionalUsd.toFixed(8)),
      totalAskNotionalUsd: Number(totalAskNotionalUsd.toFixed(8)),
      pendingIntentCount: intents.length,
      asOf: new Date().toISOString(),
    };
  }

  getFlow(): IntentFlowStats {
    const state = this.store.snapshot();
    const allIntents = Object.values(state.tradeIntents);
    const now = Date.now();

    const windows: IntentFlowBucket[] = FLOW_WINDOWS.map(({ label, ms }) => {
      const cutoff = now - ms;
      const bucket: IntentFlowBucket = {
        window: label,
        submitted: 0,
        processing: 0,
        executed: 0,
        rejected: 0,
        failed: 0,
      };

      for (const intent of allIntents) {
        const intentTs = new Date(intent.updatedAt).getTime();
        if (intentTs < cutoff) continue;

        this.countStatus(bucket, intent.status);
      }

      return bucket;
    });

    return {
      windows,
      asOf: new Date().toISOString(),
    };
  }

  private countStatus(bucket: IntentFlowBucket, status: IntentStatus): void {
    switch (status) {
      case 'pending':
        bucket.submitted += 1;
        break;
      case 'processing':
        bucket.processing += 1;
        break;
      case 'executed':
        bucket.executed += 1;
        break;
      case 'rejected':
        bucket.rejected += 1;
        break;
      case 'failed':
        bucket.failed += 1;
        break;
    }
  }

  private aggregateLevels(
    intents: TradeIntent[],
    basePrice: number,
    _side: 'buy' | 'sell',
  ): OrderBookLevel[] {
    if (intents.length === 0 || basePrice <= 0) return [];

    const bucketSize = basePrice * PRICE_BUCKET_PCT;
    const levelMap = new Map<number, OrderBookLevel>();

    for (const intent of intents) {
      const notional = intent.notionalUsd ?? 0;
      const estimatedPrice = notional > 0 && intent.quantity
        ? notional / intent.quantity
        : basePrice;

      const bucketKey = Math.round(estimatedPrice / bucketSize) * bucketSize;
      const roundedKey = Number(bucketKey.toFixed(8));

      const existing = levelMap.get(roundedKey);
      if (existing) {
        existing.totalNotionalUsd += notional;
        existing.intentCount += 1;
      } else {
        levelMap.set(roundedKey, {
          priceUsd: roundedKey,
          totalNotionalUsd: notional,
          intentCount: 1,
        });
      }
    }

    return Array.from(levelMap.values())
      .sort((a, b) => b.priceUsd - a.priceUsd)
      .map((level) => ({
        ...level,
        totalNotionalUsd: Number(level.totalNotionalUsd.toFixed(8)),
      }));
  }
}
