import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  exhaustivenessOf,
  findArbitrage,
  type NegRiskEvent,
} from '../../src/strategies/negrisk/NegRiskConsistencyModel';

/**
 * Builds a test event. The last outcome is named "Other" by default, since a
 * set without a catch-all is not exhaustive and the model refuses it outright —
 * these fixtures are for exercising pricing and sizing, not that guard.
 */
function event(
  asks: number[],
  opts: { depthUsdc?: number; isComplete?: boolean; catchAll?: boolean } = {}
): NegRiskEvent {
  const { depthUsdc = 10_000, isComplete = true, catchAll = true } = opts;
  return {
    eventId: 'e1',
    title: 'test event',
    isComplete,
    category: 'politics',
    outcomes: asks.map((a, i) => ({
      tokenId: `t${i}`,
      marketSlug: `m${i}`,
      title: catchAll && i === asks.length - 1 ? 'Other' : `outcome ${i}`,
      bestAsk: a,
      askDepthUsdc: depthUsdc,
    })),
  };
}

test('an exhaustive set below 1 after fees is arbitrage', () => {
  // Four legs at 0.23 cost 0.92 for a payout of exactly $1.
  const r = findArbitrage(event([0.23, 0.23, 0.23, 0.23]), 500);
  assert.ok(r, 'expected an opportunity');
  assert.ok(Math.abs(r.askSum - 0.92) < 1e-9);
  assert.ok(r.netMarginPerSet > 0.04, `margin was ${r.netMarginPerSet}`);
  assert.equal(r.legs.length, 4);
});

test('a set summing above 1 is not', () => {
  // The normal state: the excess over 1 is the makers' margin.
  assert.equal(findArbitrage(event([0.3, 0.3, 0.3, 0.3]), 500), null);
});

test('a set barely below 1 is rejected once fees and buffer are charged', () => {
  // 0.995 looks like free money and is not: fees plus the adverse-move buffer
  // exceed the half-cent of margin.
  assert.equal(findArbitrage(event([0.249, 0.249, 0.249, 0.248]), 500), null);
});

test('a set the venue has not marked negRisk is never arbitrage', () => {
  assert.equal(
    findArbitrage(event([0.23, 0.23, 0.23, 0.23], { isComplete: false }), 500),
    null
  );
});

test('the thinnest leg caps the number of sets', () => {
  const e = event([0.25, 0.25, 0.25, 0.2]);
  e.outcomes[2].askDepthUsdc = 5; // only $5 behind this leg → 20 sets
  const r = findArbitrage(e, 10_000);
  assert.ok(r);
  assert.equal(r.maxSets, 20);
});

test('capital caps the number of sets when the book is deep', () => {
  const r = findArbitrage(event([0.23, 0.23, 0.23, 0.23]), 100);
  assert.ok(r);
  // $100 at $0.92 a set = 108 whole sets.
  assert.equal(r.maxSets, 108);
});

test('a leg with no offer is rejected rather than assumed free', () => {
  const missing = event([0.23, 0.23, 0.23, 0.23]);
  missing.outcomes[1].bestAsk = NaN;
  assert.equal(findArbitrage(missing, 500), null);

  const zero = event([0.23, 0.23, 0.23, 0.23]);
  zero.outcomes[1].bestAsk = 0;
  assert.equal(findArbitrage(zero, 500), null);
});

test('profit scales with sets and leg sizes sum to the set cost', () => {
  const r = findArbitrage(event([0.23, 0.23, 0.23, 0.23]), 100);
  assert.ok(r);
  const legTotal = r.legs.reduce((a, l) => a + l.sizeUsdc, 0);
  assert.ok(Math.abs(legTotal - r.maxSets * r.askSum) < 1e-6);
  assert.ok(Math.abs(r.maxProfitUsdc - r.maxSets * r.netMarginPerSet) < 1e-6);
});

test('fees alone can erase a gross margin, and the category decides', () => {
  // Four legs at 0.24 sum to 0.96 — a 4c gross margin per set. Crypto charges
  // 0.07 x p x (1-p) per leg, about 1.28c each, so 5.1c of fees turn a
  // seemingly free 4c into a loss. The same set in a zero-fee category is real.
  const crypto = findArbitrage(
    { ...event([0.24, 0.24, 0.24, 0.24]), category: 'crypto' },
    500
  );
  assert.equal(crypto, null, 'crypto fees should exceed a 4c gross margin');

  const geo = findArbitrage(
    { ...event([0.24, 0.24, 0.24, 0.24]), category: 'geopolitics' },
    500
  );
  assert.ok(geo, 'the same prices are profitable where there is no fee');
  assert.ok(geo.netMarginPerSet > 0.03);
});

