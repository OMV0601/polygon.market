/**
 * Polymarket's real fee schedule.
 *
 *   fee = shares × feeRate × p × (1 − p)
 *
 * Two consequences the old flat `notional × 1%` model missed entirely:
 *
 *   1. The p(1−p) term is symmetric about 50¢ and vanishes at the extremes, so
 *      a fill at 30¢ costs exactly what a fill at 70¢ costs, and a fill at 5¢
 *      is nearly free. A model proportional to notional gets the shape wrong,
 *      not just the level.
 *   2. Makers pay nothing and collect a share of taker fees back as a rebate.
 *      Any strategy that only ever crosses the spread is choosing the most
 *      expensive way to trade.
 *
 * Rates are per category and are the numbers to re-verify first: they are
 * published figures that can change, and the US venue may differ from the
 * international one. Everything downstream — edge thresholds, Kelly sizing,
 * the paper P&L — is measured against them.
 */

export type FeeCategory =
  | 'crypto'
  | 'sports'
  | 'politics'
  | 'finance'
  | 'geopolitics'
  | 'weather'
  | 'default';

interface CategoryFees {
  /** Taker fee rate, applied as rate × p × (1−p) per share. */
  takerRate: number;
  /** Share of collected taker fees rebated to the resting maker. */
  makerRebateShare: number;
}

export const FEE_SCHEDULE: Record<FeeCategory, CategoryFees> = {
  crypto:      { takerRate: 0.07, makerRebateShare: 0.20 },
  sports:      { takerRate: 0.05, makerRebateShare: 0.15 },
  politics:    { takerRate: 0.04, makerRebateShare: 0.25 },
  finance:     { takerRate: 0.04, makerRebateShare: 0.25 },
  geopolitics: { takerRate: 0.00, makerRebateShare: 0.00 },
  // Temperature markets are not called out separately in the published
  // schedule, so they take the default tier until measured against a real fill.
  weather:     { takerRate: 0.05, makerRebateShare: 0.15 },
  default:     { takerRate: 0.05, makerRebateShare: 0.15 },
};

export interface TransactionCost {
  /** USDC paid in taker fees for the whole order. */
  takerFee: number;
  /** Always zero — resting orders are not charged. Kept explicit. */
  makerFee: number;
  /** USDC a maker would expect back, if the other side is a taker. */
  expectedRebate: number;
  /** USDC lost to crossing the spread: (avgFill − mid) × shares. */
  spreadCost: number;
  /** USDC lost walking past the top of book: (avgFill − bestAsk) × shares. */
  estimatedSlippage: number;
  /** takerFee + spreadCost. What crossing the spread really costs. */
  totalTakerCost: number;
}

/** Per-share taker fee at price `p`. Symmetric about 0.5, zero at the bounds. */
export function takerFeePerShare(price: number, category: FeeCategory = 'default'): number {
  const p = clampProb(price);
  return FEE_SCHEDULE[category].takerRate * p * (1 - p);
}

/** Total taker fee for an order of `shares` filled at average price `p`. */
export function takerFee(shares: number, price: number, category: FeeCategory = 'default'): number {
  return Math.max(0, shares) * takerFeePerShare(price, category);
}

/**
 * Rebate a resting order expects when a taker fills it. The taker pays the fee
 * on their side; the maker receives a share of it.
 */
export function makerRebate(
  shares: number,
  price: number,
  category: FeeCategory = 'default'
): number {
  const { makerRebateShare } = FEE_SCHEDULE[category];
  return takerFee(shares, price, category) * makerRebateShare;
}

export function costOf(params: {
  shares: number;
  avgFillPrice: number;
  bestAsk: number;
  midPrice: number;
  category?: FeeCategory;
}): TransactionCost {
  const { shares, avgFillPrice, bestAsk, midPrice, category = 'default' } = params;

  const fee = takerFee(shares, avgFillPrice, category);
  const spreadCost = Math.max(0, avgFillPrice - midPrice) * shares;

  return {
    takerFee: fee,
    makerFee: 0,
    expectedRebate: makerRebate(shares, avgFillPrice, category),
    spreadCost,
    estimatedSlippage: Math.max(0, avgFillPrice - bestAsk) * shares,
    totalTakerCost: fee + spreadCost,
  };
}

/**
 * Maps a market's free-text category onto a fee tier. Unknown categories take
 * the default rather than zero — assuming no fee where one exists is the error
 * that flatters a backtest.
 */
export function categoryFor(raw: string | null | undefined): FeeCategory {
  const text = (raw ?? '').toLowerCase();

  // Short tickers need word boundaries. Without them "something" matches "eth"
  // and an ordinary market gets billed at the crypto rate — the kind of silent
  // misclassification that only shows up as unexplained P&L drift.
  if (/crypto|bitcoin|ethereum|solana|\b(btc|eth|sol|xrp|doge)\b/.test(text)) return 'crypto';
  if (/weather|temperature|rain|snow/.test(text)) return 'weather';
  if (/sport|soccer|football|tennis|golf|basketball|\b(nfl|nba|nhl|mlb|ufc)\b/.test(text)) {
    return 'sports';
  }
  if (/politic|election|president|senate|congress|parliament/.test(text)) return 'politics';
  if (/geopolit|ceasefire|treaty|sanction|\bwar\b/.test(text)) return 'geopolitics';
  if (/finance|inflation|earnings|stock|\b(fed|rate|rates|cpi|gdp)\b/.test(text)) return 'finance';
  return 'default';
}

function clampProb(p: number): number {
  if (!isFinite(p)) return 0;
  return Math.min(1, Math.max(0, p));
}
