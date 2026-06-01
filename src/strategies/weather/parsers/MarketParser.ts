export interface ParsedWeatherMarket {
  slug: string;
  title: string;
  city: string;
  targetDate: Date;
  thresholdF: number;
  direction: 'ABOVE' | 'BELOW';
  isUSCity: boolean;
}

// Matches: "exceed 90°F", "reach 95 degrees", "surpass 85°F", "be above 100°"
const ABOVE_RX = /(?:exceed|reach|surpass|hit|top|be above|go above|rise above)\s+(\d+(?:\.\d+)?)\s*(?:°F|°C|℉|℃|degrees?)/i;

// Matches: "fall below 32°F", "drop below 40°F", "stay under 50°F", "go below"
const BELOW_RX = /(?:fall below|drop below|stay under|be below|go below|be under)\s+(\d+(?:\.\d+)?)\s*(?:°F|°C|℉|℃|degrees?)/i;

// Matches "in Seattle", "in New York City", "in Los Angeles" (1-4 word proper nouns)
const CITY_RX = /\bin\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,3})/;

// Date pattern: "July 4", "July 4th", "July 4, 2025", "on June 30"
const DATE_RX = /(?:on\s+)?([A-Z][a-z]+\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s*\d{4})?)/;

const US_CITIES = new Set([
  'New York', 'New York City', 'NYC', 'Los Angeles', 'Chicago', 'Houston', 'Phoenix',
  'Philadelphia', 'San Antonio', 'San Diego', 'Dallas', 'San Jose', 'Austin', 'Jacksonville',
  'Fort Worth', 'Columbus', 'Charlotte', 'Indianapolis', 'San Francisco', 'Seattle',
  'Denver', 'Washington', 'DC', 'Nashville', 'Las Vegas', 'Portland', 'Memphis',
  'Oklahoma City', 'Boston', 'Atlanta', 'Miami', 'Minneapolis', 'Tampa', 'New Orleans',
  'Raleigh', 'Sacramento', 'Kansas City', 'Omaha', 'Tucson', 'Albuquerque', 'Louisville',
  'Baltimore', 'Milwaukee', 'Salt Lake City', 'Reno', 'Boise', 'Richmond', 'Detroit',
  'Pittsburgh', 'Cincinnati', 'Cleveland', 'St Louis', 'Saint Louis',
]);

export function parseWeatherMarket(slug: string, title: string): ParsedWeatherMarket | null {
  // Direction + threshold
  const aboveMatch = ABOVE_RX.exec(title);
  const belowMatch = BELOW_RX.exec(title);

  if (!aboveMatch && !belowMatch) return null;

  const match = (aboveMatch ?? belowMatch)!;
  const direction: 'ABOVE' | 'BELOW' = aboveMatch ? 'ABOVE' : 'BELOW';
  const thresholdF = parseFloat(match[1]);

  // City
  const cityMatch = CITY_RX.exec(title);
  if (!cityMatch) return null;
  const city = cityMatch[1].trim();

  // Date
  const dateMatch = DATE_RX.exec(title);
  if (!dateMatch) return null;

  const targetDate = parseDate(dateMatch[1]);
  if (!targetDate) return null;

  return {
    slug,
    title,
    city,
    targetDate,
    thresholdF,
    direction,
    isUSCity: US_CITIES.has(city),
  };
}

function parseDate(raw: string): Date | null {
  try {
    // If no year, assume current or next occurrence
    const withYear = /\d{4}/.test(raw) ? raw : `${raw}, ${new Date().getFullYear()}`;
    const d = new Date(withYear.replace(/(\d+)(st|nd|rd|th)/, '$1'));
    if (isNaN(d.getTime())) return null;
    return d;
  } catch {
    return null;
  }
}
