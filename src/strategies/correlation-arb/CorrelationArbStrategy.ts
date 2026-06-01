import { BaseStrategy } from '../base/BaseStrategy';
import { STRATEGY_INTERVALS, RISK } from '../../config/constants';
import { logger } from '../../core/logger/logger';
import { findArbOpportunities } from './EntityGrouper';
import type { ArbLeg, CandidatePayload, Outcome, StrategyModule } from '../../core/risk/types';

export class CorrelationArbStrategy extends BaseStrategy {
  protected readonly name: StrategyModule = 'CORRELATION_ARB';
  protected readonly intervalMs = STRATEGY_INTERVALS.CORRELATION_ARB_MS;

  protected async scan(): Promise<CandidatePayload[]> {
    let markets: Array<{ slug: string; title: string; bestAsk: number; bestBid: number; volume24h: number }>;

    try {
      const result = await this.bullpen.discover();
      const top100 = result.markets
        .sort((a, b) => b.volume24h - a.volume24h)
        .slice(0, RISK.ARB_SCAN_TOP_N_MARKETS);

      top100.forEach((m) =>
        this.db.upsertMarket({
          slug: m.slug, title: m.title, volume24h: m.volume24h,
          bestBid: m.bestBid, bestAsk: m.bestAsk,
          lastFetched: new Date().toISOString(),
        })
      );

      markets = top100;
    } catch (err) {
      logger.warn('CorrelationArb: bullpen discover failed', { error: (err as Error).message });
      return [];
    }

    const marketEntries = markets.map((m) => ({
      slug: m.slug,
      title: m.title,
      // Mid-price is a reasonable proxy for the YES probability
      yesPrice: (m.bestBid + m.bestAsk) / 2,
      volume24h: m.volume24h,
    }));

    const opportunities = findArbOpportunities(
      marketEntries,
      RISK.POLYMARKET_FEE_RATE,
      RISK.MIN_ARB_PROFIT_MARGIN
    );

    if (opportunities.length > 0) {
      logger.info('CorrelationArb: opportunities found', { count: opportunities.length });
    }

    const candidates: CandidatePayload[] = [];

    for (const opp of opportunities) {
      const marketA = markets.find((m) => m.slug === opp.slugA)!;
      const marketB = markets.find((m) => m.slug === opp.slugB)!;

      // Emit the primary leg. Both legs must execute for the arb to be risk-free.
      // The correlated leg is stored in correlatedLeg for the ExecutionEngine (Phase 3).
      const [primarySlug, primaryOutcome, primaryPrice, secondarySlug, secondaryOutcome, secondaryPrice] =
        opp.side === 'BUY_BOTH_YES'
          ? [opp.slugA, 'YES' as Outcome, opp.yesPriceA, opp.slugB, 'YES' as Outcome, opp.yesPriceB]
          : [opp.slugA, 'NO' as Outcome, 1 - opp.yesPriceA, opp.slugB, 'NO' as Outcome, 1 - opp.yesPriceB];

      const correlatedLeg: ArbLeg = {
        marketSlug: secondarySlug,
        outcome: secondaryOutcome,
        price: secondaryPrice,
        liquidity: marketB.volume24h,
      };

      logger.info('CorrelationArb: arb candidate', {
        primary: primarySlug,
        secondary: secondarySlug,
        side: opp.side,
        grossMargin: opp.grossMargin.toFixed(4),
        netMargin: (opp.grossMargin - 2 * RISK.POLYMARKET_FEE_RATE).toFixed(4),
      });

      candidates.push({
        strategyModule: 'CORRELATION_ARB',
        marketSlug: primarySlug,
        outcome: primaryOutcome,
        impliedProbability: primaryPrice,
        externalSignalData: {
          side: opp.side,
          slugA: opp.slugA,
          titleA: opp.titleA,
          yesPriceA: opp.yesPriceA,
          slugB: opp.slugB,
          titleB: opp.titleB,
          yesPriceB: opp.yesPriceB,
          grossMargin: opp.grossMargin,
          netMargin: opp.grossMargin - 2 * RISK.POLYMARKET_FEE_RATE,
          volume24h: marketA.volume24h,
        },
        confidenceScore: Math.min(opp.grossMargin * 5, 0.95),
        suggestedSize: 10,
        correlatedLeg,
        expectedArbMarginPostFee: opp.grossMargin - 2 * RISK.POLYMARKET_FEE_RATE,
      });
    }

    return candidates;
  }
}
