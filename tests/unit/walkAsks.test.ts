import { test } from 'node:test';
import assert from 'node:assert/strict';
import { walkAsks } from '../../src/execution/ExecutionEngine';

const near = (a: number, b: number, tol = 1e-6) =>
  assert.ok(Math.abs(a - b) < tol, `expected ${a} ≈ ${b}`);

test('a small order fills entirely at the top of book', () => {
  const asks = [
    { price: 0.30, size: 1000 },
    { price: 0.31, size: 1000 },
  ];
  const r = walkAsks(asks, 10);
  near(r.spent, 10);
  near(r.spent / r.shares, 0.30);
  near(r.unfilledUsdc, 0);
});

test('an order larger than the top level pays a worse average', () => {
  const asks = [
    { price: 0.30, size: 100 },  // holds $30
    { price: 0.40, size: 100 },  // holds $40
  ];
  const r = walkAsks(asks, 50);
  const avg = r.spent / r.shares;
  assert.ok(avg > 0.30 && avg < 0.40, `got ${avg}`);
  near(r.spent, 50);
});

test('levels are consumed cheapest first regardless of input order', () => {
  const shuffled = [
    { price: 0.50, size: 100 },
    { price: 0.20, size: 100 },
    { price: 0.35, size: 100 },
  ];
  const r = walkAsks(shuffled, 20);
  near(r.spent / r.shares, 0.20);
});

test('a thin book reports the unfilled remainder', () => {
  const asks = [{ price: 0.50, size: 10 }]; // only $5 available
  const r = walkAsks(asks, 25);
  near(r.spent, 5);
  near(r.unfilledUsdc, 20);
});

test('an empty book fills nothing', () => {
  const r = walkAsks([], 10);
  near(r.shares, 0);
  near(r.spent, 0);
  near(r.unfilledUsdc, 10);
});

test('zero-priced levels are skipped rather than dividing by zero', () => {
  const r = walkAsks([{ price: 0, size: 100 }, { price: 0.25, size: 100 }], 10);
  assert.ok(Number.isFinite(r.shares));
  near(r.spent / r.shares, 0.25);
});
