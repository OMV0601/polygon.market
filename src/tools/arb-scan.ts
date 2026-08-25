/**
 * arb-scan — looks for negRisk outcome sets whose asks sum below $1.
 *
 * Read-only. Places no orders and writes nothing to the ledger.
 * Run with: npm run arb-scan
 *
 * The appeal over the forecast strategy is that real arbitrage does not require
 * being right about anything: if a set that must produce exactly one winner
 * costs less than $1, the difference is profit whoever wins.
 *
 * Two things have to hold, and the second is the one that bites.
 *
 * Depth: a sub-$1 sum on screen is worthless if the thinnest leg holds five
 * dollars, so this walks the real book on every leg.
 *
 * Exhaustiveness: negRisk guarantees the outcomes are mutually exclusive, NOT
 * that one of them wins. Most sets quoting below $1 are open candidate lists
 * where the eventual winner may not be listed — the shortfall is the market
 * pricing that risk, not an oversight. Those are reported and refused.
 */

import { PolymarketClient } from '../core/polymarket/PolymarketClient';
import {
  exhaustivenessOf,
  findArbitrage,
} from '../strategies/negrisk/NegRiskConsistencyModel';
import { mapWithConcurrency, optional } from '../lib/concurrency';
import { walkAsks } from '../execution/ExecutionEngine';

const CAPITAL_USDC = Number(process.env.WALLET_BALANCE_USDC ?? 500);
const h1 = (s: string) => console.log(`\n─── ${s} ${'─'.repeat(Math.max(0, 60 - s.length))}`);

