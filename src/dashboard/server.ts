import express from 'express';
import cors from 'cors';
import path from 'path';
import http from 'http';
import { env } from '../config/env';
import { logger } from '../core/logger/logger';
import { Database } from '../core/ledger/Database';
import { BullpenClient } from '../core/bullpen/BullpenClient';

const UI_DIR = path.resolve(process.cwd(), 'src', 'dashboard', 'ui');

export class DashboardServer {
  private readonly app = express();
  private server: http.Server | null = null;

  constructor(
    private readonly db: Database,
    private readonly bullpen: BullpenClient,
    private readonly onKillSwitch: () => void
  ) {
    this.app.use(cors({ origin: /localhost/ }));
    this.app.use(express.json());
    this.app.use(express.static(UI_DIR));
    this.mountRoutes();
  }

  start(port: number): void {
    this.server = this.app.listen(port, '127.0.0.1', () => {
      logger.info(`Dashboard: http://localhost:${port}`);
    });
  }

  stop(): void {
    this.server?.close();
  }

  // ── Routes ────────────────────────────────────────────────────────────────

  private mountRoutes(): void {
    const r = express.Router();

    // System health
    r.get('/health', async (_req, res) => {
      try {
        const [bullpenHealth, dbHealth] = await Promise.all([
          this.bullpen.healthCheck(),
          Promise.resolve(this.db.healthCheck()),
        ]);
        res.json({
          bullpen: bullpenHealth,
          database: dbHealth,
          executionMode: env.LIVE_EXECUTION_ENABLED ? 'LIVE' : 'DRY_RUN',
          uptimeSeconds: Math.floor(process.uptime()),
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    // Alpha feed — approved + simulated candidates
    r.get('/candidates', (req, res) => {
      try {
        const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
        const statuses = ['APPROVED', 'SIMULATED'];
        const candidates = this.db.getRecentCandidates(statuses, limit);
        res.json({ candidates, total: candidates.length });
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    // Portfolio — simulated positions + PnL summary
    r.get('/portfolio', (_req, res) => {
      try {
        const summary = this.db.getSimulatedPortfolioSummary();
        const positions = this.db.getAllSimulatedPositions();
        res.json({ summary, positions });
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    // Execution log
    r.get('/execution-log', (req, res) => {
      try {
        const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
        const entries = this.db.getRecentExecutionLog(limit);
        res.json({ entries });
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    // Preview order — returns the sanitized bullpen command for a candidate
    r.get('/preview/:id', (req, res) => {
      try {
        const id = parseInt(req.params.id);
        const candidates = this.db.getRecentCandidates(['APPROVED', 'SIMULATED'], 500);
        const candidate = candidates.find((c) => c.id === id);
        if (!candidate) return res.status(404).json({ error: 'Candidate not found' });

        const command = this.bullpen.buildBuyCommand(
          candidate.marketSlug,
          candidate.outcome,
          candidate.suggestedSize ?? 10
        );

        res.json({
          id: candidate.id,
          marketSlug: candidate.marketSlug,
          outcome: candidate.outcome,
          sizeUsdc: candidate.suggestedSize,
          impliedProbability: candidate.impliedProbability,
          estimatedShares:
            candidate.suggestedSize && candidate.impliedProbability
              ? (candidate.suggestedSize / candidate.impliedProbability).toFixed(4)
              : null,
          command,
          executionMode: env.LIVE_EXECUTION_ENABLED ? 'LIVE' : 'DRY_RUN',
        });
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    // Kill switch — stops all strategies, locks execution
    r.post('/kill-switch', (_req, res) => {
      logger.error('[KILL SWITCH] Activated by operator via dashboard — all strategies stopping');
      this.db.logHealth({
        component: 'system',
        status: 'DOWN',
        error: 'Kill switch activated by operator',
      });
      this.onKillSwitch();
      res.json({ success: true, timestamp: new Date().toISOString() });
    });

    this.app.use('/api', r);

    // SPA fallback
    this.app.get('*', (_req, res) => {
      res.sendFile(path.join(UI_DIR, 'index.html'));
    });
  }
}
