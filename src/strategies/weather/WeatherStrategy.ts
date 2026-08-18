import { BaseStrategy } from '../base/BaseStrategy';
import { STRATEGY_INTERVALS, RISK } from '../../config/constants';
import { logger } from '../../core/logger/logger';
import { OpenMeteoClient } from './clients/OpenMeteoClient';
import {
  groupIntoEvents,
  isTemperatureMarket,
  parseBucketMarket,
  type ParsedBucketMarket,
} from './parsers/BucketMarketParser';
import {
  MAX_USEFUL_HORIZON_HOURS,
  bucketProbability,
  bucketSetCoverage,
  sigmaForHorizon,
} from './ForecastDistribution';
import type { CandidatePayload, ForecastData, StrategyModule } from '../../core/risk/types';

interface MarketLike {
  slug: string;
  title: string;
  bestBid: number;
  bestAsk: number;
  volume24h: number;
  liquidity?: number;
  endDate?: string;
}

interface BucketEntry {
  market: MarketLike;
  parsed: ParsedBucketMarket;
}

/**
 * Polymarket runs daily temperature markets as bucket series — one market per
 * degree, all resolving off the same reading for a city and date. This strategy
 * prices the whole event at once: fetch one forecast, spread a distribution
 * across the buckets, and buy any bucket the market has priced materially below
 * our modelled probability.
 *
 * The daily high itself is assumed to occur mid-afternoon local time, which is
 * what the forecast horizon is measured against.
 */
const HIGH_TEMP_HOUR_UTC_OFFSET_MS = 18 * 60 * 60 * 1000;

export class WeatherStrategy extends BaseStrategy {
  protected readonly name: StrategyModule = 'WEATHER';
  protected readonly intervalMs = STRATEGY_INTERVALS.WEATHER_MS;

  private readonly openMeteo = new OpenMeteoClient();

  protected async scan(): Promise<CandidatePayload[]> {
    const entries = await this.loadBuckets();
    if (entries.length === 0) {
      logger.info('Weather: no temperature bucket markets found');
      return [];
    }

    const events = groupIntoEvents(entries);
    logger.info('Weather: temperature events discovered', {
      markets: entries.length,
      events: events.size,
    });

    const candidates: CandidatePayload[] = [];

    for (const [eventKey, buckets] of events) {
      try {
        const found = await this.evaluateEvent(eventKey, buckets);
        candidates.push(...found);
      } catch (err) {
        logger.warn('Weather: event evaluation failed', {
          eventKey,
          error: (err as Error).message,
        });
      }
    }

    logger.info('Weather: scan produced candidates', { count: candidates.length });
    return candidates;
  }

  // ── Discovery ─────────────────────────────────────────────────────────────

  private async loadBuckets(): Promise<BucketEntry[]> {
    let markets: MarketLike[];

    try {
      const result = await this.bullpen.discover();
      markets = result.markets;

      for (const m of markets) {
        if (!isTemperatureMarket(m.title)) continue;
        this.db.upsertMarket({
          slug: m.slug,
          title: m.title,
          category: 'weather',
          volume24h: m.volume24h,
          bestBid: m.bestBid,
          bestAsk: m.bestAsk,
          liquidity: m.liquidity,
          endDate: m.endDate,
          lastFetched: new Date().toISOString(),
        });
      }
    } catch (err) {
      logger.warn('Weather: discover failed, falling back to DB cache', {
        error: (err as Error).message,
      });
      markets = this.db.getMarketsByCategory('weather').map((m) => ({
        slug: m.slug,
        title: m.title,
        bestBid: m.bestBid ?? 0,
        bestAsk: m.bestAsk ?? 1,
        volume24h: m.volume24h,
        endDate: m.endDate ?? undefined,
      }));
    }

    const entries: BucketEntry[] = [];
    for (const market of markets) {
      const parsed = parseBucketMarket(market.slug, market.title);
      if (parsed) entries.push({ market, parsed });
    }
    return entries;
  }

  // ── Pricing one city/date event ───────────────────────────────────────────

