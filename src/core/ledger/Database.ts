import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import fs from 'fs';
import { env } from '../../config/env';
import { DB } from '../../config/constants';
import { logger } from '../logger/logger';
import { DDL, SCHEMA_VERSION } from './schema';

export class Database {
  private db!: DatabaseSync;
  private initialized = false;

  initialize(): void {
    if (this.initialized) return;

    const dbPath = path.resolve(process.cwd(), env.DB_PATH);
    const dir = path.dirname(dbPath);

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new DatabaseSync(dbPath, { enableForeignKeyConstraints: true });

    if (DB.WAL_MODE) this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(`PRAGMA busy_timeout = ${DB.BUSY_TIMEOUT_MS}`);

    this.migrate();
    this.initialized = true;

    logger.info('Database initialized', { path: dbPath, schemaVersion: SCHEMA_VERSION });
  }

  // ── Migrations ────────────────────────────────────────────────────────────

  private migrate(): void {
    const currentVersion = this.getSchemaVersion();
    if (currentVersion >= SCHEMA_VERSION) {
      logger.debug('Schema up-to-date', { version: currentVersion });
      return;
    }

    logger.info('Running schema migration', { from: currentVersion, to: SCHEMA_VERSION });

    this.transaction(() => {
      for (const stmt of DDL) this.db.exec(stmt);
      this.db
        .prepare(`INSERT OR REPLACE INTO schema_meta(key, value) VALUES (?, ?)`)
        .run('version', String(SCHEMA_VERSION));
    });

    logger.info('Schema migration complete', { version: SCHEMA_VERSION });
  }

  private getSchemaVersion(): number {
    try {
      const row = this.db
        .prepare(`SELECT value FROM schema_meta WHERE key = ?`)
        .get('version') as { value: string } | undefined;
      return row ? parseInt(row.value, 10) : 0;
    } catch {
      return 0;
    }
  }

  // ── Health ────────────────────────────────────────────────────────────────

  healthCheck(): { healthy: boolean; schemaVersion: number; error?: string } {
    try {
      this.assertReady();
      const row = this.db.prepare('SELECT 1 AS ping').get() as { ping: number };
      return { healthy: row.ping === 1, schemaVersion: this.getSchemaVersion() };
    } catch (err) {
      return { healthy: false, schemaVersion: 0, error: (err as Error).message };
    }
  }

  // ── Candidates ────────────────────────────────────────────────────────────

