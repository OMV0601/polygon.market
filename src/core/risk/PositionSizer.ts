/**
 * Fractional Kelly sizing off the live bankroll.
 *
 * For a binary contract bought at `p` that the model prices at `q`:
 *
 *   f* = (q − p) / (1 − p)
 *
 * That is full Kelly — the growth-optimal fraction *if q is correct*. It never
 * is, and full Kelly on an overestimated edge is the standard way to destroy an
 * account: the penalty for overbetting is far steeper than the reward for
 * betting the exact optimum. A quarter of Kelly gives up little growth and
 * survives a model that is wrong.
 *
 * Two further constraints matter more than the formula at small size:
 *
 *   - Bankroll is read from the ledger, not a static env var, so a drawdown
 *     shrinks positions automatically instead of compounding the mistake.
 *   - Positions in a correlation group share one budget. Two buckets on the
 *     same city and day are one forecast expressed twice, and sizing them as
 *     independent doubles the real exposure while appearing diversified.
 */

export interface SizingInput {
  /** Model probability. */
  q: number;
  /** Price actually paid, after walking the book. */
  price: number;
  /** Current bankroll in USDC, from the ledger. */
  bankroll: number;
  /** Kelly fraction. 0.25 unless there is a specific reason. */
  kellyFraction?: number;
  /** Hard cap on any single position, as a percent of bankroll. */
  maxPositionPct: number;
  /** Cap on all positions sharing a correlation group, as a percent. */
  maxGroupPct: number;
  /** USDC already deployed into this correlation group. */
  groupExposureUsdc: number;
  /** USDC the book can absorb at an acceptable price. */
  fillableUsdc: number;
}

export interface SizingResult {
  sizeUsdc: number;
  fullKellyFraction: number;
  appliedFraction: number;
  /** Which constraint decided the number. */
  boundBy: 'kelly' | 'position-cap' | 'group-cap' | 'liquidity' | 'no-edge';
}

export const DEFAULT_KELLY_FRACTION = 0.25;

export function sizePosition(input: SizingInput): SizingResult {
  const {
    q, price, bankroll,
    kellyFraction = DEFAULT_KELLY_FRACTION,
    maxPositionPct, maxGroupPct, groupExposureUsdc, fillableUsdc,
  } = input;

  // A price at or above the model's probability has no edge to size against,
  // and 1 − p goes to zero at the top of the range, which would blow up f*.
  if (q <= price || price >= 0.99 || price <= 0 || bankroll <= 0) {
    return { sizeUsdc: 0, fullKellyFraction: 0, appliedFraction: 0, boundBy: 'no-edge' };
  }

  const fullKelly = (q - price) / (1 - price);
  const applied = fullKelly * kellyFraction;

  const kellySize = applied * bankroll;
  const positionCap = (maxPositionPct / 100) * bankroll;
  const groupRemaining = Math.max(0, (maxGroupPct / 100) * bankroll - groupExposureUsdc);

  let sizeUsdc = kellySize;
  let boundBy: SizingResult['boundBy'] = 'kelly';

  if (positionCap < sizeUsdc) {
    sizeUsdc = positionCap;
    boundBy = 'position-cap';
  }
  if (groupRemaining < sizeUsdc) {
    sizeUsdc = groupRemaining;
    boundBy = 'group-cap';
  }
  if (fillableUsdc < sizeUsdc) {
    sizeUsdc = fillableUsdc;
    boundBy = 'liquidity';
  }

  // Round to the cent, and drop anything too small to be worth a round trip.
  sizeUsdc = Math.floor(Math.max(0, sizeUsdc) * 100) / 100;
  if (sizeUsdc < 1) {
    return { sizeUsdc: 0, fullKellyFraction: fullKelly, appliedFraction: applied, boundBy };
  }

  return { sizeUsdc, fullKellyFraction: fullKelly, appliedFraction: applied, boundBy };
}

/**
 * Positions that share a group are one bet. For temperature markets that is the
 * city and date: every bucket resolves off the same reading, so a forecast
 * error hits all of them together.
 */
export function correlationGroupFor(marketSlug: string): string {
  const m = /^highest-temperature-in-(.+?)-on-([a-z]+-\d{1,2}-\d{4})/i.exec(marketSlug);
  if (m) return `temp:${m[1]}:${m[2]}`;
  return `slug:${marketSlug}`;
}