  private async evaluateEvent(
    eventKey: string,
    buckets: BucketEntry[]
  ): Promise<CandidatePayload[]> {
    const { city, targetDate, unit } = buckets[0].parsed;

    // Measure lead time to the daily high, not to midnight.
    const highTempAt = targetDate.getTime() + HIGH_TEMP_HOUR_UTC_OFFSET_MS;
    const horizonHours = (highTempAt - Date.now()) / 3_600_000;

    if (horizonHours <= 0) return [];
    if (horizonHours > MAX_USEFUL_HORIZON_HOURS) return [];

    const forecast = await this.openMeteo.getForecastForDate(city, targetDate);
    if (!forecast) {
      logger.debug('Weather: no forecast available', { city, eventKey });
      return [];
    }

    const staleMs = RISK.MAX_FORECAST_STALENESS_HOURS * 60 * 60 * 1000;
    if (Date.now() - forecast.fetchedAt.getTime() > staleMs) {
      logger.warn('Weather: forecast stale, skipping event', { city, eventKey });
      return [];
    }

    const forecastValue = unit === 'C' ? forecast.maxTempC : forecast.maxTempF;

    // A bucket set that doesn't account for most of the distribution is missing
    // outcomes — usually an unparsed "X or above" catch-all. Edges computed
    // against a partial set are not trustworthy.
    const coverage = bucketSetCoverage(
      buckets.map((b) => b.parsed),
      forecastValue,
      unit,
      horizonHours
    );

    if (coverage < RISK.WEATHER_MIN_COVERAGE) {
      logger.debug('Weather: incomplete bucket set, skipping event', {
        eventKey,
        coverage: coverage.toFixed(3),
      });
      return [];
    }

    const scored = buckets
      .map((entry) => {
        const modelProb = bucketProbability({
          forecast: forecastValue,
          unit,
          horizonHours,
          lowerEdge: entry.parsed.lowerEdge,
          upperEdge: entry.parsed.upperEdge,
        });
        // We pay the ask to enter, so that — not the mid — is what the model
        // has to beat.
        const ask = entry.market.bestAsk;
        return { entry, modelProb, ask, edge: modelProb - ask };
      })
      .filter(
        (s) =>
          s.ask >= RISK.WEATHER_MIN_ASK &&
          s.ask <= RISK.WEATHER_MAX_ASK &&
          s.edge >= RISK.WEATHER_MIN_EDGE
      )
      .sort((a, b) => b.edge - a.edge)
      .slice(0, RISK.WEATHER_MAX_BUCKETS_PER_EVENT);

    if (scored.length === 0) return [];

    logger.info('Weather: edge found', {
      city,
      date: targetDate.toISOString().slice(0, 10),
      unit,
      forecast: forecastValue.toFixed(1),
      sigma: sigmaForHorizon(horizonHours, unit).toFixed(2),
      horizonHours: horizonHours.toFixed(1),
      coverage: coverage.toFixed(3),
      buckets: scored.map((s) => ({
        title: s.entry.market.title,
        model: s.modelProb.toFixed(3),
        ask: s.ask.toFixed(3),
        edge: s.edge.toFixed(3),
      })),
    });

    return scored.map(({ entry, modelProb, ask, edge }) => {
      const forecastData: ForecastData = {
        source: 'OPEN_METEO',
        city,
        forecastedValue: forecastValue,
        unit: `°${unit}`,
        confidenceInterval: [
          forecastValue - sigmaForHorizon(horizonHours, unit),
          forecastValue + sigmaForHorizon(horizonHours, unit),
        ],
        fetchedAt: forecast.fetchedAt,
      };

      return {
        strategyModule: 'WEATHER',
        marketSlug: entry.market.slug,
        // Bucket markets are single-outcome: we are buying YES on this bucket.
        outcome: 'YES',
        impliedProbability: ask,
        externalSignalData: {
          city,
          targetDate: targetDate.toISOString(),
          unit,
          bucketLower: entry.parsed.lowerEdge,
          bucketUpper: entry.parsed.upperEdge,
          bucketKind: entry.parsed.kind,
          forecastValue,
          sigma: sigmaForHorizon(horizonHours, unit),
          horizonHours,
          modelProb,
          ask,
          edge,
          coverage,
          volume24h: entry.market.volume24h,
        },
        confidenceScore: Math.min(edge * 4, 0.95),
        suggestedSize: this.size(edge),
        forecastData,
      };
    });
  }

  // ── Sizing ────────────────────────────────────────────────────────────────

  /**
   * Scales with edge, capped by the configured per-trade limit. Falls back to a
   * flat $10 when no bankroll is configured so paper runs still produce data.
   */
  private size(edge: number): number {
    const bankroll = parseFloat(process.env.WALLET_BALANCE_USDC ?? '0');
    if (!bankroll) return 10;

    const maxPerTrade = (parseFloat(process.env.MAX_POSITION_SIZE_PCT ?? '5') / 100) * bankroll;
    // Half-Kelly-ish: an 8% edge sizes at ~40% of the cap, a 20% edge at 100%.
    const fraction = Math.min(edge * 5, 1);
    return Math.max(1, Math.round(maxPerTrade * fraction * 100) / 100);
  }
}
