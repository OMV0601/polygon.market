/**
 * reality-check — answers one question before any real money is at risk:
 * "does this system actually see tradeable edge, and what would it cost to take it?"
 *
 * Read-only. Touches no wallet, places no orders, writes nothing to the ledger.
 * Run with: npm run reality-check
 *
 * It reports four things, in the order that matters:
 *   1. How much of the market universe discover() actually sees.
 *   2. How many real market titles the weather parser can read.
 *   3. What the spread costs you to enter — the tax every strategy pays.
 *   4. Whether the correlation-arb scan has any surface to work with.
 */

import { httpGet } from '../lib/http';
import { parseWeatherMarket } from '../strategies/weather/parsers/MarketParser';
import { RISK } from '../config/constants';

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';

interface GammaMarket {
  slug: string;
  question: string;
  bestBid: number | null;
  bestAsk: number | null;
  spread: number | null;
  volume24hr: number;
  liquidityNum: number;
  clobTokenIds: string;
  endDate: string;
}

interface ClobBook {
  bids: Array<{ price: string; size: string }>;
  asks: Array<{ price: string; size: string }>;
}

const h1 = (s: string) => console.log(`\n─── ${s} ${'─'.repeat(Math.max(0, 66 - s.length))}`);
const usd = (n: number) => `$${n.toFixed(2)}`;
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

/** Gamma caps page size at 500; walk pages until exhausted or cap hit. */
async function fetchAllActive(maxPages = 12): Promise<GammaMarket[]> {
  const all: GammaMarket[] = [];
  for (let page = 0; page < maxPages; page++) {
    const { data } = await httpGet<GammaMarket[]>(
      `${GAMMA}/markets?active=true&closed=false&limit=500&offset=${page * 500}&order=volume24hr&ascending=false`
    );
    if (!data?.length) break;
    all.push(...data);
    if (data.length < 500) break;
  }
  return all;
}

