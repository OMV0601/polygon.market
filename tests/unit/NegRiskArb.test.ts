import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findArbitrage,
  type NegRiskEvent,
} from '../../src/strategies/negrisk/NegRiskConsistencyModel';

function event(asks: number[], depthUsdc = 10_000, isComplete = true): NegRiskEvent {
  return {
    eventId: 'e1',
    title: 'test event',
    isComplete,
    category: 'politics',
    outcomes: asks.map((a, i) => ({
      tokenId: `t${i}`,
      marketSlug: `m${i}`,
      title: `outcome ${i}`,
      bestAsk: a,
      askDepthUsdc: depthUsdc,
    })),
  };
}

test('a set summing well below 1 is arbitrage', () => {
  // Four legs at 0.20 cost 0.80 for a guaranteed $1 payout.
  const r = findArbitrage(event([0.2, 0.2, 0.2, 0.2]), 500);
  assert.ok(r, 'expected an opportunity');
  assert.ok(Math.abs(r.askSum - 0.8) < 1e-9);
  assert.ok(r.netMarginPerSet > 0.15, `margin was ${r.netMarginPerSet}`);
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

test('an incomplete set is never arbitrage regardless of price', () => {
  // Without the venue's guarantee that one outcome must win, a cheap set is a
  // directional bet that can lose every leg. This is the failure the previous
  // title-matching strategy had.
  assert.equal(findArbitrage(event([0.1, 0.1, 0.1, 0.1], 10_000, false), 500), null);
});

test('the thinnest leg caps the number of sets', () => {
  const e = event([0.25, 0.25, 0.25, 0.2]);
  e.outcomes[2].askDepthUsdc = 5; // only $5 behind this leg → 20 sets
  const r = findArbitrage(e, 10_000);
  assert.ok(r);
  assert.equal(r.maxSets, 20);
});

test('capital caps the number of sets when the book is deep', () => {
  const r = findArbitrage(event([0.2, 0.2, 0.2, 0.2]), 100);
  assert.ok(r);
  // $100 at $0.80 a set = 125 sets.
  assert.equal(r.maxSets, 125);
});

test('a leg with no offer is rejected rather than assumed free', () => {
  const e = event([0.2, 0.2, 0.2, 0.2]);
  e.outcomes[1].bestAsk = NaN;
  assert.equal(findArbitrage(e, 500), null);

  const zero = event([0.2, 0.2, 0.2, 0.2]);
  zero.outcomes[1].bestAsk = 0;
  assert.equal(findArbitrage(zero, 500), null);
});

test('a two-leg set is not treated as a negRisk opportunity', () => {
  // Guarded by the caller, but assert the model tolerates it rather than
  // producing a bogus single-leg "arb".
  const r = findArbitrage(event([0.4]), 500);
  assert.equal(r, null);
});

test('profit scales with sets and leg sizes sum to the set cost', () => {
  const r = findArbitrage(event([0.2, 0.2, 0.2, 0.2]), 100);
  assert.ok(r);
  const legTotal = r.legs.reduce((a, l) => a + l.sizeUsdc, 0);
  assert.ok(Math.abs(legTotal - r.maxSets * r.askSum) < 1e-6);
  assert.ok(Math.abs(r.maxProfitUsdc - r.maxSets * r.netMarginPerSet) < 1e-6);
});

test('fees alone can erase a gross margin, and the category decides', () => {
  // Four legs at 0.24 sum to 0.96 — a 4c gross margin per set. Crypto charges
  // 0.07 x p x (1-p) per leg, about 1.28c each, so 5.1c of fees turn a
  // seemingly free 4c into a loss. The same set in a zero-fee category is real.
  const crypto = findArbitrage({ ...event([0.24, 0.24, 0.24, 0.24]), category: 'crypto' }, 500);
  assert.equal(crypto, null, 'crypto fees should exceed a 4c gross margin');

  const geo = findArbitrage({ ...event([0.24, 0.24, 0.24, 0.24]), category: 'geopolitics' }, 500);
  assert.ok(geo, 'the same prices are profitable where there is no fee');
  assert.ok(geo.netMarginPerSet > 0.03);
});

test('a wide enough margin survives even the highest fee tier', () => {
  const crypto = findArbitrage({ ...event([0.2, 0.2, 0.2, 0.2]), category: 'crypto' }, 500);
  assert.ok(crypto);
  assert.ok(crypto.netMarginPerSet > 0.1, `got ${crypto?.netMarginPerSet}`);
});
