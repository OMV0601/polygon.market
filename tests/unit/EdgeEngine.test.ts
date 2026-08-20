import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateEdge } from '../../src/core/edge/EdgeEngine';

const deepBook = {
  bids: [{ price: 0.29, size: 5000 }],
  asks: [{ price: 0.30, size: 5000 }],
  bestBid: 0.29,
  bestAsk: 0.30,
  category: 'weather' as const,
  intendedSizeUsdc: 20,
  confidence: 1,
};

test('a large edge crosses the spread', () => {
  const r = evaluateEdge({ ...deepBook, q: 0.45 });
  assert.equal(r.action, 'TAKE');
  assert.ok(r.takerEdgeCentsPerShare > 0);
});

test('no edge passes', () => {
  const r = evaluateEdge({ ...deepBook, q: 0.28 });
  assert.equal(r.action, 'PASS');
  assert.ok(r.takerEdgeCentsPerShare < 0);
});

test('a thin edge quotes instead of taking', () => {
  // Enough edge to be worth resting on, not enough to justify paying the
  // spread and the fee to cross. The old design could only take or pass.
  const r = evaluateEdge({ ...deepBook, q: 0.325 });
  assert.equal(r.action, 'QUOTE');
  assert.ok(r.makerEdgeCentsPerShare > r.takerEdgeCentsPerShare);
});

test('the maker side is always better than the taker side at the same q', () => {
  // Makers skip the fee, skip the spread, and collect a rebate.
  const r = evaluateEdge({ ...deepBook, q: 0.40 });
  assert.ok(r.makerEdgeCentsPerShare > r.takerEdgeCentsPerShare);
});

test('low confidence shrinks the edge toward the market price', () => {
  const sure = evaluateEdge({ ...deepBook, q: 0.45, confidence: 1 });
  const unsure = evaluateEdge({ ...deepBook, q: 0.45, confidence: 0.5 });
  assert.ok(unsure.takerEdgeCentsPerShare < sure.takerEdgeCentsPerShare);
});

test('volatility penalises resting orders but not crossing ones', () => {
  const calm = evaluateEdge({ ...deepBook, q: 0.35, recentVolatility: 0 });
  const fast = evaluateEdge({ ...deepBook, q: 0.35, recentVolatility: 0.04 });
  assert.ok(fast.makerEdgeCentsPerShare < calm.makerEdgeCentsPerShare);
  assert.ok(Math.abs(fast.takerEdgeCentsPerShare - calm.takerEdgeCentsPerShare) < 1e-9);
});

test('an empty book passes rather than pretending to fill', () => {
  const r = evaluateEdge({ ...deepBook, q: 0.9, asks: [] });
  assert.equal(r.action, 'PASS');
  assert.equal(r.fillableUsdc, 0);
});

test('a thin book raises the average fill and shrinks the edge', () => {
  const thin = evaluateEdge({
    ...deepBook,
    q: 0.45,
    asks: [
      { price: 0.30, size: 10 },   // only $3 here
      { price: 0.40, size: 1000 },
    ],
  });
  const deep = evaluateEdge({ ...deepBook, q: 0.45 });
  assert.ok(thin.avgFillPrice > deep.avgFillPrice);
  assert.ok(thin.takerEdgeCentsPerShare < deep.takerEdgeCentsPerShare);
});

test('the fee charged matches the price actually filled at', () => {
  const r = evaluateEdge({ ...deepBook, q: 0.45 });
  // weather rate 0.05 at p=0.30 → 0.05 × 0.3 × 0.7 = 0.0105
  assert.ok(Math.abs(r.feePerShare - 0.0105) < 1e-6);
});
