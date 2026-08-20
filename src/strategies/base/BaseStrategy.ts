import { logger } from '../../core/logger/logger';
import { RiskManager } from '../../core/risk/RiskManager';
import { PolymarketClient } from '../../core/polymarket/PolymarketClient';
import { Database } from '../../core/ledger/Database';
import { ExecutionEngine } from '../../execution/ExecutionEngine';
import type { CandidatePayload, StrategyModule } from '../../core/risk/types';

export abstract class BaseStrategy {
  protected abstract readonly name: StrategyModule;
  protected abstract readonly intervalMs: number;

  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    protected readonly riskManager: RiskManager,
    protected readonly bullpen: PolymarketClient,
    protected readonly db: Database,
    protected readonly executionEngine: ExecutionEngine
  ) {}

  protected abstract scan(): Promise<CandidatePayload[]>;

  start(): void {
    if (this.timer) return;
    logger.info(`Strategy ${this.name}: starting`, { intervalMs: this.intervalMs });
    void this.runCycle();
    this.timer = setInterval(() => void this.runCycle(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info(`Strategy ${this.name}: stopped`);
    }
  }

  /**
   * Runs a single scan/evaluate/execute cycle and resolves when it is done.
   * `start()` fires the same cycle on a timer; this is for one-shot runs such
   * as a scheduled CI job, where there is no long-lived process to hold timers.
   */
  async runOnce(): Promise<void> {
    await this.runCycle();
  }

  private async runCycle(): Promise<void> {
    const cycleStart = Date.now();
    logger.info(`Strategy ${this.name}: scan cycle started`);

    let candidates: CandidatePayload[] = [];
    try {
      candidates = await this.scan();
      logger.info(`Strategy ${this.name}: scan complete`, { candidates: candidates.length });
    } catch (err) {
      logger.error(`Strategy ${this.name}: scan failed`, {
        error: (err as Error).message,
        stack: (err as Error).stack,
      });
      return;
    }

    let approved = 0;
    let rejected = 0;

    // Best edge first. The daily deployment cap is a fixed budget, and it was
    // being spent in whatever order the scan happened to produce candidates —
    // so the day's capital went to the first opportunities seen rather than the
    // best ones, and later cycles were rejected outright with the budget gone.
    // Ranking here makes the cap allocate rather than merely truncate.
    const ranked = [...candidates].sort((a, b) => edgeOf(b) - edgeOf(a));

    for (const candidate of ranked) {
      try {
        const candidateId = this.db.insertCandidate({
          marketSlug: candidate.marketSlug,
          strategy: candidate.strategyModule,
          outcome: candidate.outcome,
          impliedProbability: candidate.impliedProbability,
          externalSignal: candidate.externalSignalData,
          confidenceScore: candidate.confidenceScore,
          suggestedSize: candidate.suggestedSize,
        });
        candidate.externalSignalData._candidateId = candidateId;

        const decision = await this.riskManager.evaluate(candidate);

        if (decision.approved) {
          approved++;
          await this.executionEngine.execute(candidate, decision);
        } else {
          rejected++;
        }
      } catch (err) {
        logger.error(`Strategy ${this.name}: candidate processing failed`, {
          slug: candidate.marketSlug,
          error: (err as Error).message,
        });
      }
    }

    logger.info(`Strategy ${this.name}: cycle complete`, {
      durationMs: Date.now() - cycleStart,
      evaluated: candidates.length,
      approved,
      rejected,
    });
  }
}

/**
 * Ranking key for competing candidates: expected cents per share, net of fees,
 * as computed by the edge engine. Falls back to the confidence score for any
 * strategy that has not been routed through the engine yet.
 */
function edgeOf(candidate: CandidatePayload): number {
  const cents = candidate.externalSignalData?.takerEdgeCents;
  if (typeof cents === 'number' && isFinite(cents)) return cents;
  return (candidate.confidenceScore ?? 0) * 100;
}
