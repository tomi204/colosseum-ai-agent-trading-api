/**
 * NFT Trading & Valuation Service
 *
 * Provides:
 * - NFT collection floor price tracking
 * - Rarity scoring algorithm
 * - NFT valuation model (floor price × rarity multiplier × trait premium)
 * - Collection analytics (volume, listings, holders, unique %)
 * - NFT portfolio tracker (track owned NFTs + estimated value)
 * - Wash trading detection for NFT markets
 */

import { StateStore } from '../infra/storage/stateStore.js';
import { isoNow } from '../utils/time.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface NftTrait {
  traitType: string;
  value: string;
  rarityPct: number;       // how rare this trait is (0-100, lower = rarer)
}

export interface NftItem {
  tokenId: string;
  collectionId: string;
  name: string;
  traits: NftTrait[];
  rarityScore: number;      // 0-100, higher = rarer
  lastSalePriceUsd: number;
  owner: string;
  listedPriceUsd: number | null;
  mintedAt: string;
}

export interface NftCollection {
  id: string;
  name: string;
  symbol: string;
  totalSupply: number;
  floorPriceUsd: number;
  floorPriceHistory: { ts: string; priceUsd: number }[];
  volumeLast24hUsd: number;
  volumeLast7dUsd: number;
  totalVolumeUsd: number;
  listedCount: number;
  holderCount: number;
  uniqueHolderPct: number;
  avgSalePriceUsd: number;
  createdAt: string;
  updatedAt: string;
}

export interface CollectionAnalytics {
  collectionId: string;
  name: string;
  floorPriceUsd: number;
  floorChange24hPct: number;
  floorChange7dPct: number;
  volumeLast24hUsd: number;
  volumeLast7dUsd: number;
  totalVolumeUsd: number;
  listedCount: number;
  listedPct: number;
  holderCount: number;
  uniqueHolderPct: number;
  avgHoldTimeDays: number;
  salesLast24h: number;
  avgSalePriceUsd: number;
  marketCapUsd: number;
  timestamp: string;
}

export interface NftValuation {
  tokenId: string;
  collectionId: string;
  floorPriceUsd: number;
  rarityScore: number;
  rarityMultiplier: number;
  traitPremiumPct: number;
  estimatedValueUsd: number;
  confidenceLevel: 'high' | 'medium' | 'low';
  methodology: string;
  components: {
    baseValue: number;
    rarityBonus: number;
    traitPremium: number;
  };
  timestamp: string;
}

export interface NftPortfolioItem {
  tokenId: string;
  collectionId: string;
  collectionName: string;
  name: string;
  estimatedValueUsd: number;
  acquisitionPriceUsd: number;
  unrealizedPnlUsd: number;
  unrealizedPnlPct: number;
  holdDays: number;
}

export interface NftPortfolio {
  agentId: string;
  items: NftPortfolioItem[];
  totalEstimatedValueUsd: number;
  totalAcquisitionCostUsd: number;
  totalUnrealizedPnlUsd: number;
  totalUnrealizedPnlPct: number;
  collectionBreakdown: { collectionId: string; name: string; count: number; valueUsd: number }[];
  timestamp: string;
}

export interface WashTradeSuspect {
  txId: string;
  buyer: string;
  seller: string;
  tokenId: string;
  priceUsd: number;
  reason: string;
  confidence: number;   // 0-100
  timestamp: string;
}

export interface WashTradingReport {
  collectionId: string;
  totalTransactions: number;
  suspectTransactions: number;
  washTradingPct: number;
  suspectedVolumeUsd: number;
  cleanVolumeUsd: number;
  suspects: WashTradeSuspect[];
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  indicators: string[];
  timestamp: string;
}

