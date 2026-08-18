/**
 * Parses Polymarket's daily temperature markets.
 *
 * These run as bucket series: one market per temperature value, all resolving
 * off the same daily high reading. A city/date event looks like
 *
 *   Will the highest temperature in Hong Kong be 28°C on August 18?
 *   Will the highest temperature in Hong Kong be 29°C on August 18?
 *   ...
 *   Will the highest temperature in Hong Kong be 36°C or above on August 18?
 *
 * US cities use Fahrenheit ranges instead ("be between 74-75°F"). Both forms
 * resolve off a rounded integer reading, so bucket N covers the continuous
 * interval [N-0.5, N+0.5) — that half-degree matters when integrating a
 * forecast distribution over the bucket.
 */

export type BucketKind = 'RANGE' | 'AT_OR_ABOVE' | 'AT_OR_BELOW';

export interface ParsedBucketMarket {
  slug: string;
  title: string;
  city: string;
  targetDate: Date;
  unit: 'C' | 'F';
  kind: BucketKind;
  /** Inclusive lower edge in continuous degrees. -Infinity for AT_OR_BELOW. */
  lowerEdge: number;
  /** Exclusive upper edge in continuous degrees. +Infinity for AT_OR_ABOVE. */
  upperEdge: number;
  /** Key grouping every bucket of one city/date event together. */
  eventKey: string;
}

// "in Hong Kong be", "in Seoul (Incheon) be", "in New York City be"
const CITY = String.raw`in\s+([A-Za-z][A-Za-z .'\-]*?(?:\s*\([A-Za-z .'\-]+\))?)\s+be`;
const DEG = String.raw`\s*°?\s*(C|F)\b`;
const ON_DATE = String.raw`\bon\s+([A-Z][a-z]+\s+\d{1,2})(?:st|nd|rd|th)?`;

// Order matters: the catch-all forms must be tried before the bare integer,
// since "be 36°C or above" also matches the bare-integer pattern.
const PATTERNS: Array<{ kind: BucketKind; rx: RegExp; range: boolean }> = [
  {
    kind: 'AT_OR_ABOVE',
    range: false,
    rx: new RegExp(
      `${CITY}\\s+(-?\\d+(?:\\.\\d+)?)${DEG}\\s+or\\s+(?:above|higher|more|greater).*?${ON_DATE}`,
      'i'
    ),
  },
  {
    kind: 'AT_OR_BELOW',
    range: false,
    rx: new RegExp(
      `${CITY}\\s+(-?\\d+(?:\\.\\d+)?)${DEG}\\s+or\\s+(?:below|lower|less|under).*?${ON_DATE}`,
      'i'
    ),
  },
  {
    kind: 'RANGE',
    range: true,
    rx: new RegExp(
      `${CITY}\\s+between\\s+(-?\\d+(?:\\.\\d+)?)\\s*(?:°\\s*[CF])?\\s*[-–—to]+\\s*(-?\\d+(?:\\.\\d+)?)${DEG}.*?${ON_DATE}`,
      'i'
    ),
  },
  {
    kind: 'RANGE',
    range: false,
    rx: new RegExp(`${CITY}\\s+(-?\\d+(?:\\.\\d+)?)${DEG}.*?${ON_DATE}`, 'i'),
  },
];

const TEMP_MARKET_RX = /highest temperature in/i;

/** Cheap pre-filter so callers can skip non-temperature markets. */
export function isTemperatureMarket(title: string): boolean {
  return TEMP_MARKET_RX.test(title);
}

export function parseBucketMarket(
  slug: string,
  title: string,
  now: Date = new Date()
): ParsedBucketMarket | null {
  if (!isTemperatureMarket(title)) return null;

  for (const { kind, rx, range } of PATTERNS) {
    const m = rx.exec(title);
    if (!m) continue;

    const city = normalizeCity(m[1]);
    if (!city) return null;

    let lowerEdge: number;
    let upperEdge: number;
    let unit: 'C' | 'F';
    let dateRaw: string;

    if (range) {
      const lo = parseFloat(m[2]);
      const hi = parseFloat(m[3]);
      unit = m[4].toUpperCase() as 'C' | 'F';
      dateRaw = m[5];
      // "between 74-75" covers integer readings 74 and 75.
      lowerEdge = Math.min(lo, hi) - 0.5;
      upperEdge = Math.max(lo, hi) + 0.5;
    } else {
      const v = parseFloat(m[2]);
      unit = m[3].toUpperCase() as 'C' | 'F';
      dateRaw = m[4];

      if (kind === 'AT_OR_ABOVE') {
        lowerEdge = v - 0.5;
        upperEdge = Infinity;
      } else if (kind === 'AT_OR_BELOW') {
        lowerEdge = -Infinity;
        upperEdge = v + 0.5;
      } else {
        lowerEdge = v - 0.5;
        upperEdge = v + 0.5;
      }
    }

    const targetDate = parseMonthDay(dateRaw, now);
    if (!targetDate) return null;

    return {
      slug,
      title,
      city,
      targetDate,
      unit,
      kind,
      lowerEdge,
      upperEdge,
      eventKey: `${city}|${targetDate.toISOString().slice(0, 10)}|${unit}`,
    };
  }

  return null;
}

/** "Seoul (Incheon)" → "Seoul". Geocoding does better without the qualifier. */
function normalizeCity(raw: string): string {
  const cleaned = raw.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.length >= 2 ? cleaned : '';
}

/**
 * Titles carry no year. Pick the occurrence nearest to now — a "December 31"
 * market seen on January 2 belongs to the year just ended, not the one ahead.
 */
function parseMonthDay(raw: string, now: Date): Date | null {
  const cleaned = raw.replace(/(\d+)(st|nd|rd|th)/i, '$1').trim();
  const year = now.getUTCFullYear();

  const candidates = [year - 1, year, year + 1]
    .map((y) => new Date(`${cleaned}, ${y} UTC`))
    .filter((d) => !isNaN(d.getTime()));

  if (candidates.length === 0) return null;

  return candidates.reduce((best, d) =>
    Math.abs(d.getTime() - now.getTime()) < Math.abs(best.getTime() - now.getTime()) ? d : best
  );
}

/** Groups parsed buckets into city/date events. */
export function groupIntoEvents<T extends { parsed: ParsedBucketMarket }>(
  items: T[]
): Map<string, T[]> {
  const events = new Map<string, T[]>();
  for (const item of items) {
    const list = events.get(item.parsed.eventKey) ?? [];
    list.push(item);
    events.set(item.parsed.eventKey, list);
  }
  return events;
}
