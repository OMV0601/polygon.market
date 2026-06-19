// Shared market-slug helpers for grouping and quality classification.
// Polymarket slugs are lowercase hyphenated, e.g.
//   fifwc-can-bih-2026-06-12-exact-score-2-1
//   will-japan-win-the-2026-fifa-world-cup-112
//   spacex-ipo-closing-market-cap-above-1pt8t-631-261

// Extract the underlying *event* key from a market slug so that correlated
// markets (different bets on the same match/event) share one exposure budget.
// The event key is always a prefix of the full slug, so it can be used in a
// `LIKE eventKey || '%'` query.
export function eventKey(slug: string): string {
  // Anchor on a calendar date: everything up to and including YYYY-MM-DD is
  // the event (covers all sports markets: moneyline, totals, scores, halves).
  const dateMatch = slug.match(/^(.*?\d{4}-\d{2}-\d{2})/);
  if (dateMatch) return dateMatch[1];
  // Otherwise strip a trailing numeric market id (e.g. -112, -631-261).
  return slug.replace(/(?:-\d+)+$/, '');
}

// Crypto price markets — we only want prediction/event markets, never these.
const CRYPTO_PREFIX = /^(btc|eth|sol|matic|bnb|xrp|doge|ada|avax|link|ltc|crypto)-/i;

// Structurally -EV longshots / noise sub-markets we never want to mirror.
const LOW_QUALITY_PATTERNS: RegExp[] = [
  /exact-score/i,      // lottery-ticket scorelines
  /correct-score/i,
  /halftime/i,         // sub-game noise
  /-1st-half/i,
  /-2nd-half/i,
  /first-goalscorer/i, // pure longshots
  /anytime-scorer/i,
];

// True if this market should be skipped by the wallet-mirror strategy.
export function isLowQualityMarket(slug: string): boolean {
  if (CRYPTO_PREFIX.test(slug)) return true;
  return LOW_QUALITY_PATTERNS.some((p) => p.test(slug));
}
