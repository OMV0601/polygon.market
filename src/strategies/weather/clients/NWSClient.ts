import { httpGet } from '../../../lib/http';

interface PointsResponse {
  properties: { forecast: string; forecastHourly: string };
}

interface ForecastPeriod {
  name: string;
  startTime: string;
  endTime: string;
  temperature: number;
  temperatureUnit: string;
  isDaytime: boolean;
}

interface ForecastResponse {
  properties: { periods: ForecastPeriod[] };
}

export interface NWSForecast {
  date: string;        // YYYY-MM-DD
  maxTempF: number;
  fetchedAt: Date;
}

const NWS_BASE = 'https://api.weather.gov';
const HEADERS = { 'User-Agent': 'polygon-market-bot/1.0 (contact@polygon.market)' };

export class NWSClient {
  private gridCache = new Map<string, { forecastUrl: string; expiresAt: number }>();

  async getForecastUrl(lat: number, lon: number): Promise<string> {
    const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
    const cached = this.gridCache.get(key);
    if (cached && Date.now() < cached.expiresAt) return cached.forecastUrl;

    const { data } = await httpGet<PointsResponse>(
      `${NWS_BASE}/points/${lat},${lon}`,
      { headers: HEADERS }
    );

    const forecastUrl = data.properties.forecast;
    this.gridCache.set(key, { forecastUrl, expiresAt: Date.now() + 12 * 60 * 60 * 1000 });
    return forecastUrl;
  }

  async getDailyHighF(lat: number, lon: number, targetDate: Date): Promise<NWSForecast | null> {
    const forecastUrl = await this.getForecastUrl(lat, lon);
    const { data, fetchedAt } = await httpGet<ForecastResponse>(forecastUrl, { headers: HEADERS });

    const targetStr = targetDate.toISOString().slice(0, 10);
    const daytimePeriods = data.properties.periods.filter(
      (p) => p.isDaytime && p.startTime.startsWith(targetStr)
    );

    if (daytimePeriods.length === 0) return null;

    const maxTempF = Math.max(
      ...daytimePeriods.map((p) =>
        p.temperatureUnit === 'F' ? p.temperature : (p.temperature * 9) / 5 + 32
      )
    );

    return { date: targetStr, maxTempF, fetchedAt };
  }
}
