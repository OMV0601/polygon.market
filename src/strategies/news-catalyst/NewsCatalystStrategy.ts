import { createHash } from 'node:crypto';
import { BaseStrategy } from '../base/BaseStrategy';
import { env } from '../../config/env';
import { STRATEGY_INTERVALS, RISK } from '../../config/constants';
import { logger } from '../../core/logger/logger';
import { fetchFeed } from './clients/RSSClient';
import { SentimentAnalyzer } from './SentimentAnalyzer';
import type { CandidatePayload, NewsItem, Outcome, StrategyModule } from '../../core/risk/types';

export class NewsCatalystStrategy extends BaseStrategy {
  protected readonly name: StrategyModule = 'NEWS_CATALYST';
  protected readonly intervalMs = STRATEGY_INTERVALS.NEWS_CATALYST_MS;

  private readonly analyzer = new SentimentAnalyzer();

  protected async scan(): Promise<CandidatePayload[]> {
    const feedUrls = env.RSS_FEED_URLS;
    const candidates: CandidatePayload[] = [];

    // Fetch all feeds in parallel
    const feedResults = await Promise.allSettled(feedUrls.map((url) => fetchFeed(url)));

    const allItems = feedResults.flatMap((r, i) => {
      if (r.status === 'rejected') {
        logger.warn('NewsCatalyst: RSS feed failed', {
          url: feedUrls[i],
          error: (r.reason as Error).message,
        });
        return [];
      }
      return r.value;
    });

    // Filter to items published within the last LOOK_BACK window
    const cutoff = new Date(Date.now() - RISK.NEWS_LOOKBACK_MINUTES * 60 * 1000);
    const freshItems = allItems.filter((item) => item.pubDate >= cutoff);
    logger.info('NewsCatalyst: fresh items found', { total: allItems.length, fresh: freshItems.length });

    // Discover active markets to cross-reference against
    let marketTitles: Array<{ slug: string; title: string; bestAsk: number }> = [];
    try {
      const result = await this.bullpen.discover();
      marketTitles = result.markets.map((m) => ({
        slug: m.slug,
        title: m.title,
        bestAsk: m.bestAsk,
      }));
      result.markets.forEach((m) =>
        this.db.upsertMarket({
          slug: m.slug, title: m.title, volume24h: m.volume24h,
          bestBid: m.bestBid, bestAsk: m.bestAsk,
          lastFetched: new Date().toISOString(),
        })
      );
    } catch {
      // Fall back to DB cache
      marketTitles = this.db.getMarketsByCategory('politics')
        .concat(this.db.getMarketsByCategory('sports'))
        .concat(this.db.getMarketsByCategory('entertainment'))
        .map((m) => ({ slug: m.slug, title: m.title, bestAsk: m.bestAsk ?? 0.5 }));
    }

    for (const item of freshItems) {
      const hash = createHash('sha256').update(item.guid || item.link).digest('hex').slice(0, 16);

      if (this.db.isNewsProcessed(hash)) continue;

      this.db.markNewsProcessed(hash, item.source, item.title);

      const relevantMarkets = this.findRelevantMarkets(item.title, marketTitles);
      if (relevantMarkets.length === 0) continue;

      for (const market of relevantMarkets.slice(0, 3)) {
        try {
          const result = await this.analyzer.classify(item.title, market.title);
          if (result.sentiment === 'NEUTRAL' || result.confidence < 0.4) continue;

          // Priced-in check: if the market already moved strongly in the news direction, skip
          const isYesCatalyst = result.sentiment === 'YES_CATALYST';
          const priceMove = isYesCatalyst
            ? market.bestAsk - 0.5      // how far above 50 cents it is
            : 0.5 - market.bestAsk;    // how far below 50 cents it is

          if (priceMove > RISK.MAX_NEWS_PRICED_IN_MOVE_PCT) {
            logger.info('NewsCatalyst: news already priced in — discarding', {
              slug: market.slug,
              headline: item.title.slice(0, 60),
              priceMove: priceMove.toFixed(3),
            });
            continue;
          }

          logger.info('NewsCatalyst: catalyst candidate generated', {
            slug: market.slug,
            sentiment: result.sentiment,
            confidence: result.confidence.toFixed(2),
            method: result.method,
            headline: item.title.slice(0, 80),
          });

          const outcome: Outcome = isYesCatalyst ? 'YES' : 'NO';
          const newsItem: NewsItem = {
            headline: item.title,
            source: item.source,
            sentiment: result.sentiment,
            publishedAt: item.pubDate,
            url: item.link,
          };

          candidates.push({
            strategyModule: 'NEWS_CATALYST',
            marketSlug: market.slug,
            outcome,
            impliedProbability: market.bestAsk,
            externalSignalData: {
              headline: item.title,
              source: item.source,
              sentiment: result.sentiment,
              sentimentConfidence: result.confidence,
              sentimentMethod: result.method,
              reasoning: result.reasoning,
              priceMove,
            },
            confidenceScore: result.confidence,
            suggestedSize: 10,
            newsItem,
            priceMoveSinceNews: priceMove,
          });
        } catch (err) {
          logger.warn('NewsCatalyst: sentiment classification failed', {
            slug: market.slug,
            error: (err as Error).message,
          });
        }
      }
    }

    return candidates;
  }

  private findRelevantMarkets(
    headline: string,
    markets: Array<{ slug: string; title: string; bestAsk: number }>
  ): Array<{ slug: string; title: string; bestAsk: number }> {
    const headlineWords = new Set(
      headline
        .toLowerCase()
        .split(/\W+/)
        .filter((w) => w.length > 4)
    );

    return markets
      .map((m) => {
        const titleWords = m.title
          .toLowerCase()
          .split(/\W+/)
          .filter((w) => w.length > 4);
        const overlap = titleWords.filter((w) => headlineWords.has(w)).length;
        return { ...m, overlap };
      })
      .filter((m) => m.overlap >= 2)
      .sort((a, b) => b.overlap - a.overlap)
      .slice(0, 5);
  }
}
