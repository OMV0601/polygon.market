import { env } from '../config/env';
import { logger } from '../core/logger/logger';
import { categoryFor, takerFee } from '../core/pricing/FeeModel';
import { PolymarketClient } from '../core/polymarket/PolymarketClient';
import { Database } from '../core/ledger/Database';
import type { CandidatePayload, RiskDecision } from '../core/risk/types';
import type { FillResult } from './types';

export class ExecutionEngine {
  constructor(
    private readonly db: Database,
    private readonly bullpen: PolymarketClient
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

  /**
   * Walks the live ask side to find what this order would really pay.
   *
   * This used to fill at the mid price with no spread, slippage or fee, which
   * flattered every trade by roughly the cost of entry — around 1-2% in the
   * price band we trade, more than most of the edges the strategies claim to
   * find. A paper record built on that is not evidence of anything, so the
   * simulation now pays the book.
   */
  private async simulateFill(candidate: CandidatePayload): Promise<FillResult> {
    const candidateId = candidate.externalSignalData._candidateId as number | undefined;
    const sizeUsdc = candidate.suggestedSize;

    let bestAsk = candidate.impliedProbability;
    let midPrice = candidate.impliedProbability;
    let avgFillPrice = candidate.impliedProbability;
    let filledUsdc = sizeUsdc;

    try {
      const book = await this.bullpen.orderBook(candidate.marketSlug, candidate.outcome);
      bestAsk = book.bestAsk;
      midPrice = (book.bestBid + book.bestAsk) / 2;

      const walk = walkAsks(book.asks, sizeUsdc);
      if (walk.shares > 0) {
        avgFillPrice = walk.spent / walk.shares;
        filledUsdc = walk.spent;
      }

      if (walk.unfilledUsdc > 0.01) {
        logger.warn('ExecutionEngine: book too thin for full size', {
          slug: candidate.marketSlug,
          requested: sizeUsdc.toFixed(2),
          filled: walk.spent.toFixed(2),
        });
      }
    } catch (err) {
      // Without a book we cannot know the real cost. Fall back to the quoted
      // ask rather than the mid so the estimate errs against us, and flag it.
      logger.warn('ExecutionEngine: order book unavailable, using quoted ask', {
        slug: candidate.marketSlug,
        error: (err as Error).message,
      });
    }

    const shares = filledUsdc / avgFillPrice;
    // Real schedule: rate × p × (1−p) per share, not a flat cut of notional.
    // The old model understated a 50c crypto fill by 3.5x and overstated the
    // tails, so it got the shape of the cost curve wrong as well as the level.
    const category = categoryFor(candidate.externalSignalData?.feeCategory as string | undefined);
    const feePaid = takerFee(shares, avgFillPrice, category);
    const costUsdc = filledUsdc + feePaid;
    const fillPrice = avgFillPrice;

    const positionId = this.db.insertPosition({
      marketSlug: candidate.marketSlug,
      outcome: candidate.outcome,
      shares,
      entryPrice: avgFillPrice,
      status: 'SIMULATED_OPEN',
      candidateId,
      midPrice,
      bestAsk,
      slippage: avgFillPrice - bestAsk,
      feePaid,
      costUsdc,
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
      totalCostUsdc: costUsdc,
      status: 'SIMULATED',
      filledAt: new Date(),
    };

    logger.info('ExecutionEngine: simulated fill recorded', {
      strategy: candidate.strategyModule,
      slug: candidate.marketSlug,
      outcome: candidate.outcome,
      mid: midPrice.toFixed(4),
      bestAsk: bestAsk.toFixed(4),
      avgFill: avgFillPrice.toFixed(4),
      slippage: (avgFillPrice - bestAsk).toFixed(4),
      // What the old mid-price model would have overstated this trade by.
      costVsMid: `${(((avgFillPrice - midPrice) / midPrice) * 100).toFixed(2)}%`,
      feeUsdc: feePaid.toFixed(4),
      shares: shares.toFixed(4),
      costUsdc: costUsdc.toFixed(2),
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

/**
 * Consumes ask levels cheapest-first until `budgetUsdc` is spent, returning the
 * shares acquired and the amount actually deployed. A real order sweeps the
 * book this way, so the average price it produces is higher than the top ask
 * whenever the first level is too small to absorb the whole order.
 */
export function walkAsks(
  asks: Array<{ price: number; size: number }>,
  budgetUsdc: number
): { shares: number; spent: number; unfilledUsdc: number } {
  let remaining = budgetUsdc;
  let shares = 0;
  let spent = 0;

  for (const level of [...asks].sort((a, b) => a.price - b.price)) {
    if (remaining <= 0) break;
    if (level.price <= 0) continue;

    // `size` is share count, so the level can absorb price * size in USDC.
    const levelCapacityUsdc = level.price * level.size;
    const take = Math.min(remaining, levelCapacityUsdc);

    spent += take;
    shares += take / level.price;
    remaining -= take;
  }

  return { shares, spent, unfilledUsdc: Math.max(0, remaining) };
}
