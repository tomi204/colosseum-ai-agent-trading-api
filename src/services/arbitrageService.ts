import { config } from '../config.js';

/* ─── Types ──────────────────────────────────────────────────────────────── */

export interface VenueQuote {
  venue: string;
  priceUsd: number;
  fetchedAt: string;
}

export interface ArbitrageOpportunity {
  id: string;
  symbol: string;
  buyVenue: string;
  sellVenue: string;
  buyPriceUsd: number;
  sellPriceUsd: number;
  spreadBps: number;
  detectedAt: string;
}

export interface ArbitrageStats {
  running: boolean;
  scansCompleted: number;
  opportunitiesFound: number;
  opportunitiesExecuted: number;
  lastScanAt: string | null;
  scanIntervalMs: number;
}

/* ─── Service ────────────────────────────────────────────────────────────── */

const VENUES = ['jupiter', 'raydium', 'orca'] as const;

export class ArbitrageService {
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private scansCompleted = 0;
  private opportunitiesFound = 0;
  private opportunitiesExecuted = 0;
  private lastScanAt: string | null = null;
  private opportunities: ArbitrageOpportunity[] = [];
  private idCounter = 0;

  private readonly scanIntervalMs: number;
  private readonly minSpreadBps: number;
  private readonly enabled: boolean;
  private readonly jupiterQuoteUrl: string;
  private readonly symbolToMint: Record<string, string>;

  constructor() {
    this.scanIntervalMs = config.arbitrage.scanIntervalMs;
    this.minSpreadBps = config.arbitrage.minSpreadBps;
    this.enabled = config.arbitrage.enabled;
    this.jupiterQuoteUrl = config.trading.jupiterQuoteUrl;
    this.symbolToMint = config.trading.symbolToMint;
  }

  /* ─── Lifecycle ──────────────────────────────────────────────────────── */

  start(): void {
    if (!this.enabled || this.running) return;
    this.running = true;
    this.timer = setInterval(() => void this.scan(), this.scanIntervalMs);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /* ─── Query ──────────────────────────────────────────────────────────── */

  getOpportunities(): ArbitrageOpportunity[] {
    return [...this.opportunities];
  }

  getStatus(): ArbitrageStats {
    return {
      running: this.running,
      scansCompleted: this.scansCompleted,
      opportunitiesFound: this.opportunitiesFound,
      opportunitiesExecuted: this.opportunitiesExecuted,
      lastScanAt: this.lastScanAt,
      scanIntervalMs: this.scanIntervalMs,
    };
  }

  /* ─── Scanner ────────────────────────────────────────────────────────── */

  private async scan(): Promise<void> {
    const symbols = Object.keys(this.symbolToMint);
    const newOpportunities: ArbitrageOpportunity[] = [];

    for (const symbol of symbols) {
      try {
        const quotes = await this.fetchVenuePrices(symbol);
        if (quotes.length < 2) continue;

        const sorted = [...quotes].sort((a, b) => a.priceUsd - b.priceUsd);
        const cheapest = sorted[0];
        const priciest = sorted[sorted.length - 1];
        const mid = (cheapest.priceUsd + priciest.priceUsd) / 2;
        const spreadBps = ((priciest.priceUsd - cheapest.priceUsd) / mid) * 10_000;

        if (spreadBps >= this.minSpreadBps) {
          this.idCounter += 1;
          const opp: ArbitrageOpportunity = {
            id: `arb-${this.idCounter}`,
            symbol,
            buyVenue: cheapest.venue,
            sellVenue: priciest.venue,
            buyPriceUsd: cheapest.priceUsd,
            sellPriceUsd: priciest.priceUsd,
            spreadBps: Number(spreadBps.toFixed(1)),
            detectedAt: new Date().toISOString(),
          };
          newOpportunities.push(opp);
          this.opportunitiesFound += 1;
        }
      } catch {
        // Individual symbol scan failures are non-fatal.
      }
    }

    this.opportunities = newOpportunities;
    this.scansCompleted += 1;
    this.lastScanAt = new Date().toISOString();
  }

  /**
   * Fetch simulated multi-venue prices for a symbol.
   *
   * In production this would hit each DEX's price API. For the hackathon we
   * query Jupiter's quote API with small perturbations to simulate venue
   * differences, plus add synthetic venue offsets.
   */
  private async fetchVenuePrices(symbol: string): Promise<VenueQuote[]> {
    const mint = this.symbolToMint[symbol];
    const usdcMint = this.symbolToMint['USDC'];
    if (!mint || !usdcMint || mint === usdcMint) return [];

    const quotes: VenueQuote[] = [];

    for (const venue of VENUES) {
      try {
        const slippageBps = venue === 'jupiter' ? 50 : venue === 'raydium' ? 75 : 100;
        const params = new URLSearchParams({
          inputMint: usdcMint,
          outputMint: mint,
          amount: String(1_000_000), // 1 USDC (6 decimals)
          slippageBps: String(slippageBps),
        });

        const response = await fetch(`${this.jupiterQuoteUrl}?${params.toString()}`);
        if (!response.ok) continue;

        const data = (await response.json()) as { outAmount?: string };
        if (!data.outAmount) continue;

        const outAmount = Number(data.outAmount);
        if (!Number.isFinite(outAmount) || outAmount <= 0) continue;

        // Price = USDC spent / tokens received (raw amounts).
        const priceUsd = 1_000_000 / outAmount;

        // Apply a small synthetic venue offset to simulate real differences.
        const offset = venue === 'jupiter' ? 1 : venue === 'raydium' ? 1.001 : 0.999;

        quotes.push({
          venue,
          priceUsd: priceUsd * offset,
          fetchedAt: new Date().toISOString(),
        });
      } catch {
        // Individual venue failures are non-fatal.
      }
    }

    return quotes;
  }
}
