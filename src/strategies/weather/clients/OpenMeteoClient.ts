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
const FORECAST_STALENESS_HOURS = 1;

export class OpenMeteoClient {
  private geoCache = new Map<string, { result: GeocodingResult; expiresAt: number }>();
  private forecastCache = new Map<string, { forecasts: DailyForecast[]; expiresAt: number }>();

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

  async getForecastForDate(city: string, targetDate: Date): Promise<DailyForecast | null> {
    const geo = await this.geocode(city);
    if (!geo) return null;

    const forecasts = await this.getDailyForecasts(geo.latitude, geo.longitude);
    const targetStr = targetDate.toISOString().slice(0, 10);
    return forecasts.find((f) => f.date === targetStr) ?? null;
  }
}
