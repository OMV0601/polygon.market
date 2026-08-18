import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bucketProbability,
  bucketSetCoverage,
  sigmaForHorizon,
} from '../../src/strategies/weather/ForecastDistribution';

const near = (a: number, b: number, tol = 1e-6) =>
  assert.ok(Math.abs(a - b) < tol, `expected ${a} ≈ ${b}`);

test('uncertainty grows with forecast lead time', () => {
  const short = sigmaForHorizon(6, 'C');
  const long = sigmaForHorizon(72, 'C');
  assert.ok(long > short, 'a 72h forecast must be wider than a 6h one');
  // The old model used one fixed width for every horizon; this is the fix.
  assert.ok(long / short > 1.5);
});

test('sigma converts as a width, without the freezing-point offset', () => {
  near(sigmaForHorizon(24, 'F'), sigmaForHorizon(24, 'C') * 1.8, 1e-9);
});

test('the bucket containing the forecast holds the most mass', () => {
  const args = { forecast: 30.0, unit: 'C' as const, horizonHours: 12 };

  const onTarget = bucketProbability({ ...args, lowerEdge: 29.5, upperEdge: 30.5 });
  const oneOff = bucketProbability({ ...args, lowerEdge: 30.5, upperEdge: 31.5 });
  const threeOff = bucketProbability({ ...args, lowerEdge: 32.5, upperEdge: 33.5 });

  assert.ok(onTarget > oneOff);
  assert.ok(oneOff > threeOff);
  assert.ok(onTarget > 0.2 && onTarget < 0.6, `got ${onTarget}`);
});

test('a far-out forecast flattens the distribution', () => {
  const bucket = { lowerEdge: 29.5, upperEdge: 30.5, forecast: 30.0, unit: 'C' as const };
  const soon = bucketProbability({ ...bucket, horizonHours: 6 });
  const later = bucketProbability({ ...bucket, horizonHours: 70 });
  assert.ok(soon > later, 'confidence must decay with horizon');
});

test('open-ended catch-all buckets carry the tail', () => {
  const args = { forecast: 30.0, unit: 'C' as const, horizonHours: 24 };

  const above = bucketProbability({ ...args, lowerEdge: 34.5, upperEdge: Infinity });
  const below = bucketProbability({ ...args, lowerEdge: -Infinity, upperEdge: 25.5 });

  assert.ok(above > 0 && above < 0.05, `got ${above}`);
  assert.ok(below > 0 && below < 0.05, `got ${below}`);
});

test('an exhaustive bucket set covers ~all the probability', () => {
  const buckets = [
    { lowerEdge: -Infinity, upperEdge: 26.5 },
    ...[27, 28, 29, 30, 31, 32, 33].map((t) => ({ lowerEdge: t - 0.5, upperEdge: t + 0.5 })),
    { lowerEdge: 33.5, upperEdge: Infinity },
  ];
  near(bucketSetCoverage(buckets, 30, 'C', 24), 1, 1e-6);
});

test('a set missing its catch-alls reports low coverage', () => {
  // This is the guard against trading edges computed from a partial series.
  const partial = [30, 31].map((t) => ({ lowerEdge: t - 0.5, upperEdge: t + 0.5 }));
  assert.ok(bucketSetCoverage(partial, 30, 'C', 24) < 0.7);
});
