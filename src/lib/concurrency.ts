/**
 * Bounded-concurrency map.
 *
 * The scan is almost entirely network wait: a forecast per event, an order book
 * per bucket. Run sequentially that is additive, and the cycle grew from ~26
 * seconds to minutes once the ensemble fetch was added. Run unbounded it would
 * open hundreds of sockets at once and invite rate limiting from both APIs.
 *
 * A small fixed worker pool keeps total time near `slowest / limit` while never
 * having more than `limit` requests outstanding.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];

  const width = Math.max(1, Math.min(limit, items.length));
  const results = new Array<R>(items.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: width }, worker));
  return results;
}

/**
 * Resolves to null instead of rejecting.
 *
 * Used for data that improves a decision but is not required for it — an
 * ensemble forecast sharpens the model's spread, and its absence should cost
 * one fallback to the prior, not the whole event.
 */
export async function optional<T>(promise: Promise<T>): Promise<T | null> {
  try {
    return await promise;
  } catch {
    return null;
  }
}
