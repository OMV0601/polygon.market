export const BULLPEN = {
  TIMEOUT_MS: 5_000,
  MAX_RETRIES: 3,
  BACKOFF_BASE_MS: 500,
} as const;

export const STRATEGY_INTERVALS = {
  WALLET_MIRROR_MS: 5 * 60 * 1_000,        // Module A: 5 min
  WEATHER_MS: 10 * 60 * 1_000,              // Module B: 10 min
  NEWS_CATALYST_MS: 2 * 60 * 1_000,         // Module C: 2 min (breaking news)
  CORRELATION_ARB_MS: 15 * 60 * 1_000,      // Module D: 15 min
} as const;

export const RISK = {
  // Module A
  MIN_VOLUME_24H_USDC: 10_000,
  MAX_SMART_MONEY_PRICE_DELTA: 0.03,
  MAX_WALLET_MIRROR_SPREAD: 0.04,

  // Module A — quality, concentration & pacing controls
  MAX_EVENT_EXPOSURE_PCT: 3,              // max % of bankroll per underlying event
  MAX_TRADES_PER_CYCLE: 4,                // pace deployment — no bankroll dumps
  MIN_IMPLIED_PROBABILITY: 0.30,          // skip longshots / lottery tickets
  MAX_IMPLIED_PROBABILITY: 0.70,          // skip capital-inefficient near-certainties
  MIN_SMART_MONEY_CONVICTION_USDC: 100,   // wallet must bet >= this to signal conviction
  SMART_MONEY_CONVICTION_REF_USDC: 1_000, // bet size that maps to full conviction score
  WALLET_MIRROR_BASE_SIZE_FRACTION: 0.5,  // floor fraction of max per-trade size

  // Module B
  MAX_WEATHER_HORIZON_HOURS: 72,
  MAX_FORECAST_STALENESS_HOURS: 1,

  // Module B — temperature bucket markets
  // Minimum gap between our modelled probability and the ask before we act.
  // Measured entry cost in these markets is ~1.7c of spread, so this leaves
  // room for the forecast model being wrong as well as for the spread.
  WEATHER_MIN_EDGE: 0.08,
  // Skip buckets priced where the model is least trustworthy: deep longshots
  // and near-certainties both sit in the distribution's thin tails.
  WEATHER_MIN_ASK: 0.05,
  WEATHER_MAX_ASK: 0.90,
  // If modelled probability across an event's scraped buckets sums below this,
  // the bucket set is missing outcomes and the event is skipped. Raised from
  // 0.70: at that level a third of the distribution could lie outside the
  // buckets we can see, and any comparison against the market is guesswork.
  WEATHER_MIN_COVERAGE: 0.90,
  // Probabilities are only rescaled to sum to 1 when the set is this complete.
  // Normalising a partial set inflates every bucket by 1/coverage, which
  // manufactures edge from arithmetic rather than from a forecast.
  WEATHER_NORMALIZE_COVERAGE: 0.98,
  // Cap positions per event so one city's forecast error can't dominate.
  WEATHER_MAX_BUCKETS_PER_EVENT: 2,
  // Temperature markets are thinner than the wallet-mirror floor assumes:
  // median ~$3k/24h, all above $1k. Depth at our size is checked separately.
  WEATHER_MIN_VOLUME_24H_USDC: 1_000,

  // Module C
  MAX_NEWS_PRICED_IN_MOVE_PCT: 0.15,
  NEWS_LOOKBACK_MINUTES: 15,

  // Module D
  MIN_ARB_PROFIT_MARGIN: 0.015,
  POLYMARKET_FEE_RATE: 0.01,
  ARB_SCAN_TOP_N_MARKETS: 100,
} as const;

export const DB = {
  BUSY_TIMEOUT_MS: 5_000,
  WAL_MODE: true,
} as const;
