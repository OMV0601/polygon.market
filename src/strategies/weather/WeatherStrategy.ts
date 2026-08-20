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
  normalizeBuckets,
  sigmaForHorizon,
} from './ForecastDistribution';
import { evaluateEdge } from '../../core/edge/EdgeEngine';
import { correlationGroupFor, sizePosition } from '../../core/risk/PositionSizer';
import { fitSigmaScale } from '../../core/calibration/CalibrationReport';
import { mapWithConcurrency, optional } from '../../lib/concurrency';
import type { CandidatePayload, ForecastData, StrategyModule } from '../../core/risk/types';

/** Identifies this model in the forecast log, so scores stay comparable. */
const MODEL_NAME = 'weather-bucket';
/** Bump whenever the pricing changes, so old and new are scored separately. */
const MODEL_VERSION = '2.1.0-no-partial-normalise';

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

/** Events evaluated per cycle, soonest-resolving first. */
const MAX_EVENTS_PER_CYCLE = 40;

/** Events priced at once. Bounded so neither API sees a burst. */
const EVENT_CONCURRENCY = 6;

/** Order books fetched at once within one event. */
const BOOK_CONCURRENCY = 4;

export class WeatherStrategy extends BaseStrategy {
  protected readonly name: StrategyModule = 'WEATHER';
  protected readonly intervalMs = STRATEGY_INTERVALS.WEATHER_MS;

  private readonly openMeteo = new OpenMeteoClient();

  /** Multiplier on forecast spread, refit from resolved forecasts each cycle. */
  private calibrationScale = 1;

