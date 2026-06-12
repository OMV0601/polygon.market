import { env } from '../../config/env';
import { logger } from '../logger/logger';
import { httpGet } from '../../lib/http';
import type {
  BullpenDiscoverResult,
  BullpenHealthStatus,
  BullpenMarket,
  BullpenOrderBook,
  BullpenOrderBookLevel,
  BullpenPositionsResult,
  BullpenWalletTransaction,
} from '../bullpen/types';

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB  = 'https://clob.polymarket.com';
const DATA  = 'https://data-api.polymarket.com';

// ── Raw Gamma API shape ───────────────────────────────────────────
interface GammaMarket {
  id: string;
  slug: string;
  question: string;
  outcomes: string[];         // ["Yes", "No"]
  outcomePrices: string[];    // ["0.505", "0.495"]
  bestBid: number | null;
  bestAsk: number | null;
  spread: number | null;
  volume24hr: number;
  liquidityNum: number;
  endDate: string;
  clobTokenIds: string;       // JSON-encoded: '["tokenId1","tokenId2"]'
  active: boolean;
  closed: boolean;
}

// ── Raw CLOB API shape ────────────────────────────────────────────
interface ClobBook {
  asset_id: string;
  bids: Array<{ price: string; size: string }>;
  asks: Array<{ price: string; size: string }>;
}

// ── Raw Data API shapes ───────────────────────────────────────────
interface DataActivity {
  proxyWallet?: string;
  timestamp: number;          // Unix seconds
  conditionId?: string;
  type?: string;
  size: number;               // shares
  usdcSize?: number;          // USDC cost
  transactionHash?: string;
  txHash?: string;
  price: number;
  asset?: string;
  side: 'BUY' | 'SELL';
  outcomeIndex?: number;
  title?: string;
  slug?: string;
  outcome?: string;           // "Yes" | "No"
  id?: string;
  market?: string;
  createdAt?: string;
}

interface DataPosition {
  conditionId?: string;
  market?: string;
  slug?: string;
  title?: string;
  outcome: string;
  size: number;
  avgPrice?: number;
  initialValue?: number;
  currentValue?: number;
  cashPnl?: number;
}

// Cache token IDs per slug so orderBook() doesn't re-fetch the market on every call
const tokenCache = new Map<string, string[]>();

export class PolymarketClient {

  // ── Health ────────────────────────────────────────────────────────

  async healthCheck(): Promise<BullpenHealthStatus> {
    const start = Date.now();
    try {
      await httpGet<GammaMarket[]>(`${GAMMA}/markets?active=true&closed=false&limit=1`);
      return {
        connected: true,
        version: 'polymarket-rest-api/v1',
        latencyMs: Date.now() - start,
      };
    } catch (err) {
      return {
        connected: false,
        version: null,
        latencyMs: Date.now() - start,
        error: (err as Error).message,
      };
    }
  }

  // ── Market Discovery ──────────────────────────────────────────────

  async discover(filters?: { category?: string; minVolume?: number }): Promise<BullpenDiscoverResult> {
    const { data: raw, fetchedAt } = await httpGet<GammaMarket[]>(
      `${GAMMA}/markets?active=true&closed=false&limit=100`
    );

    let markets = raw ?? [];

    if (filters?.minVolume) {
      markets = markets.filter((m) => m.volume24hr >= filters.minVolume!);
    }
    if (filters?.category) {
      markets = markets.filter((m) => this.detectCategory(m) === filters.category);
    }

    // Warm the token cache while we have the data
    for (const m of markets) {
      try {
        tokenCache.set(m.slug, JSON.parse(m.clobTokenIds) as string[]);
      } catch {}
    }

    return {
      markets: markets.map((m) => this.toMarket(m)),
      total: markets.length,
      fetchedAt: fetchedAt.toISOString(),
    };
  }

  // ── Order Book ────────────────────────────────────────────────────

  async orderBook(marketSlug: string, outcome: string): Promise<BullpenOrderBook> {
    const tokenId = await this.resolveTokenId(marketSlug, outcome);

    const { data: book, fetchedAt } = await httpGet<ClobBook>(
      `${CLOB}/book?token_id=${tokenId}`
    );

    const map = (l: { price: string; size: string }): BullpenOrderBookLevel => ({
      price: parseFloat(l.price),
      size: parseFloat(l.size),
    });

    const bids = (book.bids ?? []).map(map).sort((a, b) => b.price - a.price);
    const asks = (book.asks ?? []).map(map).sort((a, b) => a.price - b.price);

    return {
      marketSlug,
      outcome,
      bids,
      asks,
      bestBid: bids[0]?.price ?? 0,
      bestAsk: asks[0]?.price ?? 1,
      fetchedAt: fetchedAt.toISOString(),
    };
  }

  // ── Positions ─────────────────────────────────────────────────────

  async positions(): Promise<BullpenPositionsResult> {
    const address = process.env.POLYMARKET_WALLET_ADDRESS;

    if (!address) {
      logger.warn('PolymarketClient: POLYMARKET_WALLET_ADDRESS not set — skipping live positions');
      return { positions: [], walletBalance: 0, fetchedAt: new Date().toISOString() };
    }

    const { data, fetchedAt } = await httpGet<DataPosition[]>(
      `${DATA}/positions?user=${address}`
    );

    return {
      positions: (data ?? []).map((p) => ({
        marketSlug: p.slug ?? p.conditionId ?? p.market ?? '',
        marketTitle: p.title ?? '',
        outcome: p.outcome,
        shares: p.size,
        avgEntryPrice: p.avgPrice ?? 0,
        currentPrice: p.currentValue ? p.currentValue / Math.max(p.size, 0.0001) : 0,
        unrealizedPnl: p.cashPnl ?? 0,
        openedAt: new Date().toISOString(),
      })),
      walletBalance: 0, // on-chain USDC balance — add in live phase
      fetchedAt: fetchedAt.toISOString(),
    };
  }

