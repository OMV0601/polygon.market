import { BaseStrategy } from '../base/BaseStrategy';
import { STRATEGY_INTERVALS, RISK } from '../../config/constants';
import { logger } from '../../core/logger/logger';
import { OpenMeteoClient } from './clients/OpenMeteoClient';
import { NWSClient } from './clients/NWSClient';
import { parseWeatherMarket } from './parsers/MarketParser';
import type { CandidatePayload, ForecastData, Outcome, StrategyModule } from '../../core/risk/types';

const NOW_MS = () => Date.now();
const HOURS_72 = 72 * 60 * 60 * 1000;

export class WeatherStrategy extends BaseStrategy {
  protected readonly name: StrategyModule = 'WEATHER';
  protected readonly intervalMs = STRATEGY_INTERVALS.WEATHER_MS;

  private readonly openMeteo = new OpenMeteoClient();
  private readonly nws = new NWSClient();

  protected async scan(): Promise<CandidatePayload[]> {
    let markets: Awaited<ReturnType<typeof this.bullpen.discover>>['markets'];

    try {
      const result = await this.bullpen.discover({ category: 'weather' });
      markets = result.markets;
      markets.forEach((m) =>
        this.db.upsertMarket({
          slug: m.slug, title: m.title, category: 'weather',
          volume24h: m.volume24h, bestBid: m.bestBid, bestAsk: m.bestAsk,
          liquidity: m.liquidity, endDate: m.endDate,
          lastFetched: new Date().toISOString(),
        })
      );
    } catch (err) {
      logger.warn('Weather: bullpen discover failed, falling back to DB cache', {
        error: (err as Error).message,
      });
      markets = this.db.getMarketsByCategory('weather').map((m) => ({
        slug: m.slug, title: m.title, category: 'weather',
        volume24h: m.volume24h, bestBid: m.bestBid ?? 0, bestAsk: m.bestAsk ?? 0,
        spread: (m.bestAsk ?? 0) - (m.bestBid ?? 0),
        liquidity: 0, endDate: m.endDate ?? undefined, outcomes: [],
      }));
    }

    const candidates: CandidatePayload[] = [];

    for (const market of markets) {
      try {
        const candidate = await this.evaluateMarket(market);
        if (candidate) candidates.push(candidate);
      } catch (err) {
        logger.warn('Weather: market evaluation failed', {
          slug: market.slug,
          error: (err as Error).message,
        });
      }
    }

    return candidates;
  }

  private async evaluateMarket(
    market: { slug: string; title: string; bestAsk: number; bestBid: number; volume24h: number; endDate?: string }
  ): Promise<CandidatePayload | null> {
    const parsed = parseWeatherMarket(market.slug, market.title);
    if (!parsed) {
      logger.debug('Weather: could not parse market title', { slug: market.slug });
      return null;
    }

    // Reject markets resolving beyond 72 hours
    const hoursUntilResolution = parsed.targetDate.getTime() - NOW_MS();
    if (hoursUntilResolution > HOURS_72 || hoursUntilResolution < 0) return null;

    // Fetch forecast — prefer NWS for US cities
    let forecast: { maxTempF: number; fetchedAt: Date } | null = null;

    if (parsed.isUSCity) {
      try {
        const geo = await this.openMeteo.geocode(parsed.city);
        if (geo) {
          const nwsResult = await this.nws.getDailyHighF(
            geo.latitude, geo.longitude, parsed.targetDate
          );
          if (nwsResult) forecast = nwsResult;
        }
      } catch {
        // fall through to Open-Meteo
      }
    }

    if (!forecast) {
      const omResult = await this.openMeteo.getForecastForDate(parsed.city, parsed.targetDate);
      if (!omResult) return null;
      forecast = { maxTempF: omResult.maxTempF, fetchedAt: omResult.fetchedAt };
    }

    // Stale data check
    const staleMs = RISK.MAX_FORECAST_STALENESS_HOURS * 60 * 60 * 1000;
    if (NOW_MS() - forecast.fetchedAt.getTime() > staleMs) {
      logger.warn('Weather: forecast data is stale', { slug: market.slug });
      return null;
    }

    // Convert forecast to a probability
    // We use a simple sigmoid based on how far the forecast temp is from the threshold.
    // A more robust implementation would use the full distribution.
    const forecastProb = this.tempToProb(forecast.maxTempF, parsed.thresholdF, parsed.direction);
    const impliedProb = parsed.direction === 'ABOVE' ? market.bestAsk : 1 - market.bestAsk;

    const gap = Math.abs(forecastProb - impliedProb);

    // Only emit candidates with a meaningful gap (>= 20 percentage points)
    if (gap < 0.20) return null;

    // Confidence is proportional to the gap size
    const confidenceScore = Math.min(gap * 2, 0.99);

    logger.info('Weather: structural lag detected', {
      slug: market.slug,
      city: parsed.city,
      thresholdF: parsed.thresholdF,
      forecastMaxF: forecast.maxTempF,
      forecastProb: forecastProb.toFixed(3),
      impliedProb: impliedProb.toFixed(3),
      gap: gap.toFixed(3),
    });

    const outcome: Outcome =
      forecastProb > impliedProb
        ? parsed.direction === 'ABOVE' ? 'YES' : 'NO'
        : parsed.direction === 'ABOVE' ? 'NO' : 'YES';

    const forecastData: ForecastData = {
      source: parsed.isUSCity ? 'NWS' : 'OPEN_METEO',
      city: parsed.city,
      forecastedValue: forecast.maxTempF,
      unit: '°F',
      confidenceInterval: [forecast.maxTempF - 3, forecast.maxTempF + 3],
      fetchedAt: forecast.fetchedAt,
    };

    return {
      strategyModule: 'WEATHER',
      marketSlug: market.slug,
      outcome,
      impliedProbability: impliedProb,
      externalSignalData: {
        city: parsed.city,
        targetDate: parsed.targetDate.toISOString(),
        thresholdF: parsed.thresholdF,
        direction: parsed.direction,
        forecastMaxF: forecast.maxTempF,
        forecastProb,
        impliedProb,
        gap,
        volume24h: market.volume24h,
      },
      confidenceScore,
      suggestedSize: this.size(confidenceScore),
      forecastData,
    };
  }

  // Rough sigmoid: returns probability that max temp is ABOVE threshold
  private tempToProb(forecastMax: number, threshold: number, direction: 'ABOVE' | 'BELOW'): number {
    const delta = forecastMax - threshold;
    // Each 5°F away from threshold adds ~25% confidence
    const prob = 1 / (1 + Math.exp(-delta / 5));
    return direction === 'ABOVE' ? prob : 1 - prob;
  }

  private size(confidence: number): number {
    if (this.db.getTotalOpenExposureUsdc() === 0 && !process.env.WALLET_BALANCE_USDC) return 10;
    const base = (parseFloat(process.env.MAX_POSITION_SIZE_PCT ?? '5') / 100) *
                 parseFloat(process.env.WALLET_BALANCE_USDC ?? '0');
    return base > 0 ? Math.round(base * confidence * 100) / 100 : 10;
  }
}
