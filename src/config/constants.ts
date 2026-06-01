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

  // Module B
  MAX_WEATHER_HORIZON_HOURS: 72,
  MAX_FORECAST_STALENESS_HOURS: 1,

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
