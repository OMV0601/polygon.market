/**
 * calibration — answers the only question that matters before risking money:
 * is the model's probability better than the price it would trade against?
 *
 * Run with: npm run calibration
 *
 * P&L cannot settle this at small samples. A model with no skill wins for weeks
 * at a time, and a model with real skill loses for just as long. Brier score
 * uses every forecast rather than the handful that became trades, and the
 * market's own price provides a benchmark on identical questions.
 */

import { Database } from '../core/ledger/Database';
import {
  MIN_FORECASTS_FOR_VERDICT,
  calibrate,
  fitSigmaScale,
} from '../core/calibration/CalibrationReport';

const h1 = (s: string) => console.log(`\n─── ${s} ${'─'.repeat(Math.max(0, 58 - s.length))}`);
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

function main(): void {
  const db = new Database();
  db.initialize();

  console.log('═══ polygon.market — model calibration ═══');

  const counts = db.getForecastCounts();
  console.log(
    `\nForecasts logged: ${counts.total}   resolved: ${counts.resolved}   pending: ${counts.pending}`
  );

  const all = db.getResolvedForecasts();
  if (all.length === 0) {
    console.log('\nNo resolved forecasts yet.');
    console.log('Forecasts are logged every scan cycle and scored when their market');
    console.log('settles. Temperature markets resolve daily, so the first scores');
    console.log('appear within a day or two.');
    db.close();
    return;
  }

  const models = [...new Set(all.map((f) => f.modelName))];

  for (const model of models) {
    const c = calibrate(all, model);

    h1(`${c.modelName}`);
    console.log(`Resolved forecasts: ${c.resolvedCount}`);
    console.log(`Model Brier:        ${c.modelBrier.toFixed(4)}   (0 = perfect, 0.25 = coin flip)`);
    console.log(
      `Market Brier:       ${c.marketBrier != null ? c.marketBrier.toFixed(4) : 'n/a'}` +
        `   (the price at the moment we forecast)`
    );
    if (c.skill != null) {
      const sign = c.skill > 0 ? '+' : '';
      console.log(`Skill:              ${sign}${c.skill.toFixed(4)}   (positive = model beats market)`);
    }

    if (c.reliability.length > 0) {
      console.log('\n  Reliability — does a 30% forecast happen 30% of the time?');
      console.log('  predicted      n     said    happened   95% CI');
      console.log('  ' + '─'.repeat(58));
      for (const b of c.reliability) {
        const off = b.meanPredicted < b.ciLow || b.meanPredicted > b.ciHigh;
        console.log(
          `  ${`${pct(b.lower)}-${pct(b.upper)}`.padEnd(12)} ${String(b.count).padStart(4)}  ` +
            `${pct(b.meanPredicted).padStart(6)}   ${pct(b.actualRate).padStart(7)}    ` +
            `[${pct(b.ciLow)}, ${pct(b.ciHigh)}]${off ? '  ← miscalibrated' : ''}`
        );
      }
    }

    const fit = fitSigmaScale(all.filter((f) => f.modelName === model));
    if (fit) {
      const direction = fit.scale > 1 ? 'overconfident — widening' : 'underconfident — narrowing';
      console.log(
        `\n  Fitted sigma scale: ${fit.scale.toFixed(3)} from ${fit.samples} samples (${direction})`
      );
    } else {
      console.log(`\n  Fitted sigma scale: not yet — needs 50+ resolved forecasts, using the prior`);
    }

    console.log(`\n  ${c.verdict}`);
  }

  h1('Go-live gate');
  const primary = calibrate(all, models[0]);
  const checks: Array<[string, boolean, string]> = [
    [
      `${MIN_FORECASTS_FOR_VERDICT}+ resolved forecasts`,
      primary.resolvedCount >= MIN_FORECASTS_FOR_VERDICT,
      `${primary.resolvedCount} so far`,
    ],
    [
      'model Brier beats market Brier',
      primary.skill != null && primary.skill > 0,
      primary.skill != null ? `skill ${primary.skill.toFixed(4)}` : 'no benchmark recorded',
    ],
  ];

  for (const [label, ok, detail] of checks) {
    console.log(`  ${ok ? '✔' : '✗'} ${label.padEnd(38)} ${detail}`);
  }

  const passed = checks.every(([, ok]) => ok);
  console.log(
    passed
      ? '\n  Both gates pass. Net edge after real fees is the remaining question —\n' +
          '  see `npm run track-record` for what execution actually cost.'
      : '\n  Gate not met. No amount of position sizing fixes a model without skill.'
  );

  db.close();
}

main();
