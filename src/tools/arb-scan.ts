/**
 * arb-scan — looks for negRisk outcome sets whose asks sum below $1.
 *
 * Read-only. Places no orders and writes nothing to the ledger.
 * Run with: npm run arb-scan
 *
 * The appeal of this over the forecast strategy is that it does not require
 * being right about anything. A negRisk event is a set the protocol guarantees
 * has exactly one winner, so a full set pays exactly $1 at resolution. If it
 * costs less than $1 net of fees, the difference is the profit, regardless of
 * which outcome wins.
 *
 * The catch is depth. A sub-$1 sum on the screen is worthless if the thinnest
 * leg only has a few dollars behind it, so this walks the real book on every
 * leg rather than trusting the quoted best ask.
 */

import { PolymarketClient } from '../core/polymarket/PolymarketClient';
import { findArbitrage } from '../strategies/negrisk/NegRiskConsistencyModel';
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

    const opportunity = findArbitrage({ ...event, outcomes: withDepth }, CAPITAL_USDC);
    return { event, opportunity, reason: opportunity ? 'profitable' : 'no margin after fees' };
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
    console.log('  This is the expected result most of the time — these are the most');
    console.log('  competed-for opportunities on the venue and they close in seconds.');
    console.log('  What matters is whether any appear at all over repeated scans.');
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