  protected async scan(): Promise<CandidatePayload[]> {
    const startedAt = Date.now();
    this.refreshCalibration();

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

    // Soonest-resolving events first: forecast skill is highest at short lead
    // times, so if the cycle budget runs out the events dropped are the ones
    // the model is least confident about anyway.
    const ordered = [...events.entries()].sort((a, b) => {
      const ta = a[1][0].parsed.targetDate.getTime();
      const tb = b[1][0].parsed.targetDate.getTime();
      return ta - tb;
    });

    if (ordered.length > MAX_EVENTS_PER_CYCLE) {
      logger.info('Weather: capping events this cycle', {
        found: ordered.length,
        evaluating: MAX_EVENTS_PER_CYCLE,
      });
    }
    const selected = ordered.slice(0, MAX_EVENTS_PER_CYCLE);

    // The scan is network-bound, so events run concurrently. Sequentially this
    // took minutes and risked the scheduled job's timeout.
    const perEvent = await mapWithConcurrency(
      selected,
      EVENT_CONCURRENCY,
      async ([eventKey, buckets]) => {
        try {
          return await this.evaluateEvent(eventKey, buckets);
        } catch (err) {
          logger.warn('Weather: event evaluation failed', {
            eventKey,
            error: (err as Error).message,
          });
          return [] as CandidatePayload[];
        }
      }
    );

    const candidates = perEvent.flat();
    logger.info('Weather: scan produced candidates', {
      count: candidates.length,
      eventsEvaluated: selected.length,
      durationMs: Date.now() - startedAt,
    });
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

    // Ensemble spread measures this day's uncertainty instead of reading it off
    // a curve. Falls back to the curve when the endpoint is unavailable.
    let ensembleSpreadC: number | undefined;
    const geo = await this.openMeteo.geocode(city).catch(() => null);
    if (geo) {
      const ens = await this.openMeteo.getEnsembleForDate(geo.latitude, geo.longitude, targetDate);
      if (ens && ens.membersC.length >= 3) ensembleSpreadC = ens.spreadC;
    }

    const sigmaOpts = { ensembleSpreadC, calibrationScale: this.calibrationScale };

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

    // Every bucket's probability is logged, not just the ones that trade.
    // Scoring only the traded ones would measure the entry threshold rather
    // than the model, and the threshold is the part we already know.
    const priced = buckets.map((entry) => ({
      entry,
      modelProb: bucketProbability({
        forecast: forecastValue,
        unit,
        horizonHours,
        lowerEdge: entry.parsed.lowerEdge,
        upperEdge: entry.parsed.upperEdge,
      }),
    }));

    // Renormalising is only valid when the buckets really are exhaustive. On a
    // partial set it scales every probability by 1/coverage — at the old 0.70
    // gate that was up to a 43% inflation applied uniformly, which reads as
    // edge against every market price and is the most likely reason the model
    // scored worse than the market it was betting against.
    const exhaustive = coverage >= RISK.WEATHER_NORMALIZE_COVERAGE;
    const normalized = exhaustive
      ? normalizeBuckets(priced.map((p) => p.modelProb))
      : priced.map((p) => p.modelProb);

    if (!exhaustive) {
      logger.debug('Weather: partial bucket set, using unnormalised probabilities', {
        eventKey,
        coverage: coverage.toFixed(3),
      });
    }

    const sigma = sigmaForHorizon(horizonHours, unit, sigmaOpts);
    const resolvesAt = new Date(highTempAt).toISOString();

    for (let i = 0; i < priced.length; i++) {
      const { entry } = priced[i];
      this.db.insertForecast({
        modelName: MODEL_NAME,
        modelVersion: MODEL_VERSION,
        marketSlug: entry.market.slug,
        predictedProb: normalized[i],
        marketPriceAtForecast: (entry.market.bestBid + entry.market.bestAsk) / 2,
        features: {
          city,
          unit,
          forecastValue,
          sigma,
          ensembleSpreadC: ensembleSpreadC ?? null,
          calibrationScale: this.calibrationScale,
          horizonHours,
          bucketLower: entry.parsed.lowerEdge,
          bucketUpper: entry.parsed.upperEdge,
        },
        resolvesAt,
      });
    }

    const bankroll = this.bankroll();
    const groupKey = correlationGroupFor(buckets[0].market.slug);
    const groupExposure = this.db.getOpenExposureByEventPrefix(groupKey);

    const candidates: CandidatePayload[] = [];

    // Rank by the engine's own measure so buckets compete on net cents per
    // share rather than on a raw probability gap.
    const ranked = priced
      .map((p, i) => ({ ...p, modelProb: normalized[i] }))
      .sort((a, b) => b.modelProb - a.modelProb);

    // Only buckets priced in the tradeable band are worth a book fetch. A few
    // more than the per-event cap are fetched, since some will come back PASS
    // or QUOTE and would otherwise leave the cap unfilled.
    const eligible = ranked
      .filter(
        ({ entry }) =>
          entry.market.bestAsk >= RISK.WEATHER_MIN_ASK &&
          entry.market.bestAsk <= RISK.WEATHER_MAX_ASK
      )
      .slice(0, RISK.WEATHER_MAX_BUCKETS_PER_EVENT * 3);

    // Fetched together rather than one at a time inside the decision loop:
    // these are independent requests and the loop was serialising them.
    const books = await mapWithConcurrency(eligible, BOOK_CONCURRENCY, ({ entry }) =>
      optional(this.bullpen.orderBook(entry.market.slug, 'YES'))
    );

    for (let i = 0; i < eligible.length; i++) {
      if (candidates.length >= RISK.WEATHER_MAX_BUCKETS_PER_EVENT) break;

      const { entry, modelProb } = eligible[i];
      const book = books[i];
      if (!book) {
        logger.debug('Weather: order book unavailable', { slug: entry.market.slug });
        continue;
      }

      // Snapshot the book so a parameter change can be replayed against the
      // same conditions later instead of costing another day of calendar time.
      this.db.insertBookSnapshot({
        marketSlug: entry.market.slug,
        outcome: 'YES',
        bestBid: book.bestBid,
        bestAsk: book.bestAsk,
        bids: book.bids,
        asks: book.asks,
      });

      // Provisional size drives how far up the book the engine walks; the
      // sizer then prices the edge that walk actually produced.
      const probe = Math.max(1, (RISK.WEATHER_MAX_BUCKETS_PER_EVENT / 100) * bankroll);

      const edge = evaluateEdge({
        q: modelProb,
        confidence: Math.min(0.95, coverage),
        bids: book.bids,
        asks: book.asks,
        bestBid: book.bestBid,
        bestAsk: book.bestAsk,
        category: 'weather',
        intendedSizeUsdc: probe,
        recentVolatility: sigma > 0 ? Math.min(0.05, sigma / 100) : 0,
      });

      if (edge.action === 'PASS') {
        logger.debug('Weather: no actionable edge', { slug: entry.market.slug, reason: edge.reason });
        continue;
      }

      // QUOTE is a real outcome of the engine, but there is no maker execution
      // path yet — posting requires signed limit orders. Recording it keeps the
      // opportunity visible in the log without pretending it was traded.
      if (edge.action === 'QUOTE') {
        logger.info('Weather: maker-only opportunity (no quoting path yet)', {
          slug: entry.market.slug,
          makerEdgeCents: edge.makerEdgeCentsPerShare.toFixed(2),
          takerEdgeCents: edge.takerEdgeCentsPerShare.toFixed(2),
          quotePrice: edge.quotePrice.toFixed(3),
        });
        continue;
      }

      const sized = sizePosition({
        q: modelProb,
        price: edge.avgFillPrice,
        bankroll,
        maxPositionPct: parseFloat(process.env.MAX_POSITION_SIZE_PCT ?? '5'),
        maxGroupPct: RISK.MAX_EVENT_EXPOSURE_PCT,
        groupExposureUsdc: groupExposure,
        fillableUsdc: edge.fillableUsdc,
      });

      if (sized.sizeUsdc <= 0) {
        logger.debug('Weather: sized to zero', { slug: entry.market.slug, boundBy: sized.boundBy });
        continue;
      }

      logger.info('Weather: tradeable edge', {
        city,
        slug: entry.market.slug,
        modelProb: modelProb.toFixed(3),
        avgFill: edge.avgFillPrice.toFixed(3),
        takerEdgeCents: edge.takerEdgeCentsPerShare.toFixed(2),
        feePerShareCents: (edge.feePerShare * 100).toFixed(2),
        sizeUsdc: sized.sizeUsdc.toFixed(2),
        kelly: sized.fullKellyFraction.toFixed(3),
        boundBy: sized.boundBy,
        sigma: sigma.toFixed(2),
        ensembleSpread: ensembleSpreadC?.toFixed(2) ?? 'n/a',
      });

      const forecastData: ForecastData = {
        source: 'OPEN_METEO',
        city,
        forecastedValue: forecastValue,
        unit: `\u00b0${unit}`,
        confidenceInterval: [forecastValue - sigma, forecastValue + sigma],
        fetchedAt: forecast.fetchedAt,
      };

      candidates.push({
        strategyModule: 'WEATHER',
        marketSlug: entry.market.slug,
        outcome: 'YES',
        impliedProbability: edge.avgFillPrice,
        externalSignalData: {
          city,
          targetDate: targetDate.toISOString(),
          unit,
          feeCategory: 'weather',
          bucketLower: entry.parsed.lowerEdge,
          bucketUpper: entry.parsed.upperEdge,
          bucketKind: entry.parsed.kind,
          forecastValue,
          sigma,
          ensembleSpreadC: ensembleSpreadC ?? null,
          calibrationScale: this.calibrationScale,
          horizonHours,
          modelProb,
          avgFillPrice: edge.avgFillPrice,
          takerEdgeCents: edge.takerEdgeCentsPerShare,
          makerEdgeCents: edge.makerEdgeCentsPerShare,
          kellyFraction: sized.fullKellyFraction,
          sizeBoundBy: sized.boundBy,
          coverage,
          volume24h: entry.market.volume24h,
        },
        confidenceScore: Math.min(0.95, coverage),
        suggestedSize: sized.sizeUsdc,
        forecastData,
      });
    }

    return candidates;
  }

  // ── Bankroll and calibration ──────────────────────────────────────────────

  /** Bankroll from the ledger, falling back to the configured starting stake. */
  private bankroll(): number {
    const configured = parseFloat(process.env.WALLET_BALANCE_USDC ?? '0');
    const realized = this.db.getPnlSummary().realizedPnl;
    // Deployed capital is still ours, so only realised P&L moves the base.
    // A drawdown shrinks every subsequent position without any manual step.
    return Math.max(0, configured + realized);
  }

  /**
   * Correction to forecast spread, refitted once per cycle from resolved
   * forecasts. Stays at 1 until there are enough pairs to beat the prior.
   */
  private refreshCalibration(): void {
    const resolved = this.db.getResolvedForecasts(MODEL_NAME);
    const fit = fitSigmaScale(resolved);
    if (fit) {
      if (Math.abs(fit.scale - this.calibrationScale) > 0.01) {
        logger.info('Weather: sigma recalibrated from resolved forecasts', {
          scale: fit.scale.toFixed(3),
          samples: fit.samples,
        });
      }
      this.calibrationScale = fit.scale;
    }
  }
}
