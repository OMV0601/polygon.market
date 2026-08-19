import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  correlationGroupFor,
  sizePosition,
} from '../../src/core/risk/PositionSizer';

const base = {
  bankroll: 600,
  maxPositionPct: 5,
  maxGroupPct: 3,
  groupExposureUsdc: 0,
  fillableUsdc: 1000,
};

test('quarter Kelly is a quarter of the full fraction', () => {
  // q=0.38, p=0.30 → full Kelly (0.38−0.30)/0.70 = 11.4%, quarter = 2.86%
  const r = sizePosition({ ...base, q: 0.38, price: 0.30 });
  assert.ok(Math.abs(r.fullKellyFraction - 0.1142857) < 1e-6);
  assert.ok(Math.abs(r.appliedFraction - r.fullKellyFraction * 0.25) < 1e-9);
  // 2.86% of 600 ≈ $17, which the 3% group cap trims to $18 max — under it.
  assert.ok(r.sizeUsdc > 15 && r.sizeUsdc < 18, `got ${r.sizeUsdc}`);
});

test('no edge means no position', () => {
  assert.equal(sizePosition({ ...base, q: 0.30, price: 0.30 }).sizeUsdc, 0);
  assert.equal(sizePosition({ ...base, q: 0.20, price: 0.30 }).sizeUsdc, 0);
  assert.equal(sizePosition({ ...base, q: 0.9, price: 0.30, bankroll: 0 }).sizeUsdc, 0);
});

test('a huge edge is still capped by position and group limits', () => {
  // Full Kelly here would be enormous; the caps are what keep it sane.
  const r = sizePosition({ ...base, q: 0.95, price: 0.10 });
  assert.ok(r.sizeUsdc <= (base.maxGroupPct / 100) * base.bankroll);
  assert.equal(r.boundBy, 'group-cap');
});

test('existing exposure in the group reduces what is left', () => {
  // 3% of 600 = $18 for the group. With $12 already deployed, $6 remains.
  const partial = sizePosition({ ...base, q: 0.95, price: 0.10, groupExposureUsdc: 12 });
  assert.equal(partial.sizeUsdc, 6);
  assert.equal(partial.boundBy, 'group-cap');

  // Once the remainder is below the minimum worth trading, nothing is taken.
  const exhausted = sizePosition({ ...base, q: 0.95, price: 0.10, groupExposureUsdc: 17.5 });
  assert.equal(exhausted.sizeUsdc, 0);
});

test('a thin book caps the size regardless of edge', () => {
  const r = sizePosition({ ...base, q: 0.9, price: 0.2, fillableUsdc: 4 });
  assert.equal(r.sizeUsdc, 4);
  assert.equal(r.boundBy, 'liquidity');
});

test('a shrinking bankroll shrinks positions automatically', () => {
  const big = sizePosition({ ...base, q: 0.45, price: 0.35, bankroll: 600 });
  const small = sizePosition({ ...base, q: 0.45, price: 0.35, bankroll: 300 });
  assert.ok(small.sizeUsdc < big.sizeUsdc);
});

test('buckets on the same city and date share one correlation group', () => {
  // They resolve off the same reading, so a forecast error hits all of them.
  const a = correlationGroupFor('highest-temperature-in-munich-on-august-19-2026-27c');
  const b = correlationGroupFor('highest-temperature-in-munich-on-august-19-2026-28c');
  const c = correlationGroupFor('highest-temperature-in-munich-on-august-20-2026-27c');
  const d = correlationGroupFor('highest-temperature-in-paris-on-august-19-2026-27c');

  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.notEqual(a, d);
});
