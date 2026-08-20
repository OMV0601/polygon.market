import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapWithConcurrency, optional } from '../../src/lib/concurrency';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('results keep input order regardless of completion order', () => {
  // Order matters here: order books are zipped back against their buckets by
  // index, so a reordered result would price the wrong market.
  return mapWithConcurrency([30, 5, 20, 1], 4, async (ms, i) => {
    await sleep(ms);
    return i;
  }).then((r) => assert.deepEqual(r, [0, 1, 2, 3]));
});

test('no more than `limit` run at once', async () => {
  let active = 0;
  let peak = 0;

  await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
    active++;
    peak = Math.max(peak, active);
    await sleep(5);
    active--;
    return null;
  });

  assert.ok(peak <= 4, `peak concurrency was ${peak}`);
  assert.ok(peak > 1, 'should actually run in parallel');
});

test('concurrency beats sequential on network-shaped work', async () => {
  const items = Array.from({ length: 12 }, () => 20);
  const started = Date.now();
  await mapWithConcurrency(items, 6, async (ms) => sleep(ms));
  const elapsed = Date.now() - started;

  // Sequentially this is 240ms; at width 6 it should be nearer 40ms.
  assert.ok(elapsed < 150, `took ${elapsed}ms`);
});

test('an empty list does no work', async () => {
  assert.deepEqual(await mapWithConcurrency([], 4, async () => 1), []);
});

test('a limit above the item count is harmless', async () => {
  assert.deepEqual(await mapWithConcurrency([1, 2], 99, async (n) => n * 2), [2, 4]);
});

test('optional swallows a rejection into null', async () => {
  assert.equal(await optional(Promise.reject(new Error('boom'))), null);
  assert.equal(await optional(Promise.resolve('ok')), 'ok');
});
