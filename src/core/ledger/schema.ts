// SQLite DDL. Run in order — each table depends only on prior ones.
// Never ALTER TABLE here; add new migration functions in Database.ts instead.

export const SCHEMA_VERSION = 2;

export const DDL: string[] = [
  // ── Schema versioning ──────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS schema_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,

  // ── Known markets ─────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS markets (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    slug          TEXT    UNIQUE NOT NULL,
    title         TEXT    NOT NULL,
    category      TEXT,
    volume_24h    REAL    NOT NULL DEFAULT 0,
    best_bid      REAL,
    best_ask      REAL,
    liquidity     REAL,
    end_date      TEXT,
    last_fetched  TEXT    NOT NULL,
    created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,

  `CREATE INDEX IF NOT EXISTS idx_markets_category ON markets(category)`,
  `CREATE INDEX IF NOT EXISTS idx_markets_volume    ON markets(volume_24h DESC)`,

  // ── Evaluated candidates (all, pass and fail) ─────────────────────────────
  `CREATE TABLE IF NOT EXISTS candidates (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    market_slug           TEXT    NOT NULL,
    strategy              TEXT    NOT NULL,   -- WALLET_MIRROR|WEATHER|NEWS_CATALYST|CORRELATION_ARB
    outcome               TEXT    NOT NULL,   -- YES|NO
    implied_probability   REAL    NOT NULL,
    external_signal       TEXT,              -- JSON blob of raw external data
    confidence_score      REAL,
    suggested_size        REAL,
    risk_status           TEXT    NOT NULL DEFAULT 'PENDING',  -- PENDING|APPROVED|REJECTED|SIMULATED|EXECUTED
    risk_rejection_reason TEXT,
    risk_rejection_detail TEXT,
    created_at            TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,

  `CREATE INDEX IF NOT EXISTS idx_candidates_slug   ON candidates(market_slug)`,
  `CREATE INDEX IF NOT EXISTS idx_candidates_status ON candidates(risk_status)`,
  `CREATE INDEX IF NOT EXISTS idx_candidates_ts     ON candidates(created_at DESC)`,

  // ── Active and closed positions ───────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS positions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    market_slug     TEXT    NOT NULL,
    outcome         TEXT    NOT NULL,
    shares          REAL    NOT NULL,
    entry_price     REAL    NOT NULL,
    current_price   REAL,
    realized_pnl    REAL,
    status          TEXT    NOT NULL DEFAULT 'OPEN',    -- OPEN|CLOSED|SIMULATED_OPEN|SIMULATED_CLOSED
    candidate_id    INTEGER REFERENCES candidates(id),
    opened_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    closed_at       TEXT
  )`,

  `CREATE INDEX IF NOT EXISTS idx_positions_slug   ON positions(market_slug)`,
  `CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status)`,

  // ── Tracked wallet transactions (Module A) ────────────────────────────────
  `CREATE TABLE IF NOT EXISTS wallet_transactions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet_address  TEXT    NOT NULL,
    wallet_alias    TEXT,
    market_slug     TEXT    NOT NULL,
    outcome         TEXT    NOT NULL,
    side            TEXT    NOT NULL,   -- BUY|SELL
    fill_price      REAL    NOT NULL,
    share_count     REAL    NOT NULL,
    total_cost      REAL    NOT NULL,
    tx_hash         TEXT    UNIQUE,
    observed_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,

  `CREATE INDEX IF NOT EXISTS idx_wallet_tx_address ON wallet_transactions(wallet_address)`,
  `CREATE INDEX IF NOT EXISTS idx_wallet_tx_slug    ON wallet_transactions(market_slug)`,

  // ── Full execution audit log ──────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS execution_log (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    candidate_id     INTEGER REFERENCES candidates(id),
    action           TEXT    NOT NULL,    -- BUY|SELL
    market_slug      TEXT    NOT NULL,
    outcome          TEXT    NOT NULL,
    size_usdc        REAL    NOT NULL,
    price            REAL    NOT NULL,
    mode             TEXT    NOT NULL,    -- DRY_RUN|LIVE
    status           TEXT    NOT NULL,    -- SIMULATED|SUBMITTED|CONFIRMED|FAILED
    bullpen_command  TEXT,               -- Sanitized command string (no secrets)
    error_message    TEXT,
    executed_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,

  `CREATE INDEX IF NOT EXISTS idx_exec_log_ts   ON execution_log(executed_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_exec_log_mode ON execution_log(mode)`,

  // ── System health telemetry ───────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS system_health (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    component   TEXT    NOT NULL,   -- bullpen|nws_api|news_feed|open_meteo|risk_manager
    status      TEXT    NOT NULL,   -- UP|DOWN|DEGRADED
    latency_ms  INTEGER,
    error       TEXT,
    checked_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,

  `CREATE INDEX IF NOT EXISTS idx_health_component ON system_health(component, checked_at DESC)`,

  // ── News items already processed by Module C ─────────────────────────────
  `CREATE TABLE IF NOT EXISTS news_processed (
    hash         TEXT PRIMARY KEY,   -- sha256 of item URL/GUID
    source       TEXT NOT NULL,      -- feed URL
    headline     TEXT,
    processed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
];
