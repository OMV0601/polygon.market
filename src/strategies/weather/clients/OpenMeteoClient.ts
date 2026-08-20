import { httpGet } from '../../../lib/http';

export interface GeocodingResult {
  name: string;
  latitude: number;
  longitude: number;
  country: string;
  countryCode: string;
}

export interface DailyForecast {
  date: string;          // YYYY-MM-DD
  maxTempF: number;
  minTempF: number;
  /** Most temperature markets are Celsius, so both units are carried. */
  maxTempC: number;
  minTempC: number;
  fetchedAt: Date;
}

interface GeoResponse {
  results?: Array<{
    name: string;
    latitude: number;
    longitude: number;
    country: string;
    country_code: string;
  }>;
}

interface ForecastResponse {
  daily: {
    time: string[];
    temperature_2m_max: number[];
    temperature_2m_min: number[];
  };
}

const GEO_BASE = 'https://geocoding-api.open-meteo.com/v1';
const FORECAST_BASE = 'https://api.open-meteo.com/v1';
const ENSEMBLE_BASE = 'https://ensemble-api.open-meteo.com/v1';
const FORECAST_STALENESS_HOURS = 1;

/** Daily max across every ensemble member, for one date. */
export interface EnsembleForecast {
  date: string;
  /** One daily max per member, in Celsius. */
  membersC: number[];
  meanC: number;
  /** Sample standard deviation across members — the model's own uncertainty. */
  spreadC: number;
  fetchedAt: Date;
}

interface EnsembleResponse {
  hourly: Record<string, unknown> & { time: string[] };
}

export class OpenMeteoClient {
  private geoCache = new Map<string, { result: GeocodingResult; expiresAt: number }>();
  private forecastCache = new Map<string, { forecasts: DailyForecast[]; expiresAt: number }>();
  private ensembleCache = new Map<
    string,
    { byDate: Map<string, EnsembleForecast>; expiresAt: number }
  >();

  async geocode(city: string): Promise<GeocodingResult | null> {
    const key = city.toLowerCase();
    const cached = this.geoCache.get(key);
    if (cached && Date.now() < cached.expiresAt) return cached.result;

    const { data } = await httpGet<GeoResponse>(
      `${GEO_BASE}/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`
    );

    if (!data.results?.length) return null;

    const r = data.results[0];
    const result: GeocodingResult = {
      name: r.name,
      latitude: r.latitude,
      longitude: r.longitude,
      country: r.country,
      countryCode: r.country_code,
    };

    // Cache for 24 hours — city coordinates don't change
    this.geoCache.set(key, { result, expiresAt: Date.now() + 24 * 60 * 60 * 1000 });
    return result;
  }

  async getDailyForecasts(latitude: number, longitude: number): Promise<DailyForecast[]> {
    const key = `${latitude.toFixed(2)},${longitude.toFixed(2)}`;
    const cached = this.forecastCache.get(key);
    if (cached && Date.now() < cached.expiresAt) return cached.forecasts;

    const url =
      `${FORECAST_BASE}/forecast?latitude=${latitude}&longitude=${longitude}` +
      `&daily=temperature_2m_max,temperature_2m_min` +
      `&temperature_unit=fahrenheit&forecast_days=7&timezone=auto`;

    const { data, fetchedAt } = await httpGet<ForecastResponse>(url);

    const toC = (f: number) => (f - 32) / 1.8;

    const forecasts: DailyForecast[] = data.daily.time.map((date, i) => ({
      date,
      maxTempF: data.daily.temperature_2m_max[i],
      minTempF: data.daily.temperature_2m_min[i],
      maxTempC: toC(data.daily.temperature_2m_max[i]),
      minTempC: toC(data.daily.temperature_2m_min[i]),
      fetchedAt,
    }));

    const staleMs = FORECAST_STALENESS_HOURS * 60 * 60 * 1000;
    this.forecastCache.set(key, { forecasts, expiresAt: Date.now() + staleMs });

    return forecasts;
  }