  insertCandidate(candidate: {
    marketSlug: string;
    strategy: string;
    outcome: string;
    impliedProbability: number;
    externalSignal?: Record<string, unknown>;
    confidenceScore?: number;
    suggestedSize?: number;
  }): number {
    this.assertReady();
    const result = this.db
      .prepare(`
        INSERT INTO candidates
          (market_slug, strategy, outcome, implied_probability, external_signal, confidence_score, suggested_size)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        candidate.marketSlug,
        candidate.strategy,
        candidate.outcome,
        candidate.impliedProbability,
        candidate.externalSignal ? JSON.stringify(candidate.externalSignal) : null,
        candidate.confidenceScore ?? null,
        candidate.suggestedSize ?? null
      );
    return Number(result.lastInsertRowid);
  }

  updateCandidateRiskStatus(
    id: number | undefined,
    status: string,
    rejectionReason?: string,
    rejectionDetail?: string
  ): void {
    if (!id) return;
    this.assertReady();
    this.db
      .prepare(`
        UPDATE candidates
        SET risk_status = ?, risk_rejection_reason = ?, risk_rejection_detail = ?
        WHERE id = ?
      `)
      .run(status, rejectionReason ?? null, rejectionDetail ?? null, id);
  }

  // ── Positions ─────────────────────────────────────────────────────────────

  getOpenPositionsBySlug(marketSlug: string): Array<{
    id: number;
    outcome: string;
    shares: number;
    entryPrice: number;
  }> {
    this.assertReady();
    return this.db
      .prepare(`
        SELECT id, outcome, shares, entry_price AS entryPrice
        FROM positions
        WHERE market_slug = ? AND status IN ('OPEN', 'SIMULATED_OPEN')
      `)
      .all(marketSlug) as Array<{ id: number; outcome: string; shares: number; entryPrice: number }>;
  }

  getTotalOpenExposureUsdc(): number {
    this.assertReady();
    const row = this.db
      .prepare(`
        SELECT COALESCE(SUM(shares * entry_price), 0) AS total
        FROM positions
        WHERE status IN ('OPEN', 'SIMULATED_OPEN')
      `)
      .get() as { total: number };
    return row.total;
  }

  // Open exposure across all markets sharing an event prefix (e.g. all bets on
  // the same match). Used to cap per-event concentration.
  getOpenExposureByEventPrefix(prefix: string): number {
    this.assertReady();
    const row = this.db
      .prepare(`
        SELECT COALESCE(SUM(shares * entry_price), 0) AS total
        FROM positions
        WHERE status IN ('OPEN', 'SIMULATED_OPEN')
          AND market_slug LIKE ? || '%'
      `)
      .get(prefix) as { total: number };
    return row.total;
  }

  // ── Position management ───────────────────────────────────────────────────

  insertPosition(position: {
    marketSlug: string;
    outcome: string;
    shares: number;
    entryPrice: number;
    currentPrice?: number;
    status: string;
    candidateId?: number;
  }): number {
    this.assertReady();
    const result = this.db
      .prepare(`
        INSERT INTO positions (market_slug, outcome, shares, entry_price, current_price, status, candidate_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        position.marketSlug,
        position.outcome,
        position.shares,
        position.entryPrice,
        position.currentPrice ?? null,
        position.status,
        position.candidateId ?? null
      );
    return Number(result.lastInsertRowid);
  }

  updatePositionPrice(id: number, currentPrice: number): void {
    this.assertReady();
    this.db
      .prepare(`UPDATE positions SET current_price = ? WHERE id = ?`)
      .run(currentPrice, id);
  }

  getOpenSimulatedPositions(): Array<{
    id: number; marketSlug: string; outcome: string;
    shares: number; entryPrice: number; openedAt: string;
  }> {
    this.assertReady();
    return this.db
      .prepare(`
        SELECT id, market_slug AS marketSlug, outcome, shares, entry_price AS entryPrice, opened_at AS openedAt
        FROM positions WHERE status = 'SIMULATED_OPEN'
        ORDER BY opened_at ASC
      `)
      .all() as Array<{ id: number; marketSlug: string; outcome: string; shares: number; entryPrice: number; openedAt: string }>;
  }

  closePosition(id: number, exitPrice: number, realizedPnl: number): void {
    this.assertReady();
    this.db
      .prepare(`
        UPDATE positions
        SET status = 'SIMULATED_CLOSED', current_price = ?, realized_pnl = ?,
            closed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?
      `)
      .run(exitPrice, realizedPnl, id);
  }

  getSimulatedPortfolioSummary(): {
    openCount: number;
    totalCostBasis: number;
    unrealizedPnl: number;
  } {
    this.assertReady();
    const row = this.db
      .prepare(`
        SELECT
          COUNT(*)                                                            AS openCount,
          COALESCE(SUM(shares * entry_price), 0)                             AS totalCostBasis,
          COALESCE(SUM(
            CASE WHEN current_price IS NOT NULL
              THEN (current_price - entry_price) * shares
              ELSE 0 END
          ), 0)                                                              AS unrealizedPnl
        FROM positions
        WHERE status = 'SIMULATED_OPEN'
      `)
      .get() as { openCount: number; totalCostBasis: number; unrealizedPnl: number };
    return row;
  }

  getAllSimulatedPositions(): Array<{
    id: number; marketSlug: string; outcome: string;
    shares: number; entryPrice: number; currentPrice: number | null;
    unrealizedPnl: number | null; openedAt: string;
  }> {
    this.assertReady();
    return this.db
      .prepare(`
        SELECT
          id, market_slug AS marketSlug, outcome, shares, entry_price AS entryPrice,
          current_price AS currentPrice,
          CASE WHEN current_price IS NOT NULL THEN (current_price - entry_price) * shares ELSE NULL END AS unrealizedPnl,
          opened_at AS openedAt
        FROM positions
        WHERE status = 'SIMULATED_OPEN'
        ORDER BY opened_at DESC
      `)
      .all() as Array<{
        id: number; marketSlug: string; outcome: string;
        shares: number; entryPrice: number; currentPrice: number | null;
        unrealizedPnl: number | null; openedAt: string;
      }>;
  }

  getAllClosedSimulatedPositions(limit = 50): Array<{
    id: number; marketSlug: string; outcome: string; shares: number;
    entryPrice: number; exitPrice: number | null; realizedPnl: number | null;
    openedAt: string; closedAt: string | null;
  }> {
    this.assertReady();
    return this.db
      .prepare(`
        SELECT id, market_slug AS marketSlug, outcome, shares,
               entry_price AS entryPrice, current_price AS exitPrice,
               realized_pnl AS realizedPnl, opened_at AS openedAt, closed_at AS closedAt
        FROM positions WHERE status = 'SIMULATED_CLOSED'
        ORDER BY closed_at DESC LIMIT ?
      `)
      .all(limit) as Array<{
        id: number; marketSlug: string; outcome: string; shares: number;
        entryPrice: number; exitPrice: number | null; realizedPnl: number | null;
        openedAt: string; closedAt: string | null;
      }>;
  }

  getPnlSummary(): {
    realizedPnl: number; unrealizedPnl: number; totalPnl: number;
    openCount: number; closedCount: number; winCount: number; lossCount: number;
    winRate: number; openExposure: number;
  } {
    this.assertReady();
    const closed = this.db.prepare(`
      SELECT COALESCE(SUM(realized_pnl), 0) AS realizedPnl,
             COUNT(*) AS closedCount,
             COUNT(CASE WHEN realized_pnl > 0 THEN 1 END) AS winCount
      FROM positions WHERE status = 'SIMULATED_CLOSED'
    `).get() as { realizedPnl: number; closedCount: number; winCount: number };

    const open = this.db.prepare(`
      SELECT COUNT(*) AS openCount,
             COALESCE(SUM(shares * entry_price), 0) AS openExposure,
             COALESCE(SUM(CASE WHEN current_price IS NOT NULL
               THEN (current_price - entry_price) * shares ELSE 0 END), 0) AS unrealizedPnl
      FROM positions WHERE status = 'SIMULATED_OPEN'
    `).get() as { openCount: number; openExposure: number; unrealizedPnl: number };

    const lossCount = closed.closedCount - closed.winCount;
    return {
      realizedPnl: closed.realizedPnl,
      unrealizedPnl: open.unrealizedPnl,
      totalPnl: closed.realizedPnl + open.unrealizedPnl,
      openCount: open.openCount,
      closedCount: closed.closedCount,
      winCount: closed.winCount,
      lossCount,
      winRate: closed.closedCount > 0 ? closed.winCount / closed.closedCount : 0,
      openExposure: open.openExposure,
    };
  }

  // ── Daily P&L ─────────────────────────────────────────────────────────────

  // Positions opened today (UTC) — for the daily email report.
  getPositionsOpenedToday(): Array<{
    marketSlug: string; outcome: string; shares: number; entryPrice: number;
  }> {
    this.assertReady();
    return this.db
      .prepare(`
        SELECT market_slug AS marketSlug, outcome, shares, entry_price AS entryPrice
        FROM positions
        WHERE DATE(opened_at) = DATE('now') AND status LIKE 'SIMULATED%'
        ORDER BY opened_at DESC
      `)
      .all() as Array<{ marketSlug: string; outcome: string; shares: number; entryPrice: number }>;
  }

  // Positions that resolved today (UTC), with win/loss result — for the report.
  getPositionsClosedToday(): Array<{
    marketSlug: string; outcome: string; shares: number;
    entryPrice: number; exitPrice: number | null; realizedPnl: number | null;
  }> {
    this.assertReady();
    return this.db
      .prepare(`
        SELECT market_slug AS marketSlug, outcome, shares,
               entry_price AS entryPrice, current_price AS exitPrice, realized_pnl AS realizedPnl
        FROM positions
        WHERE DATE(closed_at) = DATE('now') AND status = 'SIMULATED_CLOSED'
        ORDER BY closed_at DESC
      `)
      .all() as Array<{
        marketSlug: string; outcome: string; shares: number;
        entryPrice: number; exitPrice: number | null; realizedPnl: number | null;
      }>;
  }

  // Total capital (cost basis) deployed into NEW positions opened today (UTC).
  getDailyDeployedUsdc(): number {
    this.assertReady();
    const row = this.db
      .prepare(`
        SELECT COALESCE(SUM(shares * entry_price), 0) AS total
        FROM positions
        WHERE DATE(opened_at) = DATE('now')
          AND status IN ('OPEN', 'CLOSED', 'SIMULATED_OPEN', 'SIMULATED_CLOSED')
      `)
      .get() as { total: number };
    return row.total;
  }

  getDailyRealizedPnl(): number {
    this.assertReady();
    const row = this.db
      .prepare(`
        SELECT COALESCE(SUM(realized_pnl), 0) AS total
        FROM positions
        WHERE DATE(closed_at) = DATE('now')
          AND status IN ('CLOSED', 'SIMULATED_CLOSED')
      `)
      .get() as { total: number };
    return row.total;
  }

  // ── Execution log ─────────────────────────────────────────────────────────

  logExecution(entry: {
    candidateId?: number;
    action: string;
    marketSlug: string;
    outcome: string;
    sizeUsdc: number;
    price: number;
    mode: string;
    status: string;
    bullpenCommand?: string;
    errorMessage?: string;
  }): void {
    this.assertReady();
    this.db
      .prepare(`
        INSERT INTO execution_log
          (candidate_id, action, market_slug, outcome, size_usdc, price, mode, status, bullpen_command, error_message)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        entry.candidateId ?? null,
        entry.action,
        entry.marketSlug,
        entry.outcome,
        entry.sizeUsdc,
        entry.price,
        entry.mode,
        entry.status,
        entry.bullpenCommand ?? null,
        entry.errorMessage ?? null
      );
  }

  // ── Health telemetry ──────────────────────────────────────────────────────

  logHealth(entry: {
    component: string;
    status: 'UP' | 'DOWN' | 'DEGRADED';
    latencyMs?: number;
    error?: string;
  }): void {
    this.assertReady();
    this.db
      .prepare(`INSERT INTO system_health (component, status, latency_ms, error) VALUES (?, ?, ?, ?)`)
      .run(entry.component, entry.status, entry.latencyMs ?? null, entry.error ?? null);
  }

  // ── Wallet transactions (Module A) ───────────────────────────────────────

  getSeenTxHashes(walletAddress: string): Set<string> {
    this.assertReady();
    const rows = this.db
      .prepare(`SELECT tx_hash FROM wallet_transactions WHERE wallet_address = ? AND tx_hash IS NOT NULL`)
      .all(walletAddress) as Array<{ tx_hash: string }>;
    return new Set(rows.map((r) => r.tx_hash));
  }

  insertWalletTx(tx: {
    walletAddress: string;
    walletAlias?: string;
    marketSlug: string;
    outcome: string;
    side: string;
    fillPrice: number;
    shareCount: number;
    totalCost: number;
    txHash?: string;
  }): void {
    this.assertReady();
    this.db
      .prepare(`
        INSERT OR IGNORE INTO wallet_transactions
          (wallet_address, wallet_alias, market_slug, outcome, side, fill_price, share_count, total_cost, tx_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        tx.walletAddress,
        tx.walletAlias ?? null,
        tx.marketSlug,
        tx.outcome,
        tx.side,
        tx.fillPrice,
        tx.shareCount,
        tx.totalCost,
        tx.txHash ?? null
      );
  }

  // ── Market cache (shared across strategies) ───────────────────────────────

  upsertMarket(m: {
    slug: string;
    title: string;
    category?: string;
    volume24h: number;
    bestBid?: number;
    bestAsk?: number;
    liquidity?: number;
    endDate?: string;
    lastFetched: string;
  }): void {
    this.assertReady();
    this.db
      .prepare(`
        INSERT INTO markets (slug, title, category, volume_24h, best_bid, best_ask, liquidity, end_date, last_fetched, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        ON CONFLICT(slug) DO UPDATE SET
          title        = excluded.title,
          category     = excluded.category,
          volume_24h   = excluded.volume_24h,
          best_bid     = excluded.best_bid,
          best_ask     = excluded.best_ask,
          liquidity    = excluded.liquidity,
          end_date     = excluded.end_date,
          last_fetched = excluded.last_fetched,
          updated_at   = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      `)
      .run(
        m.slug, m.title, m.category ?? null, m.volume24h,
        m.bestBid ?? null, m.bestAsk ?? null, m.liquidity ?? null,
        m.endDate ?? null, m.lastFetched
      );
  }

  getMarketsByCategory(category: string): Array<{
    slug: string; title: string; volume24h: number;
    bestBid: number | null; bestAsk: number | null; endDate: string | null;
  }> {
    this.assertReady();
    return this.db
      .prepare(`
        SELECT slug, title, volume_24h AS volume24h, best_bid AS bestBid, best_ask AS bestAsk, end_date AS endDate
        FROM markets
        WHERE category = ?
        ORDER BY volume_24h DESC
      `)
      .all(category) as Array<{
        slug: string; title: string; volume24h: number;
        bestBid: number | null; bestAsk: number | null; endDate: string | null;
      }>;
  }

  // ── Dashboard queries ─────────────────────────────────────────────────────

  getRecentCandidates(statuses: string[], limit: number): Array<{
    id: number; createdAt: string; strategy: string; marketSlug: string;
    outcome: string; impliedProbability: number; externalSignal: string | null;
    confidenceScore: number | null; suggestedSize: number | null; riskStatus: string;
  }> {
    this.assertReady();
    const placeholders = statuses.map(() => '?').join(',');
    return this.db
      .prepare(`
        SELECT id, created_at AS createdAt, strategy, market_slug AS marketSlug,
               outcome, implied_probability AS impliedProbability,
               external_signal AS externalSignal, confidence_score AS confidenceScore,
               suggested_size AS suggestedSize, risk_status AS riskStatus
        FROM candidates
        WHERE risk_status IN (${placeholders})
        ORDER BY created_at DESC
        LIMIT ?
      `)
      .all(...statuses, limit) as Array<{
        id: number; createdAt: string; strategy: string; marketSlug: string;
        outcome: string; impliedProbability: number; externalSignal: string | null;
        confidenceScore: number | null; suggestedSize: number | null; riskStatus: string;
      }>;
  }

  getRecentExecutionLog(limit: number): Array<{
    id: number; executedAt: string; action: string; marketSlug: string;
    outcome: string; sizeUsdc: number; price: number; mode: string;
    status: string; bullpenCommand: string | null;
  }> {
    this.assertReady();
    return this.db
      .prepare(`
        SELECT id, executed_at AS executedAt, action, market_slug AS marketSlug,
               outcome, size_usdc AS sizeUsdc, price, mode, status,
               bullpen_command AS bullpenCommand
        FROM execution_log
        ORDER BY executed_at DESC
        LIMIT ?
      `)
      .all(limit) as Array<{
        id: number; executedAt: string; action: string; marketSlug: string;
        outcome: string; sizeUsdc: number; price: number; mode: string;
        status: string; bullpenCommand: string | null;
      }>;
  }

  // ── News deduplication (Module C) ─────────────────────────────────────────

  isNewsProcessed(hash: string): boolean {
    this.assertReady();
    const row = this.db
      .prepare(`SELECT 1 AS found FROM news_processed WHERE hash = ?`)
      .get(hash) as { found: number } | undefined;
    return row !== undefined;
  }

  markNewsProcessed(hash: string, source: string, headline: string): void {
    this.assertReady();
    this.db
      .prepare(`INSERT OR IGNORE INTO news_processed (hash, source, headline) VALUES (?, ?, ?)`)
      .run(hash, source, headline);
  }

  // ── Raw access for future repositories ───────────────────────────────────

  get raw(): DatabaseSync {
    this.assertReady();
    return this.db;
  }

  close(): void {
    if (this.db) this.db.close();
    this.initialized = false;
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private transaction(fn: () => void): void {
    this.db.exec('BEGIN');
    try {
      fn();
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  private assertReady(): void {
    if (!this.initialized || !this.db) {
      throw new Error('Database.initialize() must be called before use');
    }
  }
}
