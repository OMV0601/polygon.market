import { env } from '../config/env';
import { logger } from '../core/logger/logger';
import { BullpenClient } from '../core/bullpen/BullpenClient';
import { Database } from '../core/ledger/Database';
import type { CandidatePayload, RiskDecision } from '../core/risk/types';
import type { FillResult } from './types';

export class ExecutionEngine {
  constructor(
    private readonly db: Database,
    private readonly bullpen: BullpenClient
  ) {}

  async execute(candidate: CandidatePayload, decision: RiskDecision): Promise<FillResult> {
    if (!decision.approved) {
      throw new Error('ExecutionEngine.execute called with a rejected RiskDecision');
    }

    if (decision.executionMode === 'LIVE') {
      return this.liveFill(candidate);
    }

    return this.simulateFill(candidate);
  }

  // ── Dry-run path ──────────────────────────────────────────────────────────

  private simulateFill(candidate: CandidatePayload): FillResult {
    const fillPrice = candidate.impliedProbability;
    const shares = candidate.suggestedSize / fillPrice;
    const candidateId = candidate.externalSignalData._candidateId as number | undefined;

    const positionId = this.db.insertPosition({
      marketSlug: candidate.marketSlug,
      outcome: candidate.outcome,
      shares,
      entryPrice: fillPrice,
      status: 'SIMULATED_OPEN',
      candidateId,
    });

    this.db.updateCandidateRiskStatus(candidateId, 'SIMULATED');

    this.db.logExecution({
      candidateId,
      action: 'BUY',
      marketSlug: candidate.marketSlug,
      outcome: candidate.outcome,
      sizeUsdc: candidate.suggestedSize,
      price: fillPrice,
      mode: 'DRY_RUN',
      status: 'SIMULATED',
      bullpenCommand: this.bullpen.buildBuyCommand(
        candidate.marketSlug,
        candidate.outcome,
        candidate.suggestedSize
      ),
    });

    const result: FillResult = {
      filledShares: shares,
      avgFillPrice: fillPrice,
      totalCostUsdc: candidate.suggestedSize,
      status: 'SIMULATED',
      filledAt: new Date(),
    };

    logger.info('ExecutionEngine: simulated fill recorded', {
      strategy: candidate.strategyModule,
      slug: candidate.marketSlug,
      outcome: candidate.outcome,
      fillPrice,
      shares: shares.toFixed(4),
      sizeUsdc: candidate.suggestedSize,
      positionId,
    });

    const summary = this.db.getSimulatedPortfolioSummary();
    logger.info('ExecutionEngine: portfolio snapshot', {
      openPositions: summary.openCount,
      totalCostBasis: summary.totalCostBasis.toFixed(2),
      unrealizedPnl: summary.unrealizedPnl.toFixed(4),
    });

    return result;
  }

  // ── Live path — hard-blocked until Phase 4 dashboard approval is wired ────

  private liveFill(_candidate: CandidatePayload): never {
    if (!env.LIVE_EXECUTION_ENABLED) {
      logger.error('[FATAL] Live execution path reached while LIVE_EXECUTION_ENABLED=false — blocked');
      throw new Error('UNAUTHORIZED_EXECUTION: LIVE_EXECUTION_ENABLED is false');
    }

    // Phase 4 will wire the dashboard "Approve" button here.
    // Direct execution without per-trade dashboard approval is intentionally blocked.
    logger.error('[FATAL] Live execution requires per-trade dashboard approval — not yet implemented (Phase 4)');
    throw new Error('Live execution requires Phase 4 dashboard approval flow');
  }
}
