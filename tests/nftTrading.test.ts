import { describe, expect, it, beforeEach } from 'vitest';
import { vi } from 'vitest';
import {
  NftTradingService,
  NftCollection,
  CollectionAnalytics,
  NftValuation,
  NftPortfolio,
  WashTradingReport,
} from '../src/services/nftTradingService.js';
import { AppState } from '../src/types.js';
import { createDefaultState } from '../src/infra/storage/defaultState.js';

function createMockStore(state: AppState) {
  return {
    snapshot: () => structuredClone(state),
    transaction: vi.fn(),
    init: vi.fn(),
    flush: vi.fn(),
  } as any;
}

describe('NftTradingService', () => {
  let service: NftTradingService;
  let state: AppState;

  beforeEach(() => {
    state = createDefaultState();
    const store = createMockStore(state);
    service = new NftTradingService(store);
  });

  // ─── Collection Listing ──────────────────────────────────────────────

  it('lists all seeded collections', () => {
    const collections = service.listCollections();
    expect(collections.length).toBeGreaterThanOrEqual(5);
    for (const col of collections) {
      expect(col.id).toBeDefined();
      expect(col.name).toBeDefined();
      expect(col.symbol).toBeDefined();
      expect(col.totalSupply).toBeGreaterThan(0);
      expect(col.floorPriceUsd).toBeGreaterThan(0);
    }
  });

  it('returns a specific collection by id', () => {
    const col = service.getCollection('mad-lads');
    expect(col).toBeDefined();
    expect(col!.id).toBe('mad-lads');
    expect(col!.name).toBe('Mad Lads');
    expect(col!.floorPriceUsd).toBe(4200);
  });

  it('returns undefined for unknown collection', () => {
    const col = service.getCollection('nonexistent');
    expect(col).toBeUndefined();
  });

  // ─── Floor Price ─────────────────────────────────────────────────────

  it('returns floor price with history and changes', () => {
    const floor = service.getFloorPrice('mad-lads');
    expect(floor).toBeDefined();
    expect(floor!.collectionId).toBe('mad-lads');
    expect(floor!.floorPriceUsd).toBe(4200);
    expect(floor!.floorPriceHistory.length).toBeGreaterThan(0);
    expect(floor!.floorPriceHistory.length).toBeLessThanOrEqual(30);
    expect(typeof floor!.change24hPct).toBe('number');
    expect(typeof floor!.change7dPct).toBe('number');
    expect(floor!.timestamp).toBeDefined();
  });

  it('returns undefined floor price for unknown collection', () => {
    const floor = service.getFloorPrice('nonexistent');
    expect(floor).toBeUndefined();
  });

  // ─── Collection Analytics ────────────────────────────────────────────

  it('returns collection analytics with all fields', () => {
    const analytics: CollectionAnalytics | undefined = service.getCollectionAnalytics('tensorians');
    expect(analytics).toBeDefined();
    expect(analytics!.collectionId).toBe('tensorians');
    expect(analytics!.name).toBe('Tensorians');
    expect(analytics!.floorPriceUsd).toBe(850);
    expect(typeof analytics!.floorChange24hPct).toBe('number');
    expect(typeof analytics!.floorChange7dPct).toBe('number');
    expect(analytics!.volumeLast24hUsd).toBeGreaterThan(0);
    expect(analytics!.volumeLast7dUsd).toBeGreaterThan(0);
    expect(analytics!.totalVolumeUsd).toBeGreaterThan(0);
    expect(analytics!.listedCount).toBeGreaterThan(0);
    expect(analytics!.listedPct).toBeGreaterThan(0);
    expect(analytics!.listedPct).toBeLessThanOrEqual(100);
    expect(analytics!.holderCount).toBeGreaterThan(0);
    expect(analytics!.uniqueHolderPct).toBeGreaterThan(0);
    expect(analytics!.avgHoldTimeDays).toBeGreaterThan(0);
    expect(analytics!.salesLast24h).toBeGreaterThanOrEqual(0);
    expect(analytics!.marketCapUsd).toBeGreaterThan(0);
    expect(analytics!.timestamp).toBeDefined();
  });

  it('marketCap equals floor price times total supply', () => {
    const analytics = service.getCollectionAnalytics('mad-lads')!;
    expect(analytics.marketCapUsd).toBe(4200 * 10000);
  });

  // ─── NFT Valuation ──────────────────────────────────────────────────

  it('valuates an NFT with floor × rarity × trait model', () => {
    const valuation: NftValuation | undefined = service.valuateNft({
      tokenId: 'mad-lads_42',
      collectionId: 'mad-lads',
    });
    expect(valuation).toBeDefined();
    expect(valuation!.tokenId).toBe('mad-lads_42');
    expect(valuation!.collectionId).toBe('mad-lads');
    expect(valuation!.floorPriceUsd).toBe(4200);
    expect(valuation!.rarityScore).toBeGreaterThanOrEqual(0);
    expect(valuation!.rarityScore).toBeLessThanOrEqual(100);
    expect(valuation!.rarityMultiplier).toBeGreaterThanOrEqual(1);
    expect(valuation!.estimatedValueUsd).toBeGreaterThanOrEqual(valuation!.floorPriceUsd);
    expect(valuation!.confidenceLevel).toBeDefined();
    expect(['high', 'medium', 'low']).toContain(valuation!.confidenceLevel);
    expect(valuation!.methodology).toContain('floor_price');
    expect(valuation!.components.baseValue).toBe(4200);
    expect(valuation!.components.rarityBonus).toBeGreaterThanOrEqual(0);
    expect(valuation!.timestamp).toBeDefined();
  });

  it('valuation is deterministic for same token', () => {
    const v1 = service.valuateNft({ tokenId: 'test_1', collectionId: 'tensorians' });
    const v2 = service.valuateNft({ tokenId: 'test_1', collectionId: 'tensorians' });
    expect(v1!.estimatedValueUsd).toBe(v2!.estimatedValueUsd);
    expect(v1!.rarityScore).toBe(v2!.rarityScore);
  });

  it('returns undefined valuation for unknown collection', () => {
    const valuation = service.valuateNft({ tokenId: 'x', collectionId: 'nonexistent' });
    expect(valuation).toBeUndefined();
  });

  it('accepts custom traits for valuation', () => {
    const valuation = service.valuateNft({
      tokenId: 'custom_1',
      collectionId: 'mad-lads',
      traits: [
        { traitType: 'Background', value: 'Rainbow', rarityPct: 5 },
        { traitType: 'Body', value: 'Diamond', rarityPct: 2 },
      ],
    });
    expect(valuation).toBeDefined();
    // Very rare traits should give high rarity score
    expect(valuation!.rarityScore).toBeGreaterThan(90);
    // Should have significant trait premium (both traits < 20% rarity)
    expect(valuation!.traitPremiumPct).toBe(16); // 2 rare traits × 8%
    expect(valuation!.estimatedValueUsd).toBeGreaterThan(valuation!.floorPriceUsd * 3);
  });

  // ─── Portfolio ──────────────────────────────────────────────────────

  it('returns NFT portfolio for an agent with items', () => {
    const portfolio: NftPortfolio = service.getPortfolio('agent-test-1');
    expect(portfolio.agentId).toBe('agent-test-1');
    expect(portfolio.items.length).toBeGreaterThanOrEqual(3);
    expect(portfolio.totalEstimatedValueUsd).toBeGreaterThan(0);
    expect(portfolio.totalAcquisitionCostUsd).toBeGreaterThan(0);
    expect(typeof portfolio.totalUnrealizedPnlUsd).toBe('number');
    expect(typeof portfolio.totalUnrealizedPnlPct).toBe('number');
    expect(portfolio.collectionBreakdown.length).toBeGreaterThan(0);
    expect(portfolio.timestamp).toBeDefined();

    // Verify each item has required fields
    for (const item of portfolio.items) {
      expect(item.tokenId).toBeDefined();
      expect(item.collectionId).toBeDefined();
      expect(item.collectionName).toBeDefined();
      expect(item.estimatedValueUsd).toBeGreaterThan(0);
      expect(item.acquisitionPriceUsd).toBeGreaterThan(0);
      expect(typeof item.unrealizedPnlUsd).toBe('number');
      expect(typeof item.unrealizedPnlPct).toBe('number');
      expect(item.holdDays).toBeGreaterThanOrEqual(0);
    }
  });

  it('portfolio collection breakdown sums match total', () => {
    const portfolio = service.getPortfolio('agent-test-2');
    const breakdownTotal = portfolio.collectionBreakdown.reduce((s, b) => s + b.valueUsd, 0);
    expect(breakdownTotal).toBeCloseTo(portfolio.totalEstimatedValueUsd, 0);
    const breakdownCount = portfolio.collectionBreakdown.reduce((s, b) => s + b.count, 0);
    expect(breakdownCount).toBe(portfolio.items.length);
  });

  // ─── Wash Trading Detection ─────────────────────────────────────────

  it('detects wash trading in a collection', () => {
    const report: WashTradingReport | undefined = service.detectWashTrading('mad-lads');
    expect(report).toBeDefined();
    expect(report!.collectionId).toBe('mad-lads');
    expect(report!.totalTransactions).toBeGreaterThan(0);
    expect(report!.suspectTransactions).toBeGreaterThan(0);
    expect(report!.washTradingPct).toBeGreaterThan(0);
    expect(report!.washTradingPct).toBeLessThanOrEqual(100);
    expect(report!.suspectedVolumeUsd).toBeGreaterThan(0);
    expect(report!.cleanVolumeUsd).toBeGreaterThanOrEqual(0);
    expect(report!.suspects.length).toBeGreaterThan(0);
    expect(['low', 'medium', 'high', 'critical']).toContain(report!.riskLevel);
    expect(report!.indicators.length).toBeGreaterThan(0);
    expect(report!.timestamp).toBeDefined();

    // Verify suspects have proper structure
    for (const suspect of report!.suspects) {
      expect(suspect.txId).toBeDefined();
      expect(suspect.buyer).toBeDefined();
      expect(suspect.seller).toBeDefined();
      expect(suspect.tokenId).toBeDefined();
      expect(suspect.priceUsd).toBeGreaterThan(0);
      expect(suspect.reason).toBeDefined();
      expect(suspect.confidence).toBeGreaterThan(0);
      expect(suspect.confidence).toBeLessThanOrEqual(100);
    }
  });

  it('returns undefined wash trading report for unknown collection', () => {
    const report = service.detectWashTrading('nonexistent');
    expect(report).toBeUndefined();
  });

  it('detects reciprocal wash trades with high confidence', () => {
    const report = service.detectWashTrading('tensorians')!;
    const reciprocal = report.suspects.filter((s) =>
      s.reason.includes('Reciprocal'),
    );
    expect(reciprocal.length).toBeGreaterThan(0);
    // Reciprocal trades should have high confidence
    const highConfidence = reciprocal.filter((s) => s.confidence >= 70);
    expect(highConfidence.length).toBeGreaterThan(0);
  });

  it('wash trading volumes sum correctly', () => {
    const report = service.detectWashTrading('claynosaurz')!;
    // suspected + clean should roughly equal total volume from transactions
    const totalReported = report.suspectedVolumeUsd + report.cleanVolumeUsd;
    expect(totalReported).toBeGreaterThan(0);
    // Wash trading pct should be consistent
    if (report.suspectedVolumeUsd > 0 && totalReported > 0) {
      const expectedPct = (report.suspectedVolumeUsd / totalReported) * 100;
      expect(report.washTradingPct).toBeCloseTo(expectedPct, 1);
    }
  });
});
