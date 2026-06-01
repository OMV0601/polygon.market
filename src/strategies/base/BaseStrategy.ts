import { logger } from '../../core/logger/logger';
import { RiskManager } from '../../core/risk/RiskManager';
import { BullpenClient } from '../../core/bullpen/BullpenClient';
import { Database } from '../../core/ledger/Database';
import { ExecutionEngine } from '../../execution/ExecutionEngine';
import type { CandidatePayload, StrategyModule } from '../../core/risk/types';

export abstract class BaseStrategy {
  protected abstract readonly name: StrategyModule;
  protected abstract readonly intervalMs: number;

  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    protected readonly riskManager: RiskManager,
    protected readonly bullpen: BullpenClient,
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

    for (const candidate of candidates) {
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