async function main(): Promise<void> {
  console.log('═══ polygon.market — negRisk arbitrage scan ═══');
  console.log('Read-only. No orders, no ledger writes.\n');

  const client = new PolymarketClient();

  let events;
  try {
    events = await client.negRiskEvents();
  } catch (err) {
    console.log(`✗ Cannot reach Polymarket: ${(err as Error).message}`);
    process.exit(1);
  }

  console.log(`negRisk events found (3+ outcomes): ${events.length}`);
  if (events.length === 0) {
    console.log('\nNothing to scan. Either the endpoint shape has changed or no');
    console.log('multi-outcome events are currently open.');
    return;
  }

  // Quoted asks first: cheap, and it rules out the vast majority before
  // spending an order-book request per leg.
  const quotedCandidates = events.filter((e) => {
    const sum = e.outcomes.reduce((a, o) => a + o.bestAsk, 0);
    return isFinite(sum) && sum < 1.02 && e.outcomes.every((o) => o.bestAsk > 0);
  });

  console.log(`Events whose quoted asks sum below 1.02: ${quotedCandidates.length}`);

  const sums = events
    .map((e) => ({ e, sum: e.outcomes.reduce((a, o) => a + o.bestAsk, 0) }))
    .filter((x) => isFinite(x.sum) && x.sum > 0)
    .sort((a, b) => a.sum - b.sum);

  h1('Tightest outcome sets (quoted)');
  console.log('  sum      legs  event');
  console.log('  ' + '─'.repeat(64));
  for (const { e, sum } of sums.slice(0, 12)) {
    const title = e.title.length > 44 ? e.title.slice(0, 41) + '...' : e.title;
    console.log(
      `  ${sum.toFixed(4)}  ${String(e.outcomes.length).padStart(4)}  ${title}` +
        (sum < 1 ? '   ← below 1' : '')
    );
  }

  if (quotedCandidates.length === 0) {
    h1('Verdict');
    console.log('  No set quotes below 1.02. Nothing worth checking depth on.');
    console.log('  Sums above 1 are the normal state — that gap is the market makers\' margin.');
    return;
  }

  // Now the expensive part, on the short list only.
  h1('Depth check on the short list');

  const checked = await mapWithConcurrency(quotedCandidates.slice(0, 15), 3, async (event) => {
    const books = await mapWithConcurrency(event.outcomes, 4, (o) =>
      optional(client.orderBook(o.marketSlug, 'YES'))
    );

    // Replace the quoted ask with what the book can actually supply.
    const withDepth = event.outcomes.map((o, i) => {
      const book = books[i];
      if (!book || book.asks.length === 0) {
        return { ...o, bestAsk: NaN, askDepthUsdc: 0 };
      }
      const walk = walkAsks(book.asks, CAPITAL_USDC);
      return {
        ...o,
        bestAsk: book.bestAsk,
        askDepthUsdc: walk.spent,
      };
    });

    if (withDepth.some((o) => !isFinite(o.bestAsk) || o.askDepthUsdc <= 0)) {
      return { event, opportunity: null, reason: 'a leg has no offers' };
    }

    const askSum = withDepth.reduce((a, o) => a + o.bestAsk, 0);
    const { exhaustive, reason: exhaustReason } = exhaustivenessOf(withDepth);

    const opportunity = findArbitrage({ ...event, outcomes: withDepth }, CAPITAL_USDC);

    let reason: string;
    if (opportunity) {
      reason = 'profitable';
    } else if (askSum >= 1) {
      // Nothing to explain: the set costs more than it can pay. Exhaustiveness
      // is irrelevant here, and mentioning it produced a "-1.0% shortfall"
      // which is not a thing.
      reason = `sum ${askSum.toFixed(3)} — costs more than the $1 it pays`;
    } else if (!exhaustive) {
      // The case that looks most like free money and is not.
      reason =
        `sum ${askSum.toFixed(3)} — NOT arbitrage: ${exhaustReason}. ` +
        `The ${((1 - askSum) * 100).toFixed(1)}% discount is the market pricing ` +
        `an unlisted winner.`;
    } else {
      reason = `sum ${askSum.toFixed(3)} — exhaustive but no margin after fees`;
    }

    return { event, opportunity, reason };
  });

  let found = 0;
  for (const { event, opportunity, reason } of checked) {
    if (!opportunity) {
      console.log(`  ✗ ${event.title.slice(0, 50)} — ${reason}`);
      continue;
    }
    found++;
    console.log(`\n  ✔ ${opportunity.title}`);
    console.log(`      asks sum:       ${opportunity.askSum.toFixed(4)}`);
    console.log(`      fees per set:   $${opportunity.feePerSet.toFixed(4)}`);
    console.log(`      net per set:    $${opportunity.netMarginPerSet.toFixed(4)}`);
    console.log(`      sets available: ${opportunity.maxSets}`);
    console.log(`      total profit:   $${opportunity.maxProfitUsdc.toFixed(2)}`);
  }

  h1('Verdict');
  if (found === 0) {
    console.log('  No executable arbitrage right now.');
    console.log('');
    console.log('  Note what the sums below 1 actually are. A negRisk event guarantees');
    console.log('  the outcomes are mutually exclusive — at most one wins. It does NOT');
    console.log('  guarantee one of them will. On an open candidate list the eventual');
    console.log('  winner may not be listed at all, in which case every leg resolves NO');
    console.log('  and a "full set" pays nothing. That is what a 0.37 sum on a Nobel');
    console.log('  Prize field means: the market saying the winner is probably not here.');
    console.log('');
    console.log('  Only sets with an explicit catch-all outcome are treated as real.');
    console.log('');
    console.log('  Known limitation: a single match (home/draw/away) is exhaustive by');
    console.log('  construction with no catch-all leg, so it is refused here too. That');
    console.log('  costs nothing while those sets quote above 1, which is all of them');
    console.log('  today — but it is the next thing to fix if arb is worth pursuing.');
  } else {
    console.log(`  ${found} executable set(s) found.`);
    console.log('  Verify one by hand before trusting the scanner: open the event on');
    console.log('  Polymarket, add up the ask prices, and confirm it is a single');
    console.log('  event where exactly one outcome can win.');
  }
}

main().catch((err: Error) => {
  console.error('arb-scan failed:', err.message);
  process.exit(1);
});
