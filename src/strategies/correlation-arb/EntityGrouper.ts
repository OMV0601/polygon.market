export interface MarketEntry {
  slug: string;
  title: string;
  yesPrice: number;
  volume24h: number;
}

export interface ArbOpportunity {
  slugA: string;
  titleA: string;
  yesPriceA: number;
  slugB: string;
  titleB: string;
  yesPriceB: number;
  grossMargin: number;
  side: 'BUY_BOTH_YES' | 'BUY_BOTH_NO';
}

// Antonym pairs that indicate two markets are logical complements
const ANTONYMS: Array<[string, string]> = [
  ['win', 'lose'], ['wins', 'loses'], ['winner', 'loser'],
  ['beat', 'beaten'], ['defeat', 'defeated'],
  ['pass', 'fail'], ['passes', 'fails'],
  ['yes', 'no'],
  ['over', 'under'],
  ['above', 'below'],
  ['increase', 'decrease'], ['rises', 'falls'], ['up', 'down'],
  ['remain', 'leave'], ['stays', 'exits'],
  ['re-elected', 'defeated'], ['elected', 'loses'],
];

function normalize(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractKeyTokens(title: string): string[] {
  const stopWords = new Set([
    'will', 'the', 'a', 'an', 'in', 'on', 'at', 'to', 'of', 'for', 'and', 'or',
    'be', 'is', 'are', 'was', 'were', 'by', 'it', 'that', 'with', 'have',
  ]);
  return normalize(title)
    .split(' ')
    .filter((w) => w.length > 2 && !stopWords.has(w));
}

function jaccard(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  const intersection = [...setA].filter((w) => setB.has(w)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

function isAntonymPair(titleA: string, titleB: string): boolean {
  const normA = normalize(titleA);
  const normB = normalize(titleB);
  for (const [word, antonym] of ANTONYMS) {
    if (normA.includes(word) && normB.includes(antonym)) return true;
    if (normA.includes(antonym) && normB.includes(word)) return true;
  }
  return false;
}

export function findArbOpportunities(
  markets: MarketEntry[],
  feeRate: number,
  minMargin: number
): ArbOpportunity[] {
  const opportunities: ArbOpportunity[] = [];

  for (let i = 0; i < markets.length; i++) {
    for (let j = i + 1; j < markets.length; j++) {
      const a = markets[i];
      const b = markets[j];

      const tokensA = extractKeyTokens(a.title);
      const tokensB = extractKeyTokens(b.title);

      // Markets must be semantically similar (same entity/event) but with antonym verbs
      const sim = jaccard(tokensA, tokensB);
      if (sim < 0.4) continue;
      if (!isAntonymPair(a.title, b.title)) continue;

      const sum = a.yesPrice + b.yesPrice;
      const grossMargin = Math.abs(1 - sum);
      const netMargin = grossMargin - 2 * feeRate;

      if (netMargin < minMargin) continue;

      opportunities.push({
        slugA: a.slug,
        titleA: a.title,
        yesPriceA: a.yesPrice,
        slugB: b.slug,
        titleB: b.title,
        yesPriceB: b.yesPrice,
        grossMargin,
        side: sum < 1 ? 'BUY_BOTH_YES' : 'BUY_BOTH_NO',
      });
    }
  }

  // Return highest-margin opportunities first
  return opportunities.sort((a, b) => b.grossMargin - a.grossMargin);
}