test('a wide enough margin survives even the highest fee tier', () => {
  const crypto = findArbitrage(
    { ...event([0.2275, 0.2275, 0.2275, 0.2275]), category: 'crypto' },
    500
  );
  assert.ok(crypto);
  assert.ok(crypto.netMarginPerSet > 0.03, `got ${crypto?.netMarginPerSet}`);
});

// ── The guard the live scan turned out to need ──────────────────────────────

test('mutual exclusivity is not exhaustiveness', () => {
  // "Republican Presidential Nominee 2028" is a real negRisk event whose 42
  // legs summed to 0.909, which an earlier version of this model reported as a
  // $33 profit. It is not: if the nominee is someone not on the list, all 42
  // legs resolve NO and the entire stake is lost. The 9% discount is the market
  // pricing an unlisted winner, correctly.
  const openField = event(Array(42).fill(0.909 / 42), { catchAll: false });
  assert.equal(findArbitrage(openField, 500), null);

  // The same prices with a catch-all leg describe a genuinely closed set.
  const closed = event(Array(42).fill(0.909 / 42), { catchAll: true });
  assert.ok(findArbitrage(closed, 500), 'a catch-all closes the set');
});

test('an implausibly low sum is a broken market, not an opportunity', () => {
  // Seen live: a 20-leg Nobel Prize field at 0.366, a 3-leg primary at 0.003.
  // Neither is a 63% or 99% edge — they are open fields and stale quotes. Even
  // with a catch-all present, a sum this far below 1 means something is wrong
  // rather than that free money is lying around.
  assert.equal(findArbitrage(event(Array(20).fill(0.366 / 20)), 500), null);
  assert.equal(findArbitrage(event([0.001, 0.001, 0.001]), 500), null);
});

test('exhaustivenessOf recognises the common catch-all phrasings', () => {
  for (const title of [
    'Other',
    'Another candidate',
    'Someone else',
    'The Field',
    'None of the above',
  ]) {
    assert.equal(
      exhaustivenessOf([{ title: 'Alice' }, { title }]).exhaustive,
      true,
      `expected "${title}" to close the set`
    );
  }
  assert.equal(exhaustivenessOf([{ title: 'Alice' }, { title: 'Bob' }]).exhaustive, false);
});

test('a single fixture is exhaustive without a catch-all leg', () => {
  // Home/draw/away is closed by construction: no third team can appear, so
  // there is no catch-all leg and none is needed. Refusing these was wrong.
  // 0.93, not 0.88: a sum below the plausibility floor is refused regardless
  // of exhaustiveness, which is the floor doing its job.
  const match = event([0.31, 0.31, 0.31], { catchAll: false });
  match.title = 'LASK Linz vs. Celtic FC';
  const { exhaustive, reason } = exhaustivenessOf(match.outcomes, match.title);
  assert.equal(exhaustive, true, reason);
  assert.ok(findArbitrage(match, 500), 'a genuinely cheap fixture is arbitrage');
});

test('a long candidate list is not rescued by a "vs" in the title', () => {
  // Both conditions must hold. A 42-name field is not a fixture whatever the
  // title says, and matching on the title alone would reopen the exact hole
  // the Republican Nominee case exposed.
  const wide = event(Array(42).fill(0.909 / 42), { catchAll: false });
  wide.title = 'Candidate A vs. the field 2028';
  assert.equal(exhaustivenessOf(wide.outcomes, wide.title).exhaustive, false);
  assert.equal(findArbitrage(wide, 500), null);
});

test('a fixture quoting above 1 is still refused, just for the right reason', () => {
  const match = event([0.34, 0.34, 0.34], { catchAll: false });
  match.title = 'Real Madrid CF vs. Real Sociedad de Fútbol';
  assert.equal(exhaustivenessOf(match.outcomes, match.title).exhaustive, true);
  assert.equal(findArbitrage(match, 500), null, 'sum 1.02 costs more than it pays');
});
