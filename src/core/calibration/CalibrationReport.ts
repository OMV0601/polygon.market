/**
 * Scores a forecasting model against the market on identical questions.
 *
 * P&L cannot answer "does this model have skill" at small sample sizes — a run
 * of luck and a real edge look the same for months. A proper scoring rule can,
 * because it uses every forecast rather than only the ones that became trades,
 * and because the market gives a free benchmark on the same questions.
 *
 * Brier score is mean squared error of probabilities:
 *
 *   Brier = mean((predicted − outcome)²)
 *
 * Zero is perfect, 0.25 is what you score by always saying 50%. The absolute
 * number means little on its own — the comparison against the market's Brier
 * over the same forecasts is the whole point. If the model does not beat the
 * price it is trading against, there is no edge, whatever the P&L says.
 */

/** Below this many resolved forecasts, no conclusion is reported. */
export const MIN_FORECASTS_FOR_VERDICT = 100;

export interface ScoredForecast {
  modelName: string;
  predictedProb: number;
  marketPriceAtForecast: number | null;
  resolvedOutcome: number;
}

export interface ReliabilityBucket {
  lower: number;
  upper: number;
  count: number;
  meanPredicted: number;
  actualRate: number;
  /** Wilson 95% interval on the realised rate. */
  ciLow: number;
  ciHigh: number;
}

export interface ModelCalibration {
  modelName: string;
  resolvedCount: number;
  /** Null when no forecast in the sample recorded a market price. */
  modelBrier: number;
  marketBrier: number | null;
  /** marketBrier − modelBrier. Positive means the model beat the market. */
  skill: number | null;
  reliability: ReliabilityBucket[];
  /** True once the sample is large enough to draw any conclusion. */
  sufficientData: boolean;
  verdict: string;
}

export function wilson(successes: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 1];
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (centre - margin) / denom), Math.min(1, (centre + margin) / denom)];
}

function brier(pairs: Array<{ p: number; outcome: number }>): number {
  if (pairs.length === 0) return NaN;
  return pairs.reduce((sum, { p, outcome }) => sum + (p - outcome) ** 2, 0) / pairs.length;
}

export function calibrate(forecasts: ScoredForecast[], modelName: string): ModelCalibration {
  const rows = forecasts.filter((f) => f.modelName === modelName);

  const modelPairs = rows.map((f) => ({ p: f.predictedProb, outcome: f.resolvedOutcome }));

  // Score the market only on forecasts where its price was captured, and score
  // the model on the same subset — otherwise the two Briers answer different
  // questions and the comparison is meaningless.
  const paired = rows.filter((f) => f.marketPriceAtForecast != null);
  const marketBrier = paired.length
    ? brier(paired.map((f) => ({ p: f.marketPriceAtForecast!, outcome: f.resolvedOutcome })))
    : null;
  const modelBrierOnPaired = paired.length
    ? brier(paired.map((f) => ({ p: f.predictedProb, outcome: f.resolvedOutcome })))
    : null;

  const skill =
    marketBrier != null && modelBrierOnPaired != null ? marketBrier - modelBrierOnPaired : null;

  const reliability: ReliabilityBucket[] = [];
  for (let i = 0; i < 10; i++) {
    const lower = i / 10;
    const upper = (i + 1) / 10;
    const inBucket = rows.filter(
      (f) => f.predictedProb >= lower && (i === 9 ? f.predictedProb <= upper : f.predictedProb < upper)
    );
    if (inBucket.length === 0) continue;

    const hits = inBucket.filter((f) => f.resolvedOutcome === 1).length;
    const [ciLow, ciHigh] = wilson(hits, inBucket.length);
    reliability.push({
      lower,
      upper,
      count: inBucket.length,
      meanPredicted: inBucket.reduce((a, f) => a + f.predictedProb, 0) / inBucket.length,
      actualRate: hits / inBucket.length,
      ciLow,
      ciHigh,
    });
  }

  const sufficientData = rows.length >= MIN_FORECASTS_FOR_VERDICT;

  let verdict: string;
  if (!sufficientData) {
    verdict =
      `INSUFFICIENT DATA — ${rows.length} of ${MIN_FORECASTS_FOR_VERDICT} resolved forecasts. ` +
      `No conclusion can be drawn yet, in either direction.`;
  } else if (skill == null) {
    verdict = 'NO BENCHMARK — no market price was recorded alongside these forecasts.';
  } else if (skill > 0) {
    verdict =
      `MODEL BEATS MARKET by ${skill.toFixed(4)} Brier over ${paired.length} paired forecasts. ` +
      `This is the precondition for an edge — it does not by itself mean the edge survives costs.`;
  } else {
    verdict =
      `NO SKILL — the model's Brier is ${Math.abs(skill).toFixed(4)} worse than the market's. ` +
      `Trading on it is expected to lose money regardless of position sizing.`;
  }

  return {
    modelName,
    resolvedCount: rows.length,
    modelBrier: brier(modelPairs),
    marketBrier,
    skill,
    reliability,
    sufficientData,
    verdict,
  };
}

/**
 * Fits a multiplicative correction to forecast spread from resolved forecasts.
 *
 * If the model's stated probabilities are systematically too extreme, its
 * assumed forecast error is too narrow and sigma should widen (and vice versa).
 * Returns a factor to scale sigma by, or null when there is too little data to
 * prefer it over the assumption already in use.
 */
export function fitSigmaScale(
  forecasts: ScoredForecast[],
  minSamples = 50
): { scale: number; samples: number } | null {
  const rows = forecasts.filter((f) => f.predictedProb > 0.02 && f.predictedProb < 0.98);
  if (rows.length < minSamples) return null;

  // Compare mean predicted probability to realised frequency. Predicting higher
  // than reality means overconfidence, which a wider sigma corrects.
  const meanPredicted = rows.reduce((a, f) => a + f.predictedProb, 0) / rows.length;
  const actualRate = rows.filter((f) => f.resolvedOutcome === 1).length / rows.length;
  if (actualRate <= 0 || meanPredicted <= 0) return null;

  const ratio = meanPredicted / actualRate;
  // Clamp hard: this is a correction, not a free parameter, and a wild value
  // here would silently reshape every probability the model produces.
  const scale = Math.min(2, Math.max(0.5, ratio));

  return { scale, samples: rows.length };
}
