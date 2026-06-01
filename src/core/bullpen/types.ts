// Typed interfaces for bullpen CLI JSON responses.
// Field names mirror the bullpen output schema; extend here as the CLI evolves.

export interface BullpenVersionInfo {
  version: string;
  raw: string;
}

export interface BullpenMarket {
  slug: string;
  title: string;
  category?: string;
  endDate?: string;
  volume24h: number;
  bestBid: number;
  bestAsk: number;
  spread: number;
  liquidity: number;
  outcomes: BullpenOutcome[];
}

export interface BullpenOutcome {
  id: string;
  label: string;         // 'Yes' | 'No' | custom
  price: number;         // 0-1
  volumeShares: number;
}

export interface BullpenPosition {
  marketSlug: string;
  marketTitle: string;
  outcome: string;
  shares: number;
  avgEntryPrice: number;
  currentPrice: number;
  unrealizedPnl: number;
  openedAt: string;      // ISO-8601
}

export interface BullpenWalletTransaction {
  txHash: string;
  walletAddress: string;
  marketSlug: string;
  outcome: string;
  side: 'BUY' | 'SELL';
  fillPrice: number;
  shareCount: number;
  totalCost: number;
  timestamp: string;     // ISO-8601
}

export interface BullpenOrderBookLevel {
  price: number;
  size: number;
}

export interface BullpenOrderBook {
  marketSlug: string;
  outcome: string;
  bids: BullpenOrderBookLevel[];
  asks: BullpenOrderBookLevel[];
  bestBid: number;
  bestAsk: number;
  fetchedAt: string;
}

export interface BullpenDiscoverResult {
  markets: BullpenMarket[];
  total: number;
  fetchedAt: string;
}

export interface BullpenPositionsResult {
  positions: BullpenPosition[];
  walletBalance: number;
  fetchedAt: string;
}

export interface BullpenHealthStatus {
  connected: boolean;
  version: string | null;
  latencyMs: number;
  error?: string;
}