  /**
   * Daily maximum per ensemble member for one city and date.
   *
   * A single deterministic run gives a point forecast and no honest way to say
   * how uncertain it is — which is why the old model had to assume a spread.
   * The ensemble runs the same model from perturbed initial conditions, so the
   * disagreement between members *is* the uncertainty, measured rather than
   * guessed. It is wider on volatile days and narrower on settled ones, which
   * a fixed sigma can never capture.
   *
   * Returns null when the endpoint is unavailable, so the caller can fall back
   * to the deterministic run rather than skipping the market entirely.
   */
  async getEnsembleForDate(
    latitude: number,
    longitude: number,
    targetDate: Date
  ): Promise<EnsembleForecast | null> {
    const key = `ens:${latitude.toFixed(2)},${longitude.toFixed(2)}`;
    const cached = this.ensembleCache.get(key);
    const targetStr = targetDate.toISOString().slice(0, 10);

    if (cached && Date.now() < cached.expiresAt) {
      return cached.byDate.get(targetStr) ?? null;
    }

    let data: EnsembleResponse;
    try {
      const res = await httpGet<EnsembleResponse>(
        `${ENSEMBLE_BASE}/ensemble?latitude=${latitude}&longitude=${longitude}` +
          `&hourly=temperature_2m&models=gfs025&forecast_days=4&timezone=auto`,
        // The ensemble only sharpens sigma; the prior curve is a usable
        // fallback. Retrying a slow endpoint across dozens of events costs far
        // more than the precision it buys, so fail fast and move on.
        { timeoutMs: 4_000, retries: 0 }
      );
      data = res.data;
    } catch {
      // Cache the miss so one unavailable endpoint is not retried per event.
      this.ensembleCache.set(key, {
        byDate: new Map(),
        expiresAt: Date.now() + 10 * 60 * 1000,
      });
      return null;
    }

    const times = data.hourly?.time ?? [];
    if (times.length === 0) return null;

    // Members arrive as temperature_2m_member01, _member02, … alongside the
    // control run under the bare key. Take whatever is present.
    const memberKeys = Object.keys(data.hourly).filter((k) => /^temperature_2m/.test(k));
    if (memberKeys.length === 0) return null;

    const byDate = new Map<string, EnsembleForecast>();
    const dates = [...new Set(times.map((t) => t.slice(0, 10)))];

    for (const date of dates) {
      const idx = times.map((t, i) => (t.startsWith(date) ? i : -1)).filter((i) => i >= 0);
      if (idx.length === 0) continue;

      const membersC: number[] = [];
      for (const mk of memberKeys) {
        const series = data.hourly[mk] as Array<number | null> | undefined;
        if (!Array.isArray(series)) continue;
        const vals = idx.map((i) => series[i]).filter((v): v is number => typeof v === 'number');
        if (vals.length > 0) membersC.push(Math.max(...vals));
      }
      if (membersC.length === 0) continue;

      const meanC = membersC.reduce((a, b) => a + b, 0) / membersC.length;
      const variance =
        membersC.length > 1
          ? membersC.reduce((a, m) => a + (m - meanC) ** 2, 0) / (membersC.length - 1)
          : 0;

      byDate.set(date, {
        date,
        membersC,
        meanC,
        spreadC: Math.sqrt(variance),
        fetchedAt: new Date(),
      });
    }

    this.ensembleCache.set(key, {
      byDate,
      expiresAt: Date.now() + FORECAST_STALENESS_HOURS * 60 * 60 * 1000,
    });

    return byDate.get(targetStr) ?? null;
  }

  async getForecastForDate(city: string, targetDate: Date): Promise<DailyForecast | null> {
    const geo = await this.geocode(city);
    if (!geo) return null;

    const forecasts = await this.getDailyForecasts(geo.latitude, geo.longitude);
    const targetStr = targetDate.toISOString().slice(0, 10);
    return forecasts.find((f) => f.date === targetStr) ?? null;
  }
}