  // ── Wallet Transactions ───────────────────────────────────────────

  async walletTransactions(
    walletAddress: string,
    since?: Date
  ): Promise<BullpenWalletTransaction[]> {
    const { data } = await httpGet<DataActivity[]>(
      `${DATA}/activity?user=${walletAddress}&limit=200`
    );

    return (data ?? [])
      .filter((tx) => {
        if (tx.side !== 'BUY' && tx.side !== 'SELL') return false;
        if (since) {
          // timestamp is Unix seconds
          if (new Date(tx.timestamp * 1000) < since) return false;
        }
        return true;
      })
      .map((tx) => ({
        txHash: tx.transactionHash ?? tx.txHash ?? String(tx.timestamp),
        walletAddress,
        marketSlug: tx.slug ?? tx.conditionId ?? tx.market ?? '',
        outcome: (tx.outcome ?? 'Yes').toUpperCase(),
        side: tx.side,
        fillPrice: tx.price,
        shareCount: tx.size,
        totalCost: tx.usdcSize ?? tx.price * tx.size,
        timestamp: new Date(tx.timestamp * 1000).toISOString(),
      }));
  }

  // ── Command builders ──────────────────────────────────────────────

  buildBuyCommand(marketSlug: string, outcome: string, amountUsdc: number): string {
    return `polymarket buy ${marketSlug} ${outcome} ${amountUsdc.toFixed(2)}`;
  }

  buildSellCommand(marketSlug: string, outcome: string, shares: number): string {
    return `polymarket sell ${marketSlug} ${outcome} ${shares.toFixed(4)}`;
  }

  // Live execution: requires Polymarket CLOB auth + EIP-712 order signing.
  // Wire up @polymarket/clob-client here when going live.
  async executeBuy(_slug: string, _outcome: string, _amount: number): Promise<string> {
    if (!env.LIVE_EXECUTION_ENABLED) {
      logger.error('[FATAL] executeBuy called with LIVE_EXECUTION_ENABLED=false — blocked');
      throw new Error('UNAUTHORIZED_EXECUTION: LIVE_EXECUTION_ENABLED is false');
    }
    throw new Error(
      'Live execution requires Polymarket CLOB auth setup — see @polymarket/clob-client'
    );
  }

  // ── Private helpers ───────────────────────────────────────────────

  private async resolveTokenId(marketSlug: string, outcome: string): Promise<string> {
    if (!tokenCache.has(marketSlug)) {
      const { data } = await httpGet<GammaMarket[]>(
        `${GAMMA}/markets?slug=${encodeURIComponent(marketSlug)}&limit=1`
      );
      if (!data?.length) throw new Error(`Market not found: ${marketSlug}`);
      tokenCache.set(marketSlug, JSON.parse(data[0].clobTokenIds) as string[]);
    }

    const ids = tokenCache.get(marketSlug)!;
    // Polymarket convention: index 0 = YES token, index 1 = NO token
    const idx = outcome.toUpperCase() === 'YES' ? 0 : 1;
    const id = ids[idx];
    if (!id) throw new Error(`No token ID for ${marketSlug} ${outcome}`);
    return id;
  }

  // Gamma API returns outcomes/outcomePrices as either a real array OR a
  // JSON-encoded string depending on market type. Parse both forms defensively.
  private parseStringOrArray(val: unknown, fallback: string[]): string[] {
    if (Array.isArray(val)) return val as string[];
    if (typeof val === 'string') {
      try { return JSON.parse(val) as string[]; } catch {}
    }
    return fallback;
  }

  private toMarket(m: GammaMarket): BullpenMarket {
    const outcomes = this.parseStringOrArray(m.outcomes, ['Yes', 'No']);
    const prices   = this.parseStringOrArray(m.outcomePrices, ['0.5', '0.5']);
    return {
      slug: m.slug,
      title: m.question,
      category: this.detectCategory(m),
      volume24h: m.volume24hr ?? 0,
      bestBid: m.bestBid ?? 0,
      bestAsk: m.bestAsk ?? 1,
      spread: m.spread ?? ((m.bestAsk ?? 1) - (m.bestBid ?? 0)),
      liquidity: m.liquidityNum ?? 0,
      endDate: m.endDate,
      outcomes: outcomes.map((label, i) => ({
        id: label.toLowerCase(),
        label,
        price: parseFloat(prices[i] ?? '0.5'),
        volumeShares: 0,
      })),
    };
  }

  private detectCategory(m: GammaMarket): string {
    const text = m.question.toLowerCase();
    if (/temperature|degrees|°f|°c|rain|snow|weather|forecast|high of|low of/.test(text)) return 'weather';
    // Sports must be checked before weather — team names like "Hurricanes" would
    // otherwise match the weather regex.
    if (/\bnfl\b|\bnba\b|\bnhl\b|\bmlb\b|stanley cup|super bowl|world series|playoff|championship|league|tournament|\bwins?\b.*title|\bvs\b/i.test(m.question)) return 'sports';
    if (/election|vote|president|senator|congress|prime minister|chancellor|parliament/i.test(m.question)) return 'politics';
    if (/temperature|degrees|°f|°c|rain(?:fall)?|snowfall|weather forecast|high of|low of|tropical storm|heat wave|blizzard|flood/i.test(text)) return 'weather';
    return 'general';
  }
}
