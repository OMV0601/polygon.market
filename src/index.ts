import { env } from './config/env';
import { logger } from './core/logger/logger';
import { PolymarketClient } from './core/polymarket/PolymarketClient';
import { Database } from './core/ledger/Database';
import { RiskManager } from './core/risk/RiskManager';
import { ExecutionEngine } from './execution/ExecutionEngine';
import { PositionResolver } from './core/ledger/PositionResolver';
import { DailyReport } from './core/reporting/DailyReport';
import { DashboardServer } from './dashboard/server';
import { WeatherStrategy } from './strategies/weather';
import type { BaseStrategy } from './strategies/base/BaseStrategy';

const VALIDATE_ONLY = process.argv.includes('--validate-only');
const SEND_REPORT_NOW = process.argv.includes('--send-report');
// One-shot mode: run a single cycle of everything, then exit. Lets a scheduled
// job (GitHub Actions, cron) drive the bot without a long-lived process.
const RUN_ONCE = process.argv.includes('--once');

async function main(): Promise<void> {
  logger.info('═══ polygon.market — Orchestrator ═══', { mode: VALIDATE_ONLY ? 'validate' : 'run' });
  logger.info('Environment', {
    nodeEnv: env.NODE_ENV,
    liveExecution: env.LIVE_EXECUTION_ENABLED,
    dbPath: env.DB_PATH,
  });

  // ── 1. Database ─────────────────────────────────────────────────────────────
  const db = new Database();
  db.initialize();
  const dbHealth = db.healthCheck();
  if (!dbHealth.healthy) {
    logger.error('Database unhealthy — aborting', dbHealth);
    process.exit(1);
  }
  logger.info('✔ Database', dbHealth);

  // One-off: send the daily email report now, then exit (for `npm run report`).
  // With --once the report is sent after the cycle instead, so the email
  // reflects the trades that run just made.
  if (SEND_REPORT_NOW && !RUN_ONCE) {
    logger.info('Sending daily report on demand…');
    await new DailyReport(db).sendReport();
    logger.info('Daily report sent.');
    db.close();
    process.exit(0);
  }

  // ── 2. Bullpen ──────────────────────────────────────────────────────────────
  const bullpen = new PolymarketClient();
  const bullpenHealth = await bullpen.healthCheck();
  db.logHealth({
    component: 'bullpen',
    status: bullpenHealth.connected ? 'UP' : 'DOWN',
    latencyMs: bullpenHealth.latencyMs,
    error: bullpenHealth.error,
  });

  if (bullpenHealth.connected) {
    logger.info('✔ bullpen connected', { version: bullpenHealth.version });
  } else {
    logger.warn('bullpen not reachable — strategies will use cached data where available', {
      hint: 'Set BULLPEN_PATH in .env',
    });
  }

  // ── 3. Risk Manager ─────────────────────────────────────────────────────────
  const riskManager = new RiskManager(db, bullpen);
  logger.info('✔ RiskManager ready', {
    executionMode: env.LIVE_EXECUTION_ENABLED ? 'LIVE' : 'DRY_RUN',
    maxPositionPct: env.MAX_POSITION_SIZE_PCT,
    maxDailyLossPct: env.MAX_DAILY_LOSS_PCT,
  });

  if (VALIDATE_ONLY) {
    await runSmokeTest(riskManager, db);
    db.close();
    process.exit(0);
  }

  // ── 4. Strategy Orchestration ───────────────────────────────────────────────
  const executionEngine = new ExecutionEngine(db, bullpen);
  logger.info('✔ ExecutionEngine ready', { mode: 'DRY_RUN' });

  const resolver = new PositionResolver(db);

  // Weather is the only strategy still running. The other three were removed
  // rather than tuned, each for a structural reason:
  //
  //   CorrelationArb  — inferred mutual exclusivity from shared words, so it
  //                     could hold both legs and lose both. Genuine sum-below-1
  //                     arb needs the protocol's negRisk outcome sets, which
  //                     NegRiskConsistencyModel now reads directly.
  //   WalletMirror    — fills only after a whale's order has already moved the
  //                     book, buying the price their trade created. The entry
  //                     penalty exceeds the edge it was chasing.
  //   NewsCatalyst    — polled RSS every two minutes against markets that
  //                     reprice on the source in seconds.
  //
  // Their history is in git if any of it is worth reviving.
  const strategies: BaseStrategy[] = [
    new WeatherStrategy(riskManager, bullpen, db, executionEngine),
  ];

  // One-shot: resolve, scan once, optionally mail the summary, then exit.
  if (RUN_ONCE) {
    logger.info('Running single cycle (--once)');

    await resolver.run();

    for (const strategy of strategies) {
      await strategy.runOnce();
    }

    if (SEND_REPORT_NOW) await new DailyReport(db).sendReport();

    const summary = db.getPnlSummary();
    logger.info('Single cycle complete', {
      openPositions: summary.openCount,
      closedPositions: summary.closedCount,
      totalPnl: summary.totalPnl.toFixed(2),
    });

    db.close();
    process.exit(0);
  }

  resolver.start();
  logger.info('✔ PositionResolver started — checks every 15 min');

  const dailyReport = new DailyReport(db);
  dailyReport.start();

  for (const strategy of strategies) strategy.start();

  logger.info('All strategies started', { count: strategies.length });
  logger.info('System running in DRY_RUN mode — set LIVE_EXECUTION_ENABLED=true to go live');

  // ── 5. Dashboard ────────────────────────────────────────────────────────────
  const dashboard = new DashboardServer(db, bullpen, () => {
    logger.error('Kill switch activated — stopping all strategies');
    for (const strategy of strategies) strategy.stop();
  });
  dashboard.start(env.DASHBOARD_PORT);

  // ── 6. Graceful shutdown ────────────────────────────────────────────────────
  const shutdown = (signal: string) => {
    logger.info(`Shutdown signal received (${signal}) — stopping`);
    resolver.stop();
    dailyReport.stop();
    for (const strategy of strategies) strategy.stop();
    dashboard.stop();
    db.close();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

async function runSmokeTest(riskManager: RiskManager, db: Database): Promise<void> {
  logger.info('Running Phase 1 + 2 smoke test');

  const decision = await riskManager.evaluate({
    strategyModule: 'WEATHER',
    marketSlug: 'smoke-test-market',
    outcome: 'YES',
    impliedProbability: 0.3,
    externalSignalData: { volume24h: 50_000 },
    confidenceScore: 0.8,
    suggestedSize: 10,
  });

  logger.info('Smoke test complete', {
    approved: decision.approved,
    executionMode: decision.executionMode,
    warnings: decision.warnings.length,
  });

  const dbHealth = db.healthCheck();
  logger.info('═══ Health Report ═══', {
    database: dbHealth,
    overallHealthy: dbHealth.healthy && decision.executionMode !== undefined,
  });

  if (dbHealth.healthy) {
    logger.info('All checks passed. Ready to run — use `npm start` to launch the full orchestrator.');
  }
}

main().catch((err: Error) => {
  logger.error('[FATAL] Unhandled bootstrap error', { message: err.message, stack: err.stack });
  process.exit(1);
});
