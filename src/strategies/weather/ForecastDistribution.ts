/**
 * Turns a point forecast into a probability for a temperature bucket.
 *
 * The old tempToProb() used a fixed 5°F sigmoid for every market regardless of
 * how far out the forecast was. That is wrong in both directions: a forecast 12
 * hours out is far sharper than 5°F, and one 72 hours out is not much worse, so
 * the model both missed real edge and invented it.
 *
 * Here the forecast is treated as the mean of a normal distribution whose width
 * grows with the forecast horizon, and a bucket's probability is the mass
 * between its edges.
 *
 * The sigma values below are priors, not measurements. They are in the right
 * range for numerical weather model daily-max error but they are NOT tuned to
 * these markets. `npm run track-record` reports calibration so they can be
 * fitted against resolved positions — until it has, treat any edge estimate as
 * provisional.
 */

/** Sigma in °C at zero lead time — captures observation and rounding noise. */
const SIGMA_BASE_C = 1.0;

/** Additional sigma in °C per hour of forecast lead time. */
const SIGMA_PER_HOUR_C = 0.02;

/** Beyond this horizon a daily-max forecast carries little bucket-level signal. */
export const MAX_USEFUL_HORIZON_HOURS = 72;

export interface BucketProbabilityInput {
  /** Point forecast for the daily high, in the bucket's own unit. */
  forecast: number;
  unit: 'C' | 'F';
  /** Hours from now until the market's resolution date. */
  horizonHours: number;
  lowerEdge: number;
  upperEdge: number;
}

/** Standard normal CDF via an Abramowitz & Stegun erf approximation. */
function normalCdf(x: number): number {
  if (!isFinite(x)) return x > 0 ? 1 : 0;

  const z = x / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * Math.abs(z));
  const poly =
    t * (0.254829592 +
      t * (-0.284496736 +
        t * (1.421413741 +
          t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-z * z);

  return 0.5 * (1 + (z >= 0 ? erf : -erf));
}

/**
 * Forecast uncertainty at a given lead time, in the requested unit.
 *
 * `ensembleSpreadC` is the standard deviation across ensemble members. When
 * present it is a *measurement* of the forecast's uncertainty for this specific
 * day rather than an assumption from a curve, so it takes precedence — a
 * settled high-pressure day and a frontal passage have genuinely different
 * uncertainty, and no function of lead time alone can tell them apart.
 *
 * A floor still applies: ensemble spread understates true error, because every
 * member shares the same model physics and so shares its biases.
 *
 * `calibrationScale` is the correction fitted from resolved forecasts. It
 * defaults to 1 (use the prior unchanged) until enough pairs exist to do better.
 */
export function sigmaForHorizon(
  horizonHours: number,
  unit: 'C' | 'F',
  opts: { ensembleSpreadC?: number; calibrationScale?: number } = {}
): number {
  const { ensembleSpreadC, calibrationScale = 1 } = opts;

  const clamped = Math.max(0, Math.min(horizonHours, MAX_USEFUL_HORIZON_HOURS * 2));
  const priorC = SIGMA_BASE_C + SIGMA_PER_HOUR_C * clamped;

  let sigmaC = priorC;
  if (ensembleSpreadC != null && isFinite(ensembleSpreadC) && ensembleSpreadC > 0) {
    // Members share model physics, so their disagreement is a lower bound on
    // real error. Never let it collapse below a floor that grows with lead time.
    const floorC = SIGMA_BASE_C * 0.7 + SIGMA_PER_HOUR_C * 0.5 * clamped;
    sigmaC = Math.max(ensembleSpreadC, floorC);
  }

  sigmaC *= calibrationScale;

  // Sigma is a width, so it scales by the degree-size ratio only — no offset.
  return unit === 'F' ? sigmaC * 1.8 : sigmaC;
}

/**
 * Rescales bucket probabilities so an exhaustive set sums to 1.
 *
 * Only safe when the buckets genuinely cover every outcome; on a partial set it
 * would inflate each remaining bucket and manufacture edge. The caller checks
 * coverage first via bucketSetCoverage.
 */
export function normalizeBuckets(probs: number[]): number[] {
  const total = probs.reduce((a, b) => a + b, 0);
  if (total <= 0) return probs.map(() => 0);
  return probs.map((p) => p / total);
}

/**
 * Probability that the daily high lands inside [lowerEdge, upperEdge).
 *
 * Deliberately not normalized across an event's buckets: if the scraped bucket
 * set is missing a catch-all, normalizing would silently inflate every
 * remaining bucket. The caller gets the honest per-bucket mass and can inspect
 * the sum via bucketSetCoverage().
 */
export function bucketProbability(input: BucketProbabilityInput): number {
  const { forecast, unit, horizonHours, lowerEdge, upperEdge } = input;
  const sigma = sigmaForHorizon(horizonHours, unit);

  const zLow = (lowerEdge - forecast) / sigma;
  const zHigh = (upperEdge - forecast) / sigma;

  return Math.max(0, normalCdf(zHigh) - normalCdf(zLow));
}

/**
 * Total modelled probability across a set of buckets. A value well below 1
 * means the set is missing outcomes — usually an unmatched catch-all bucket —
 * and any per-bucket edge from that event should be treated with suspicion.
 */
export function bucketSetCoverage(
  buckets: Array<{ lowerEdge: number; upperEdge: number }>,
  forecast: number,
  unit: 'C' | 'F',
  horizonHours: number
): number {
  return buckets.reduce(
    (sum, b) =>
      sum +
      bucketProbability({
        forecast,
        unit,
        horizonHours,
        lowerEdge: b.lowerEdge,
        upperEdge: b.upperEdge,
      }),
    0
  );
}