export interface NftValuationRequest {
  tokenId: string;
  collectionId: string;
  traits?: NftTrait[];
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function seededRng(seed: number): (i: number) => number {
  return (i: number) => ((seed * 9301 + 49297 + i * 233) % 233280) / 233280;
}

function seedFromString(str: string): number {
  return str.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function generateTraits(collectionId: string, tokenId: string): NftTrait[] {
  const seed = seedFromString(collectionId + tokenId);
  const rng = seededRng(seed);

  const traitTypes = ['Background', 'Body', 'Eyes', 'Mouth', 'Headwear', 'Clothing', 'Accessory'];
  const traitValues: Record<string, string[]> = {
    Background: ['Blue', 'Red', 'Gold', 'Purple', 'Black', 'White', 'Green', 'Rainbow'],
    Body: ['Normal', 'Zombie', 'Alien', 'Robot', 'Golden', 'Diamond'],
    Eyes: ['Normal', 'Laser', 'Sleepy', 'Hypnotized', 'Cyborg', '3D'],
    Mouth: ['Smile', 'Grin', 'Bored', 'Gold Teeth', 'Diamond Grillz'],
    Headwear: ['None', 'Crown', 'Beanie', 'Halo', 'Horns', 'Captain Hat'],
    Clothing: ['None', 'Suit', 'Hoodie', 'Leather Jacket', 'Lab Coat', 'Royal Robe'],
    Accessory: ['None', 'Chain', 'Earring', 'Monocle', 'Pipe', 'Sword'],
  };

  return traitTypes.map((traitType, idx) => {
    const values = traitValues[traitType];
    const valueIdx = Math.floor(rng(idx) * values.length);
    const value = values[valueIdx];
    // Rarer traits = lower index in the values array (after first)
    const rarityPct = ((valueIdx + 1) / values.length) * 100;
    return { traitType, value, rarityPct };
  });
}

function computeRarityScore(traits: NftTrait[]): number {
  if (traits.length === 0) return 50;
  // Average inverse of rarity percentages — lower rarityPct = rarer = higher score
  const avgInverseRarity = traits.reduce((s, t) => s + (100 - t.rarityPct), 0) / traits.length;
  return Number(clamp(avgInverseRarity, 0, 100).toFixed(2));
}

function computeRarityMultiplier(rarityScore: number): number {
  // Score 0-50: multiplier 1.0-1.5, Score 50-80: 1.5-3.0, Score 80-100: 3.0-10.0
  if (rarityScore <= 50) {
    return 1.0 + (rarityScore / 50) * 0.5;
  } else if (rarityScore <= 80) {
    return 1.5 + ((rarityScore - 50) / 30) * 1.5;
  }
  return 3.0 + ((rarityScore - 80) / 20) * 7.0;
}

function computeTraitPremium(traits: NftTrait[]): number {
  // Premium based on number of rare traits (< 20% rarity)
  const rareTraits = traits.filter((t) => t.rarityPct < 20);
  return rareTraits.length * 8; // 8% premium per rare trait
}

// ─── Service ────────────────────────────────────────────────────────────────

export class NftTradingService {
  private collections: Map<string, NftCollection> = new Map();
  private portfolios: Map<string, NftItem[]> = new Map();  // agentId -> items
  private transactions: Map<string, { txId: string; buyer: string; seller: string; tokenId: string; priceUsd: number; ts: string }[]> = new Map();

  constructor(private readonly store: StateStore) {
    this.seedDefaultCollections();
  }

  // ─── Seed Data ──────────────────────────────────────────────────────

  private seedDefaultCollections(): void {
    const now = isoNow();
    const collections: Omit<NftCollection, 'floorPriceHistory'>[] = [
      {
        id: 'mad-lads',
        name: 'Mad Lads',
        symbol: 'MADLADS',
        totalSupply: 10000,
        floorPriceUsd: 4200,
        volumeLast24hUsd: 185000,
        volumeLast7dUsd: 1250000,
        totalVolumeUsd: 45000000,
        listedCount: 320,
        holderCount: 5200,
        uniqueHolderPct: 52.0,
        avgSalePriceUsd: 4800,
        createdAt: '2023-04-21T00:00:00.000Z',
        updatedAt: now,
      },
      {
        id: 'tensorians',
        name: 'Tensorians',
        symbol: 'TNSR',
        totalSupply: 10000,
        floorPriceUsd: 850,
        volumeLast24hUsd: 92000,
        volumeLast7dUsd: 620000,
        totalVolumeUsd: 18500000,
        listedCount: 480,
        holderCount: 6100,
        uniqueHolderPct: 61.0,
        avgSalePriceUsd: 920,
        createdAt: '2023-07-06T00:00:00.000Z',
        updatedAt: now,
      },
      {
        id: 'claynosaurz',
        name: 'Claynosaurz',
        symbol: 'CLAY',
        totalSupply: 10000,
        floorPriceUsd: 520,
        volumeLast24hUsd: 45000,
        volumeLast7dUsd: 310000,
        totalVolumeUsd: 12000000,
        listedCount: 650,
        holderCount: 4800,
        uniqueHolderPct: 48.0,
        avgSalePriceUsd: 600,
        createdAt: '2022-11-01T00:00:00.000Z',
        updatedAt: now,
      },
      {
        id: 'smb-gen2',
        name: 'Solana Monkey Business Gen2',
        symbol: 'SMB',
        totalSupply: 5000,
        floorPriceUsd: 1800,
        volumeLast24hUsd: 65000,
        volumeLast7dUsd: 420000,
        totalVolumeUsd: 28000000,
        listedCount: 180,
        holderCount: 2800,
        uniqueHolderPct: 56.0,
        avgSalePriceUsd: 2100,
        createdAt: '2021-09-01T00:00:00.000Z',
        updatedAt: now,
      },
      {
        id: 'famous-fox',
        name: 'Famous Fox Federation',
        symbol: 'FFF',
        totalSupply: 7777,
        floorPriceUsd: 280,
        volumeLast24hUsd: 28000,
        volumeLast7dUsd: 180000,
        totalVolumeUsd: 8500000,
        listedCount: 520,
        holderCount: 3900,
        uniqueHolderPct: 50.1,
        avgSalePriceUsd: 340,
        createdAt: '2022-01-15T00:00:00.000Z',
        updatedAt: now,
      },
    ];

    for (const col of collections) {
      const seed = seedFromString(col.id);
      const rng = seededRng(seed);
      // Generate floor price history (30 data points)
      const history: { ts: string; priceUsd: number }[] = [];
      const baseTs = Date.now();
      for (let i = 0; i < 30; i++) {
        const dayOffset = (30 - i) * 86400000;
        const variance = (rng(i) - 0.5) * col.floorPriceUsd * 0.1;
        history.push({
          ts: new Date(baseTs - dayOffset).toISOString(),
          priceUsd: Number(Math.max(1, col.floorPriceUsd + variance).toFixed(2)),
        });
      }
      // Add current price at end
      history.push({ ts: now, priceUsd: col.floorPriceUsd });

      this.collections.set(col.id, { ...col, floorPriceHistory: history });

      // Generate synthetic transactions for wash trading detection
      this.generateSyntheticTransactions(col.id, col.floorPriceUsd);
    }
  }

  private generateSyntheticTransactions(
    collectionId: string,
    floorPrice: number,
  ): void {
    const seed = seedFromString(collectionId + 'tx');
    const rng = seededRng(seed);
    const txs: { txId: string; buyer: string; seller: string; tokenId: string; priceUsd: number; ts: string }[] = [];
    const now = Date.now();

    for (let i = 0; i < 50; i++) {
      const buyer = `wallet_${String(Math.floor(rng(i * 3) * 20)).padStart(3, '0')}`;
      const seller = `wallet_${String(Math.floor(rng(i * 3 + 1) * 20)).padStart(3, '0')}`;
      const priceVariance = (rng(i * 3 + 2) - 0.3) * floorPrice * 0.5;
      const price = Math.max(floorPrice * 0.5, floorPrice + priceVariance);

      txs.push({
        txId: `tx_${collectionId}_${i}`,
        buyer,
        seller: buyer === seller ? `wallet_${String(Math.floor(rng(i * 3 + 1) * 20) + 1).padStart(3, '0')}` : seller,
        tokenId: `${collectionId}_token_${Math.floor(rng(i) * 1000)}`,
        priceUsd: Number(price.toFixed(2)),
        ts: new Date(now - Math.floor(rng(i * 5) * 7 * 86400000)).toISOString(),
      });
    }

    // Inject some obvious wash trades (same buyer/seller patterns)
    const washWallet1 = 'wallet_wash_001';
    const washWallet2 = 'wallet_wash_002';
    for (let i = 0; i < 5; i++) {
      const ts = new Date(now - Math.floor(rng(100 + i) * 3 * 86400000)).toISOString();
      txs.push({
        txId: `tx_wash_${collectionId}_${i}a`,
        buyer: washWallet1,
        seller: washWallet2,
        tokenId: `${collectionId}_wash_token_${i}`,
        priceUsd: floorPrice * 1.5,
        ts,
      });
      txs.push({
        txId: `tx_wash_${collectionId}_${i}b`,
        buyer: washWallet2,
        seller: washWallet1,
        tokenId: `${collectionId}_wash_token_${i}`,
        priceUsd: floorPrice * 1.6,
        ts,
      });
    }

    this.transactions.set(collectionId, txs);
  }

  // ─── Collections ────────────────────────────────────────────────────

  listCollections(): NftCollection[] {
    return Array.from(this.collections.values());
  }

  getCollection(collectionId: string): NftCollection | undefined {
    return this.collections.get(collectionId);
  }

  getFloorPrice(collectionId: string): { collectionId: string; floorPriceUsd: number; floorPriceHistory: { ts: string; priceUsd: number }[]; change24hPct: number; change7dPct: number; timestamp: string } | undefined {
    const collection = this.collections.get(collectionId);
    if (!collection) return undefined;

    const history = collection.floorPriceHistory;
    const current = collection.floorPriceUsd;

    // Calculate changes
    const dayAgoIdx = Math.max(0, history.length - 2);
    const weekAgoIdx = Math.max(0, history.length - 8);
    const dayAgoPrice = history[dayAgoIdx]?.priceUsd ?? current;
    const weekAgoPrice = history[weekAgoIdx]?.priceUsd ?? current;

    const change24hPct = dayAgoPrice > 0
      ? Number((((current - dayAgoPrice) / dayAgoPrice) * 100).toFixed(2))
      : 0;
    const change7dPct = weekAgoPrice > 0
      ? Number((((current - weekAgoPrice) / weekAgoPrice) * 100).toFixed(2))
      : 0;

    return {
      collectionId,
      floorPriceUsd: current,
      floorPriceHistory: history.slice(-30),
      change24hPct,
      change7dPct,
      timestamp: isoNow(),
    };
  }

  // ─── Collection Analytics ───────────────────────────────────────────

  getCollectionAnalytics(collectionId: string): CollectionAnalytics | undefined {
    const collection = this.collections.get(collectionId);
    if (!collection) return undefined;

    const history = collection.floorPriceHistory;
    const current = collection.floorPriceUsd;

    const dayAgoIdx = Math.max(0, history.length - 2);
    const weekAgoIdx = Math.max(0, history.length - 8);
    const dayAgoPrice = history[dayAgoIdx]?.priceUsd ?? current;
    const weekAgoPrice = history[weekAgoIdx]?.priceUsd ?? current;

    const floorChange24hPct = dayAgoPrice > 0
      ? Number((((current - dayAgoPrice) / dayAgoPrice) * 100).toFixed(2))
      : 0;
    const floorChange7dPct = weekAgoPrice > 0
      ? Number((((current - weekAgoPrice) / weekAgoPrice) * 100).toFixed(2))
      : 0;

    const listedPct = collection.totalSupply > 0
      ? Number(((collection.listedCount / collection.totalSupply) * 100).toFixed(2))
      : 0;

    const seed = seedFromString(collectionId);
    const rng = seededRng(seed);
    const avgHoldTimeDays = Number((30 + rng(42) * 150).toFixed(1));
    const salesLast24h = Math.floor(collection.volumeLast24hUsd / collection.avgSalePriceUsd);
    const marketCapUsd = Number((collection.floorPriceUsd * collection.totalSupply).toFixed(2));

    return {
      collectionId,
      name: collection.name,
      floorPriceUsd: current,
      floorChange24hPct,
      floorChange7dPct,
      volumeLast24hUsd: collection.volumeLast24hUsd,
      volumeLast7dUsd: collection.volumeLast7dUsd,
      totalVolumeUsd: collection.totalVolumeUsd,
      listedCount: collection.listedCount,
      listedPct,
      holderCount: collection.holderCount,
      uniqueHolderPct: collection.uniqueHolderPct,
      avgHoldTimeDays,
      salesLast24h,
      avgSalePriceUsd: collection.avgSalePriceUsd,
      marketCapUsd,
      timestamp: isoNow(),
    };
  }

  // ─── NFT Valuation ──────────────────────────────────────────────────

  valuateNft(request: NftValuationRequest): NftValuation | undefined {
    const collection = this.collections.get(request.collectionId);
    if (!collection) return undefined;

    const traits = request.traits ?? generateTraits(request.collectionId, request.tokenId);
    const rarityScore = computeRarityScore(traits);
    const rarityMultiplier = computeRarityMultiplier(rarityScore);
    const traitPremiumPct = computeTraitPremium(traits);

    const baseValue = collection.floorPriceUsd;
    const rarityBonus = baseValue * (rarityMultiplier - 1);
    const traitPremium = baseValue * (traitPremiumPct / 100);
    const estimatedValueUsd = Number((baseValue + rarityBonus + traitPremium).toFixed(2));

    // Confidence based on data quality
    const txCount = this.transactions.get(request.collectionId)?.length ?? 0;
    const confidenceLevel: NftValuation['confidenceLevel'] =
      txCount >= 40 ? 'high' : txCount >= 20 ? 'medium' : 'low';

    return {
      tokenId: request.tokenId,
      collectionId: request.collectionId,
      floorPriceUsd: baseValue,
      rarityScore,
      rarityMultiplier: Number(rarityMultiplier.toFixed(4)),
      traitPremiumPct,
      estimatedValueUsd,
      confidenceLevel,
      methodology: 'floor_price × rarity_multiplier + trait_premium',
      components: {
        baseValue,
        rarityBonus: Number(rarityBonus.toFixed(2)),
        traitPremium: Number(traitPremium.toFixed(2)),
      },
      timestamp: isoNow(),
    };
  }

  // ─── Portfolio ──────────────────────────────────────────────────────

  getPortfolio(agentId: string): NftPortfolio {
    const items = this.portfolios.get(agentId) ?? [];
    if (items.length === 0) {
      // Seed a sample portfolio for demo purposes
      this.seedPortfolio(agentId);
    }

    const portfolioItems = (this.portfolios.get(agentId) ?? []).map((item) => {
      const valuation = this.valuateNft({
        tokenId: item.tokenId,
        collectionId: item.collectionId,
        traits: item.traits,
      });
      const estimatedValueUsd = valuation?.estimatedValueUsd ?? item.lastSalePriceUsd;
      const acquisitionPriceUsd = item.lastSalePriceUsd;
      const unrealizedPnlUsd = Number((estimatedValueUsd - acquisitionPriceUsd).toFixed(2));
      const unrealizedPnlPct = acquisitionPriceUsd > 0
        ? Number(((unrealizedPnlUsd / acquisitionPriceUsd) * 100).toFixed(2))
        : 0;
      const holdDays = Math.floor(
        (Date.now() - new Date(item.mintedAt).getTime()) / 86400000,
      );

      const collection = this.collections.get(item.collectionId);

      return {
        tokenId: item.tokenId,
        collectionId: item.collectionId,
        collectionName: collection?.name ?? item.collectionId,
        name: item.name,
        estimatedValueUsd,
        acquisitionPriceUsd,
        unrealizedPnlUsd,
        unrealizedPnlPct,
        holdDays,
      };
    });

    const totalEstimatedValueUsd = Number(
      portfolioItems.reduce((s, i) => s + i.estimatedValueUsd, 0).toFixed(2),
    );
    const totalAcquisitionCostUsd = Number(
      portfolioItems.reduce((s, i) => s + i.acquisitionPriceUsd, 0).toFixed(2),
    );
    const totalUnrealizedPnlUsd = Number((totalEstimatedValueUsd - totalAcquisitionCostUsd).toFixed(2));
    const totalUnrealizedPnlPct = totalAcquisitionCostUsd > 0
      ? Number(((totalUnrealizedPnlUsd / totalAcquisitionCostUsd) * 100).toFixed(2))
      : 0;

    // Group by collection
    const collectionMap = new Map<string, { name: string; count: number; valueUsd: number }>();
    for (const item of portfolioItems) {
      const existing = collectionMap.get(item.collectionId) ?? {
        name: item.collectionName,
        count: 0,
        valueUsd: 0,
      };
      existing.count += 1;
      existing.valueUsd = Number((existing.valueUsd + item.estimatedValueUsd).toFixed(2));
      collectionMap.set(item.collectionId, existing);
    }

    const collectionBreakdown = Array.from(collectionMap.entries()).map(([collectionId, data]) => ({
      collectionId,
      ...data,
    }));

    return {
      agentId,
      items: portfolioItems,
      totalEstimatedValueUsd,
      totalAcquisitionCostUsd,
      totalUnrealizedPnlUsd,
      totalUnrealizedPnlPct,
      collectionBreakdown,
      timestamp: isoNow(),
    };
  }

  private seedPortfolio(agentId: string): void {
    const seed = seedFromString(agentId);
    const rng = seededRng(seed);
    const collectionIds = Array.from(this.collections.keys());
    const items: NftItem[] = [];

    // Give agent 3-6 NFTs across different collections
    const nftCount = 3 + Math.floor(rng(0) * 4);
    for (let i = 0; i < nftCount; i++) {
      const colIdx = Math.floor(rng(i + 1) * collectionIds.length);
      const collectionId = collectionIds[colIdx];
      const collection = this.collections.get(collectionId)!;
      const tokenId = `${collectionId}_${Math.floor(rng(i + 10) * collection.totalSupply)}`;
      const traits = generateTraits(collectionId, tokenId);
      const buyDiscount = 0.8 + rng(i + 20) * 0.4; // bought at 80%-120% of floor

      items.push({
        tokenId,
        collectionId,
        name: `${collection.name} #${Math.floor(rng(i + 10) * collection.totalSupply)}`,
        traits,
        rarityScore: computeRarityScore(traits),
        lastSalePriceUsd: Number((collection.floorPriceUsd * buyDiscount).toFixed(2)),
        owner: agentId,
        listedPriceUsd: null,
        mintedAt: new Date(Date.now() - Math.floor(rng(i + 30) * 180 * 86400000)).toISOString(),
      });
    }

    this.portfolios.set(agentId, items);
  }

  // ─── Wash Trading Detection ─────────────────────────────────────────

  detectWashTrading(collectionId: string): WashTradingReport | undefined {
    const collection = this.collections.get(collectionId);
    if (!collection) return undefined;

    const txs = this.transactions.get(collectionId) ?? [];
    if (txs.length === 0) {
      return {
        collectionId,
        totalTransactions: 0,
        suspectTransactions: 0,
        washTradingPct: 0,
        suspectedVolumeUsd: 0,
        cleanVolumeUsd: 0,
        suspects: [],
        riskLevel: 'low',
        indicators: ['No transactions found for analysis'],
        timestamp: isoNow(),
      };
    }

    const suspects: WashTradeSuspect[] = [];

    // Detection heuristics:

    // 1. Reciprocal trades: A sells to B, then B sells back to A
    const pairMap = new Map<string, { txId: string; tokenId: string; priceUsd: number; ts: string }[]>();
    for (const tx of txs) {
      const key = `${tx.buyer}:${tx.seller}`;
      const existing = pairMap.get(key) ?? [];
      existing.push({ txId: tx.txId, tokenId: tx.tokenId, priceUsd: tx.priceUsd, ts: tx.ts });
      pairMap.set(key, existing);
    }

    for (const tx of txs) {
      const reverseKey = `${tx.seller}:${tx.buyer}`;
      const reverseTxs = pairMap.get(reverseKey);
      if (reverseTxs && reverseTxs.length > 0) {
        // Check if any reverse tx involves the same token
        const sameToken = reverseTxs.find((r) => r.tokenId === tx.tokenId);
        if (sameToken) {
          suspects.push({
            txId: tx.txId,
            buyer: tx.buyer,
            seller: tx.seller,
            tokenId: tx.tokenId,
            priceUsd: tx.priceUsd,
            reason: 'Reciprocal trade detected: same NFT traded back between same wallets',
            confidence: 95,
            timestamp: tx.ts,
          });
          continue;
        }
        // Even without same token, flag if frequent reciprocal pattern
        if (reverseTxs.length >= 2) {
          suspects.push({
            txId: tx.txId,
            buyer: tx.buyer,
            seller: tx.seller,
            tokenId: tx.tokenId,
            priceUsd: tx.priceUsd,
            reason: 'Frequent reciprocal trading pattern between wallets',
            confidence: 70,
            timestamp: tx.ts,
          });
        }
      }
    }

    // 2. Above-floor-price trades that seem artificial
    for (const tx of txs) {
      if (tx.priceUsd > collection.floorPriceUsd * 2.5) {
        const isAlreadySuspect = suspects.some((s) => s.txId === tx.txId);
        if (!isAlreadySuspect) {
          suspects.push({
            txId: tx.txId,
            buyer: tx.buyer,
            seller: tx.seller,
            tokenId: tx.tokenId,
            priceUsd: tx.priceUsd,
            reason: 'Significantly above floor price — potential volume inflation',
            confidence: 45,
            timestamp: tx.ts,
          });
        }
      }
    }

    // Deduplicate by txId
    const uniqueSuspects = Array.from(
      new Map(suspects.map((s) => [s.txId, s])).values(),
    );

    const suspectedVolumeUsd = Number(
      uniqueSuspects.reduce((s, t) => s + t.priceUsd, 0).toFixed(2),
    );
    const totalVolumeUsd = txs.reduce((s, t) => s + t.priceUsd, 0);
    const cleanVolumeUsd = Number(Math.max(0, totalVolumeUsd - suspectedVolumeUsd).toFixed(2));
    const washTradingPct = totalVolumeUsd > 0
      ? Number(((suspectedVolumeUsd / totalVolumeUsd) * 100).toFixed(2))
      : 0;

    const indicators: string[] = [];
    if (washTradingPct > 30) indicators.push('High percentage of suspected wash trades');
    if (uniqueSuspects.filter((s) => s.confidence >= 90).length > 3) {
      indicators.push('Multiple high-confidence wash trade detections');
    }
    if (uniqueSuspects.some((s) => s.reason.includes('Reciprocal'))) {
      indicators.push('Reciprocal trading patterns detected');
    }
    if (indicators.length === 0) indicators.push('No significant wash trading indicators');

    const riskLevel: WashTradingReport['riskLevel'] =
      washTradingPct >= 50 ? 'critical' :
        washTradingPct >= 30 ? 'high' :
          washTradingPct >= 15 ? 'medium' : 'low';

    return {
      collectionId,
      totalTransactions: txs.length,
      suspectTransactions: uniqueSuspects.length,
      washTradingPct,
      suspectedVolumeUsd,
      cleanVolumeUsd,
      suspects: uniqueSuspects,
      riskLevel,
      indicators,
      timestamp: isoNow(),
    };
  }
}