async function main(): Promise<void> {
  console.log('═══ polygon.market — reality check ═══');
  console.log('Read-only. No orders, no wallet, no ledger writes.\n');

  // ── 1. Market universe ────────────────────────────────────────────────────
  h1('1. What the bot can see');

  let universe: GammaMarket[];
  try {
    universe = await fetchAllActive();
  } catch (err) {
    console.log(`✗ Cannot reach Polymarket: ${(err as Error).message}`);
    console.log('  Nothing below can run. Check network access to gamma-api.polymarket.com.');
    process.exit(1);
  }

  const { data: discoverSlice } = await httpGet<GammaMarket[]>(
    `${GAMMA}/markets?active=true&closed=false&limit=100`
  );

  console.log(`Active markets on Polymarket:  ${universe.length}`);
  console.log(`What discover() fetches:       ${discoverSlice?.length ?? 0}`);
  console.log(
    `Coverage:                      ${pct((discoverSlice?.length ?? 0) / Math.max(universe.length, 1))}`
  );

  // discover() passes no sort order, so its 100 are arbitrary, not the best 100.
  const sliceSlugs = new Set((discoverSlice ?? []).map((m) => m.slug));
  const top100ByVolume = universe.slice(0, 100);
  const overlap = top100ByVolume.filter((m) => sliceSlugs.has(m.slug)).length;
  console.log(
    `Of the 100 highest-volume markets, discover() sees: ${overlap}` +
      (overlap < 50 ? '   ← unsorted fetch is missing the liquid markets' : '')
  );

  // ── 2. Weather parser hit rate ────────────────────────────────────────────
  h1('2. Can the weather parser read real market titles?');

  const parsedMarkets = universe
    .map((m) => ({ market: m, parsed: parseWeatherMarket(m.slug, m.question) }))
    .filter((x) => x.parsed !== null);

  // Anything temperature-shaped, regardless of whether our regexes handle it.
  const tempShaped = universe.filter((m) =>
    /temperature|degrees|°f|°c|\bhigh\b.*\b(in|on)\b|hottest|coldest|rain|snow/i.test(m.question)
  );

  console.log(`Temperature/weather-shaped markets found: ${tempShaped.length}`);
  console.log(`Of those, parseWeatherMarket() reads:     ${parsedMarkets.length}`);

  if (tempShaped.length > 0 && parsedMarkets.length === 0) {
    console.log('\n  ⚠ The weather strategy can generate zero candidates against live titles.');
    console.log('    The parser expects "exceed 90°F" / "fall below 32°F" phrasing.');
    console.log('    Real titles look like this:');
    tempShaped.slice(0, 8).forEach((m) => console.log(`      · ${m.question}`));
  } else if (parsedMarkets.length > 0) {
    console.log('\n  Parsed markets:');
    parsedMarkets.slice(0, 10).forEach(({ market, parsed }) =>
      console.log(
        `    · ${market.question}\n      → ${parsed!.city} ${parsed!.direction} ${parsed!.thresholdF}°F, ` +
          `resolves ${parsed!.targetDate.toISOString().slice(0, 10)}`
      )
    );
  }

  // ── 3. The spread tax ─────────────────────────────────────────────────────
  h1('3. What entering a position actually costs');

  // Only markets with real depth are worth measuring; thin ones quote garbage.
  const liquid = universe.filter((m) => m.volume24hr > 10_000 && m.bestBid && m.bestAsk).slice(0, 25);

  if (liquid.length === 0) {
    console.log('No markets above the $10k/24h volume floor. Skipping.');
  } else {
    console.log(`Sampling ${liquid.length} markets above ${usd(10_000)} 24h volume.\n`);
    console.log('  market                                    bid    ask   spread   cost to enter');
    console.log('  ' + '─'.repeat(78));

    const entryCosts: number[] = [];
    for (const m of liquid.slice(0, 12)) {
      const bid = m.bestBid!;
      const ask = m.bestAsk!;
      const mid = (bid + ask) / 2;
      // You buy at the ask but the position is only worth mid — that gap is the
      // instant, guaranteed loss the strategy's edge has to clear first.
      const enterCost = (ask - mid) / mid;
      entryCosts.push(enterCost);
      const title = m.question.length > 40 ? m.question.slice(0, 37) + '...' : m.question.padEnd(40);
      console.log(
        `  ${title}  ${bid.toFixed(3)}  ${ask.toFixed(3)}  ${(ask - bid).toFixed(3)}   ${pct(enterCost).padStart(6)}`
      );
    }

    const median = entryCosts.sort((a, b) => a - b)[Math.floor(entryCosts.length / 2)];
    console.log(`\n  Median cost to enter: ${pct(median)} of position value, paid immediately.`);
    console.log(`  Configured fee assumption (RISK.POLYMARKET_FEE_RATE): ${pct(RISK.POLYMARKET_FEE_RATE)}`);
    console.log(
      `\n  → Any strategy must beat ~${pct(median + RISK.POLYMARKET_FEE_RATE)} per round trip to break even.`
    );
    console.log('    ExecutionEngine.simulateFill() currently fills at mid with no spread and');
    console.log('    no fee, so paper P&L is overstated by roughly this much on every trade.');
  }

  // ── 4. Real depth on one book ─────────────────────────────────────────────
  h1('4. Depth check — can a small order even fill?');

  const probe = liquid[0] ?? universe[0];
  if (probe) {
    try {
      const tokenIds = JSON.parse(probe.clobTokenIds) as string[];
      const { data: book } = await httpGet<ClobBook>(`${CLOB}/book?token_id=${tokenIds[0]}`);
      const asks = (book.asks ?? [])
        .map((a) => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
        .sort((a, b) => a.price - b.price);

      console.log(`Market: ${probe.question}`);
      console.log(`Ask-side levels: ${asks.length}`);

      for (const size of [5, 25, 100]) {
        let remaining = size;
        let spent = 0;
        let shares = 0;
        for (const level of asks) {
          if (remaining <= 0) break;
          const take = Math.min(remaining, level.price * level.size);
          spent += take;
          shares += take / level.price;
          remaining -= take;
        }
        if (remaining > 0) {
          console.log(`  ${usd(size).padStart(7)} order: book too thin to fill`);
        } else {
          const avg = spent / shares;
          const slip = (avg - asks[0].price) / asks[0].price;
          console.log(
            `  ${usd(size).padStart(7)} order: avg fill ${avg.toFixed(4)} vs best ask ${asks[0].price.toFixed(4)} — slippage ${pct(slip)}`
          );
        }
      }
      console.log('\n  Small size is an advantage here: at $5-25 you fill at the top of book.');
    } catch (err) {
      console.log(`Could not read order book: ${(err as Error).message}`);
    }
  }

  // ── 5. Arb surface ────────────────────────────────────────────────────────
  h1('5. Correlation-arb surface');
  console.log(`Scan window: top ${RISK.ARB_SCAN_TOP_N_MARKETS} markets by volume`);
  console.log(`Required gross margin: ${pct(RISK.MIN_ARB_PROFIT_MARGIN + 2 * RISK.POLYMARKET_FEE_RATE)}`);
  console.log('  (MIN_ARB_PROFIT_MARGIN + both legs of fees)');
  console.log('\n  Note: pairing two separate markets by entity name is a correlation bet,');
  console.log('  not an arbitrage — the two can both lose. Genuinely risk-free arb lives');
  console.log('  inside a single multi-outcome event whose outcome prices sum below 1.');

  h1('Verdict');
  const blockers: string[] = [];
  if ((discoverSlice?.length ?? 0) < universe.length * 0.2)
    blockers.push('discover() sees a small unsorted slice of the market universe');
  if (parsedMarkets.length === 0 && tempShaped.length > 0)
    blockers.push('weather parser matches zero live market titles');
  blockers.push('simulateFill() fills at mid — paper P&L is optimistic, not a track record');
  blockers.push('no live execution path exists (executeBuy and liveFill both throw)');

  blockers.forEach((b, i) => console.log(`  ${i + 1}. ${b}`));
  console.log('\nEach of these has to close before paper results mean anything.');
}

main().catch((err: Error) => {
  console.error('reality-check failed:', err.message);
  process.exit(1);
});
