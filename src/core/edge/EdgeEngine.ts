/**
 * Converts a model's probability plus a live book into a trading decision.
 *
 * Previously each strategy carried its own threshold — an 8-point gap here, a
 * 1.5% margin there — expressed in different units and none of them net of the
 * real costs. That makes two opportunities incomparable and makes every
 * threshold a magic number.
 *
 * Everything is expressed here in one unit: **expected cents per share, after
 * fees and after walking the book**. A weather bucket and an arbitrage leg can
 * then be ranked against each other honestly.
 *
 * It also produces the maker-versus-taker decision, which the old design could
 * not express at all. Resting an order pays no fee and earns a rebate; crossing
 * the spread pays both the fee and the spread. Where the model's edge is real
 * but thin, quoting is profitable and taking is not.
 */

import { walkAsks } from '../../execution/ExecutionEngine';
import {
  type FeeCategory,
  makerRebate,
  takerFeePerShare,
} from '../pricing/FeeModel';

export type EdgeAction = 'QUOTE' | 'TAKE' | 'PASS';

export interface BookLevel {
  price: number;
  size: number;
}

export interface EdgeInput {
  /** The model's probability that this outcome resolves YES. */
  q: number;
  /** 0–1. Scales the edge down when the model is unsure of itself. */
  confidence: number;
  bids: BookLevel[];
  asks: BookLevel[];
  bestBid: number;
  bestAsk: number;
  category: FeeCategory;
  /** USDC we would deploy if we traded. Determines how far up the book we walk. */
  intendedSizeUsdc: number;
  /**
   * Recent price volatility for this market, in probability units. Drives the
   * adverse-selection penalty: a resting order in a fast-moving market is
   * filled precisely when the market has moved against it.
   */
  recentVolatility?: number;
}

export interface EdgeResult {
  action: EdgeAction;
  takerEdgeCentsPerShare: number;
  makerEdgeCentsPerShare: number;
  /** Price we would rest at when quoting. */
  quotePrice: number;
  avgFillPrice: number;
  feePerShare: number;
  /** USDC of the intended size the book can actually absorb. */
  fillableUsdc: number;
  reason: string;
}

/** A take must clear this multiple of its own cost to be worth crossing. */
const TAKE_COST_MULTIPLE = 2;

/** Minimum maker edge worth tying up capital for, in cents per share. */
const MIN_MAKER_EDGE_CENTS = 1.0;

/** Fraction of recent volatility charged against a resting order. */
const ADVERSE_SELECTION_FACTOR = 0.5;

export function evaluateEdge(input: EdgeInput): EdgeResult {
  const {
    q, confidence, asks, bestBid, bestAsk, category,
    intendedSizeUsdc, recentVolatility = 0,
  } = input;

  const walk = walkAsks(asks, intendedSizeUsdc);
  const avgFillPrice = walk.shares > 0 ? walk.spent / walk.shares : bestAsk;
  const fillableUsdc = walk.spent;

  // Discount the edge by how much the model trusts itself. A model that is
  // certain and a model that is guessing should not size the same.
  const effectiveQ = q * confidence + avgFillPrice * (1 - confidence);

  // ── Taker: pay the walked price plus the fee at that price ────────────────
  const takerFeeShare = takerFeePerShare(avgFillPrice, category);
  const takerEdge = effectiveQ - avgFillPrice - takerFeeShare;

  // ── Maker: rest one tick inside the spread, pay no fee, collect a rebate ──
  const tick = 0.01;
  const quotePrice = Math.min(
    Math.max(bestBid + tick, 0.01),
    Math.max(bestAsk - tick, 0.01)
  );
  const rebatePerShare = makerRebate(1, quotePrice, category);

  // A resting bid is hit when someone wants to sell into it, which correlates
  // with the price about to fall. Charging a fraction of recent volatility
  // keeps thin edges in fast markets from looking free.
  const adverseSelection = recentVolatility * ADVERSE_SELECTION_FACTOR;

  const makerEdge = effectiveQ - quotePrice + rebatePerShare - adverseSelection;

  const takerEdgeCents = takerEdge * 100;
  const makerEdgeCents = makerEdge * 100;
  const takerCostCents = (takerFeeShare + Math.max(0, avgFillPrice - (bestBid + bestAsk) / 2)) * 100;

  let action: EdgeAction = 'PASS';
  let reason: string;

  if (fillableUsdc <= 0) {
    reason = 'no ask-side liquidity';
  } else if (takerEdgeCents > TAKE_COST_MULTIPLE * takerCostCents && takerEdgeCents > 0) {
    action = 'TAKE';
    reason =
      `taker edge ${takerEdgeCents.toFixed(2)}c/share clears ${TAKE_COST_MULTIPLE}x ` +
      `its ${takerCostCents.toFixed(2)}c cost`;
  } else if (makerEdgeCents >= MIN_MAKER_EDGE_CENTS) {
    action = 'QUOTE';
    reason =
      `taker edge ${takerEdgeCents.toFixed(2)}c does not clear ${TAKE_COST_MULTIPLE}x cost, ` +
      `but resting at ${quotePrice.toFixed(2)} earns ${makerEdgeCents.toFixed(2)}c/share`;
  } else {
    reason =
      `edge too thin: taker ${takerEdgeCents.toFixed(2)}c, maker ${makerEdgeCents.toFixed(2)}c`;
  }

  return {
    action,
    takerEdgeCentsPerShare: takerEdgeCents,
    makerEdgeCentsPerShare: makerEdgeCents,
    quotePrice,
    avgFillPrice,
    feePerShare: takerFeeShare,
    fillableUsdc,
    reason,
  };
}
