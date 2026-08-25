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

/**
 * Below this, a sum is evidence of a broken or open-ended set rather than an
 * opportunity. A live, exhaustive set trades near 1 because the arbitrage would
 * otherwise already have been taken; a set at 0.37 is telling you most of the
 * probability lives somewhere you cannot buy, and one at 0.003 is stale quotes
 * on a market that has effectively already resolved.
 */
const IMPLAUSIBLE_SUM_FLOOR = 0.90;

/** Outcome names that make a set exhaustive by absorbing everything else. */
const CATCH_ALL_RX =
  /\b(other|another|someone else|somebody else|any other|field|none of (the )?above|no winner|neither)\b/i;

/**
 * Whether the listed outcomes can be relied on to contain the winner.
 *
 * This is the distinction the whole strategy turns on, and it is NOT what the
 * venue's negRisk flag means. negRisk guarantees the outcomes are mutually
 * exclusive — at most one resolves YES. It does not guarantee one of them will.
 *
 * "Republican Presidential Nominee 2028" is a negRisk event with 42 candidates
 * whose asks summed to 0.909. Buying the full set is not a guaranteed $1: if
 * the eventual nominee is someone not yet listed, all 42 legs resolve NO and
 * the entire stake is lost. The 9% discount is the market pricing exactly that
 * risk, correctly. Polymarket adds outcomes to these events over time, which is
 * only possible because the set was never closed.
 *
 * A set is treated as exhaustive only with an explicit catch-all outcome. A
 * football match is genuinely closed without one, but nothing in the event
 * payload distinguishes it from an open candidate list, and guessing from the
 * title is the mistake that sank the previous arbitrage strategy.
 */
export function exhaustivenessOf(
  outcomes: Array<{ title: string }>
): { exhaustive: boolean; reason: string } {
  const catchAll = outcomes.find((o) => CATCH_ALL_RX.test(o.title));
  if (catchAll) {
    return { exhaustive: true, reason: `catch-all outcome present: "${catchAll.title}"` };
  }
  return {
    exhaustive: false,
    reason:
      'no catch-all outcome — the winner may not be listed, so a full set is ' +
      'not guaranteed to pay $1',
  };
}

export function findArbitrage(
  event: NegRiskEvent,
  maxCapitalUsdc: number
): ArbOpportunity | null {
  // Without a guarantee that one listed outcome must win, there is no
  // arbitrage here — only a directional bet wearing its costume.
  if (!event.isComplete) return null;
  if (event.outcomes.length < 2) return null;
  if (event.outcomes.some((o) => !isFinite(o.bestAsk) || o.bestAsk <= 0)) return null;

  // Mutual exclusivity is not exhaustiveness. See exhaustivenessOf.
  const { exhaustive } = exhaustivenessOf(event.outcomes);
  if (!exhaustive) return null;

  const askSum = event.outcomes.reduce((a, o) => a + o.bestAsk, 0);

  // A sum this far below 1 is not a mispricing anyone left lying around; it
  // means the set is open-ended or the quotes are stale on a dead market.
  if (askSum < IMPLAUSIBLE_SUM_FLOOR) return null;

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
