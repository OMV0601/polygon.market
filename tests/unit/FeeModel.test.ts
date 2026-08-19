import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  categoryFor,
  makerRebate,
  takerFee,
  takerFeePerShare,
} from '../../src/core/pricing/FeeModel';

const near = (a: number, b: number, tol = 1e-9) =>
  assert.ok(Math.abs(a - b) < tol, `expected ${a} ≈ ${b}`);

test('the fee is symmetric about 50c', () => {
  // p(1−p) is symmetric, so a 30c fill and a 70c fill cost the same. A model
  // proportional to notional gets this wrong in both directions.
  near(takerFeePerShare(0.3, 'sports'), takerFeePerShare(0.7, 'sports'));
  near(takerFeePerShare(0.1, 'crypto'), takerFeePerShare(0.9, 'crypto'));
});

test('the fee peaks at 50c and vanishes at the bounds', () => {
  const mid = takerFeePerShare(0.5, 'crypto');
  assert.ok(mid > takerFeePerShare(0.3, 'crypto'));
  assert.ok(mid > takerFeePerShare(0.8, 'crypto'));
  near(takerFeePerShare(0, 'crypto'), 0);
  near(takerFeePerShare(1, 'crypto'), 0);
});

test('published per-100-share maxima match the schedule', () => {
  // Max cost per 100 shares is rate × 0.25 × 100.
  near(takerFee(100, 0.5, 'crypto'), 1.75, 1e-9);
  near(takerFee(100, 0.5, 'sports'), 1.25, 1e-9);
  near(takerFee(100, 0.5, 'politics'), 1.0, 1e-9);
  near(takerFee(100, 0.5, 'finance'), 1.0, 1e-9);
});

test('geopolitics is free', () => {
  near(takerFee(1000, 0.5, 'geopolitics'), 0);
});

test('the old flat model understated a mid-priced crypto fill', () => {
  // What the repo used to charge: notional × 1%.
  const shares = 100;
  const price = 0.5;
  const oldFee = shares * price * 0.01;      // $0.50
  const realFee = takerFee(shares, price, 'crypto'); // $1.75
  assert.ok(realFee > oldFee * 3, `real ${realFee} vs old ${oldFee}`);
});

test('makers are charged nothing and rebated a share of the taker fee', () => {
  const rebate = makerRebate(100, 0.5, 'politics');
  near(rebate, takerFee(100, 0.5, 'politics') * 0.25, 1e-9);
  assert.ok(rebate > 0);
});

test('categories map from free text, unknown falls back rather than to zero', () => {
  assert.equal(categoryFor('Bitcoin price on Friday'), 'crypto');
  assert.equal(categoryFor('highest temperature in Munich'), 'weather');
  assert.equal(categoryFor('NBA finals winner'), 'sports');
  assert.equal(categoryFor('2028 presidential election'), 'politics');
  // Assuming zero fee where one exists is the error that flatters a backtest.
  assert.equal(categoryFor('something entirely unclassifiable'), 'default');
  assert.ok(takerFeePerShare(0.5, categoryFor('unclassifiable')) > 0);
});
