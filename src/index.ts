import { env } from './config/env';
import { logger } from './core/logger/logger';
import { PolymarketClient } from './core/polymarket/PolymarketClient';
import { Database } from './core/ledger/Database';
import { RiskManager } from './core/risk/RiskManager';
import { ExecutionEngine } from './execution/ExecutionEngine';
import { PositionResolver } from './core/ledger/PositionResolver';
import { DailyReport } from './core/reporting/DailyReport';
import { DashboardServer } from './dashboard/server';
import { WalletMirrorStrategy } from './strategies/wallet-mirror';
import { WeatherStrategy } from './strategies/weather';
import { NewsCatalystStrategy } from './strategies/news-catalyst';
import { CorrelationArbStrategy } from './strategies/correlation-arb';
import type { BaseStrategy } from './strategies/base/BaseStrategy';

const VALIDATE_ONLY = process.argv.includes('--validate-only');
const SEND_REPORT_NOW = process.argv.includes('--send-report');

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
  if (SEND_REPORT_NOW) {
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
  resolver.start();
  logger.info('✔ PositionResolver started — checks every 15 min');

  const dailyReport = new DailyReport(db);
  dailyReport.start();

  const strategies: BaseStrategy[] = [
    new WalletMirrorStrategy(riskManager, bullpen, db, executionEngine),
    new WeatherStrategy(riskManager, bullpen, db, executionEngine),
    new NewsCatalystStrategy(riskManager, bullpen, db, executionEngine),
    // CorrelationArbStrategy is disabled: its margin formula, |1 - (priceA +
    // priceB)|, assumes an antonym pair is exhaustive. Live markets break that
    // — it paired "Fed increase 50bps" with "Fed decrease 50bps" and reported a
    // 99.3% arb, when the Fed holding rates makes both legs lose. It bought a
    // 0.4c lottery ticket on the strength of it. Real risk-free arb needs the
    // outcomes of a single event, which the temperature bucket series now
    // gives us; revisit it there rather than by tuning entity matching.
  ];

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
