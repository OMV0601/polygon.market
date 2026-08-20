/**
 * Genuine intra-event arbitrage.
 *
 * A negRisk event is a set of outcomes the protocol itself guarantees are
 * mutually exclusive and exhaustive — exactly one resolves YES. So the asks
 * must sum to at least 1: buying one share of every outcome costs Σ asks and
 * pays exactly $1 at resolution. When Σ asks < 1 net of fees, that difference
 * is free money and needs no view on which outcome wins.
 *
 * The predecessor to this file inferred exclusivity from shared words in market
 * titles and an antonym list. That is not a weaker version of this idea, it is
 * a different and unsound one: "Team A wins" and "Team B loses" share tokens
 * and antonyms while being perfectly compatible, so both legs could lose. The
 * guarantee has to come from the event structure, never from the prose.
 *
 * Two hard requirements before any of this is real money:
 *   - the outcome set must be complete; a missing leg means the payout is not
 *     guaranteed and the "arb" is an unhedged directional bet
 *   - execution must be all-or-nothing; a partial fill leaves naked exposure
 *     with none of the compensating edge
 */

import { takerFeePerShare, type FeeCategory } from '../../core/pricing/FeeModel';

export interface NegRiskOutcome {
  tokenId: string;
  marketSlug: string;
  title: string;
  bestAsk: number;
  /** USDC available at the best ask. */
  askDepthUsdc: number;
}

export interface NegRiskEvent {
  eventId: string;
  title: string;
  outcomes: NegRiskOutcome[];
  /** True only when the venue says this is a complete negRisk outcome set. */
  isComplete: boolean;
  category: FeeCategory;
}

export interface ArbOpportunity {
  eventId: string;
  title: string;
  /** Sum of best asks across every outcome. Below 1 is the opportunity. */
  askSum: number;
  /** Total fee per full set, in USDC. */
  feePerSet: number;
  /** 1 − askSum − fees. Profit per complete set bought. */
  netMarginPerSet: number;
  /** Complete sets the thinnest leg allows. */
  maxSets: number;
  maxProfitUsdc: number;
  legs: Array<{ tokenId: string; marketSlug: string; price: number; sizeUsdc: number }>;
}

/** Safety margin over the break-even sum, absorbing a tick of adverse movement. */
const SAFETY_BUFFER = 0.005;

export function findArbitrage(
  event: NegRiskEvent,
  maxCapitalUsdc: number
): ArbOpportunity | null {
  // Without a protocol guarantee of completeness there is no arbitrage here,
  // only a directional bet wearing its costume.
  if (!event.isComplete) return null;
  if (event.outcomes.length < 2) return null;
  if (event.outcomes.some((o) => !isFinite(o.bestAsk) || o.bestAsk <= 0)) return null;

  const askSum = event.outcomes.reduce((a, o) => a + o.bestAsk, 0);

  // One share of every outcome pays exactly $1, so fees are charged per leg at
  // that leg's own price — and p(1−p) means the cheap legs are nearly free.
  const feePerSet = event.outcomes.reduce(
    (a, o) => a + takerFeePerShare(o.bestAsk, event.category),
    0
  );

  const netMarginPerSet = 1 - askSum - feePerSet - SAFETY_BUFFER;
  if (netMarginPerSet <= 0) return null;

  // A complete set is only as large as its thinnest leg allows.
  const setsByLeg = event.outcomes.map((o) => o.askDepthUsdc / o.bestAsk);
  const setsByCapital = maxCapitalUsdc / askSum;
  const maxSets = Math.floor(Math.min(...setsByLeg, setsByCapital));
  if (maxSets < 1) return null;

  return {
    eventId: event.eventId,
    title: event.title,
    askSum,
    feePerSet,
    netMarginPerSet,
    maxSets,
    maxProfitUsdc: maxSets * netMarginPerSet,
    legs: event.outcomes.map((o) => ({
      tokenId: o.tokenId,
      marketSlug: o.marketSlug,
      price: o.bestAsk,
      sizeUsdc: maxSets * o.bestAsk,
    })),
  };
}
