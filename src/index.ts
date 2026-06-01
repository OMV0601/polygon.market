import { env } from './config/env';
import { logger } from './core/logger/logger';
import { BullpenClient } from './core/bullpen/BullpenClient';
import { Database } from './core/ledger/Database';
import { RiskManager } from './core/risk/RiskManager';
import { ExecutionEngine } from './execution/ExecutionEngine';
import { DashboardServer } from './dashboard/server';
import { WalletMirrorStrategy } from './strategies/wallet-mirror';
import { WeatherStrategy } from './strategies/weather';
import { NewsCatalystStrategy } from './strategies/news-catalyst';
import { CorrelationArbStrategy } from './strategies/correlation-arb';
import type { BaseStrategy } from './strategies/base/BaseStrategy';

const VALIDATE_ONLY = process.argv.includes('--validate-only');

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

  // ── 2. Bullpen ──────────────────────────────────────────────────────────────
  const bullpen = new BullpenClient();
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

  const strategies: BaseStrategy[] = [
    new WalletMirrorStrategy(riskManager, bullpen, db, executionEngine),
    new WeatherStrategy(riskManager, bullpen, db, executionEngine),
    new NewsCatalystStrategy(riskManager, bullpen, db, executionEngine),
    new CorrelationArbStrategy(riskManager, bullpen, db, executionEngine),
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
