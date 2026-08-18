/**
 * track-record — reads the paper ledger and reports whether the system is
 * actually finding edge, rather than whether it happened to win.
 *
 * Run with: npm run track-record
 *
 * P&L alone is a bad early signal. Twenty trades of coin-flipping produce a
 * profit about a third of the time, so a positive number after a short run
 * says almost nothing. Calibration says more, sooner: when the model claims a
 * bucket has a 40% chance, does it land 40% of the time? A well-calibrated
 * model that is merely unlucky is worth keeping. A profitable but badly
 * calibrated one is a coin flip that has not landed yet.
 */

import { Database } from '../core/ledger/Database';

const h1 = (s: string) => console.log(`\n─── ${s} ${'─'.repeat(Math.max(0, 62 - s.length))}`);
const usd = (n: number) => `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`;
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

interface Scored {
  strategy: string;
  won: boolean;
  realizedPnl: number;
  costUsdc: number;
  entryPrice: number;
  midPrice: number | null;
  slippage: number | null;
  feePaid: number | null;
  /** The strategy's own probability estimate, when it recorded one. */
  modelProb: number | null;
}

/**
 * Wilson score interval — a normal approximation collapses to a zero-width
 * band at 0% or 100%, which is exactly where a small sample lands.
 */
function wilson(successes: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 1];
  const p = successes / n;
  const d = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (centre - margin) / d), Math.min(1, (centre + margin) / d)];
}

function main(): void {
  const db = new Database();
  db.initialize();

  const allRows = db.getResolvedPositionsWithSignals();

  // Positions opened before schema v3 were filled at mid with no spread or fee.
  // Mixing them in would flatter the record with trades that could not have
  // been executed at the prices recorded, so they are reported and excluded.
  const includeLegacy = process.argv.includes('--all');
  const rows = includeLegacy ? allRows : allRows.filter((r) => r.costUsdc != null);
  const legacyCount = allRows.length - allRows.filter((r) => r.costUsdc != null).length;

  console.log('═══ polygon.market — paper track record ═══');

  if (legacyCount > 0 && includeLegacy) {
    console.log(`\nIncluding ${legacyCount} pre-v3 position(s) filled at mid price (--all).`);
    console.log('Their P&L is optimistic — no spread or fee was charged.');
  } else if (legacyCount > 0) {
    const legacyPnl = allRows
      .filter((r) => r.costUsdc == null)
      .reduce((a, r) => a + (r.realizedPnl ?? 0), 0);
    console.log(
      `\nExcluding ${legacyCount} position(s) from before the honest fill model ` +
        `(${usd(legacyPnl)} P&L).`
    );
    console.log('Those filled at mid price with no spread or fee, so they are not');
    console.log('evidence either way. Run `npm run track-record -- --all` to include them.');
  }

  if (rows.length === 0) {
    console.log('\nNo resolved positions yet.');
    console.log('Positions appear here once their market closes and PositionResolver');
    console.log('marks them. Weather markets resolve daily, so expect the first');
    console.log('entries within a day or two of starting the bot.');
    db.close();
    return;
  }

  const scored: Scored[] = rows.map((r) => {
    let modelProb: number | null = null;
    try {
      const sig = r.externalSignal ? JSON.parse(r.externalSignal) : null;
      if (sig && typeof sig.modelProb === 'number') modelProb = sig.modelProb;
    } catch {
      // A malformed signal blob costs us calibration for this row only.
    }
    return {
      strategy: r.strategy ?? 'UNKNOWN',
      won: (r.realizedPnl ?? 0) > 0,
      realizedPnl: r.realizedPnl ?? 0,
      costUsdc: r.costUsdc ?? 0,
      entryPrice: r.entryPrice,
      midPrice: r.midPrice,
      slippage: r.slippage,
      feePaid: r.feePaid,
      modelProb,
    };
  });

  // ── Results by strategy ───────────────────────────────────────────────────
  h1('Results by strategy');
  console.log('  strategy          n    wins   win rate   P&L        ROI');
  console.log('  ' + '─'.repeat(60));

  const byStrategy = new Map<string, Scored[]>();
  for (const s of scored) {
    byStrategy.set(s.strategy, [...(byStrategy.get(s.strategy) ?? []), s]);
  }

  for (const [strategy, list] of [...byStrategy.entries()].sort()) {
    const wins = list.filter((s) => s.won).length;
    const pnl = list.reduce((a, s) => a + s.realizedPnl, 0);
    const deployed = list.reduce((a, s) => a + s.costUsdc, 0);
    const roi = deployed > 0 ? pnl / deployed : 0;
    console.log(
      `  ${strategy.padEnd(16)} ${String(list.length).padStart(3)}  ${String(wins).padStart(4)}   ` +
        `${pct(wins / list.length).padStart(7)}   ${usd(pnl).padStart(8)}  ${pct(roi).padStart(7)}`
    );
  }

  const totalPnl = scored.reduce((a, s) => a + s.realizedPnl, 0);
  const totalDeployed = scored.reduce((a, s) => a + s.costUsdc, 0);
  console.log('  ' + '─'.repeat(60));
  console.log(
    `  ${'TOTAL'.padEnd(16)} ${String(scored.length).padStart(3)}  ` +
      `${String(scored.filter((s) => s.won).length).padStart(4)}   ` +
      `${pct(scored.filter((s) => s.won).length / scored.length).padStart(7)}   ` +
      `${usd(totalPnl).padStart(8)}  ` +
      `${pct(totalDeployed > 0 ? totalPnl / totalDeployed : 0).padStart(7)}`
  );

  // ── Calibration ───────────────────────────────────────────────────────────
  h1('Calibration — is the model honest about its own odds?');

  const calibrated = scored.filter((s) => s.modelProb !== null);
  if (calibrated.length === 0) {
    console.log('  No positions carry a model probability yet.');
    console.log('  Only WEATHER records one; other strategies are scored on P&L alone.');
  } else {
    const bins = [
      { lo: 0.0, hi: 0.2 },
      { lo: 0.2, hi: 0.4 },
      { lo: 0.4, hi: 0.6 },
      { lo: 0.6, hi: 0.8 },
      { lo: 0.8, hi: 1.0 },
    ];

    console.log('  predicted     n    predicted   actual    95% CI on actual');
    console.log('  ' + '─'.repeat(62));

    for (const bin of bins) {
      const inBin = calibrated.filter((s) => s.modelProb! >= bin.lo && s.modelProb! < bin.hi);
      if (inBin.length === 0) continue;

      const wins = inBin.filter((s) => s.won).length;
      const meanPred = inBin.reduce((a, s) => a + s.modelProb!, 0) / inBin.length;
      const [lo, hi] = wilson(wins, inBin.length);
      const off = meanPred < lo || meanPred > hi;

      console.log(
        `  ${`${pct(bin.lo)}-${pct(bin.hi)}`.padEnd(12)} ${String(inBin.length).padStart(3)}  ` +
          `${pct(meanPred).padStart(8)}   ${pct(wins / inBin.length).padStart(7)}   ` +
          `[${pct(lo)}, ${pct(hi)}]${off ? '  ← outside CI' : ''}`
      );
    }

    // Brier score: mean squared error of the probability estimates. 0 is
    // perfect, 0.25 is what always guessing 50% gets you.
    const brier =
      calibrated.reduce((a, s) => a + Math.pow(s.modelProb! - (s.won ? 1 : 0), 2), 0) /
      calibrated.length;
    console.log(`\n  Brier score: ${brier.toFixed(4)}  (0 = perfect, 0.25 = no better than a coin)`);
  }

  // ── Cost drag ─────────────────────────────────────────────────────────────
  h1('What execution cost');

  const withMid = scored.filter((s) => s.midPrice !== null && s.midPrice > 0);
  if (withMid.length > 0) {
    const totalFees = scored.reduce((a, s) => a + (s.feePaid ?? 0), 0);
    const avgSlip = scored.reduce((a, s) => a + (s.slippage ?? 0), 0) / scored.length;
    const avgOverMid =
      withMid.reduce((a, s) => a + (s.entryPrice - s.midPrice!) / s.midPrice!, 0) / withMid.length;

    console.log(`  Fees paid:                      ${usd(totalFees)}`);
    console.log(`  Mean slippage past best ask:    ${avgSlip.toFixed(4)}`);
    console.log(`  Mean entry premium over mid:    ${pct(avgOverMid)}`);
    console.log(
      `\n  A mid-price fill model would have reported roughly ` +
        `${usd(totalDeployed * avgOverMid + totalFees)} more profit`
    );
    console.log('  than these trades would really have made.');
  } else {
    console.log('  No fill detail recorded — these positions predate the honest fill model.');
  }

  // ── Verdict ───────────────────────────────────────────────────────────────
  h1('Verdict');

  const n = scored.length;
  const wins = scored.filter((s) => s.won).length;
  const [lo, hi] = wilson(wins, n);

  console.log(`  Sample size: ${n} resolved positions`);
  console.log(`  Win rate: ${pct(wins / n)}, 95% CI [${pct(lo)}, ${pct(hi)}]`);

  if (n < 30) {
    console.log('\n  Too few trades to conclude anything. The confidence interval above');
    console.log('  is wide enough to contain both "genuine edge" and "pure luck".');
    console.log('  Keep it running — aim for 100+ resolved positions.');
  } else if (totalPnl > 0 && totalDeployed > 0 && totalPnl / totalDeployed > 0.02) {
    console.log('\n  Positive after realistic fill costs. Check the calibration table');
    console.log('  above: if predicted and actual track closely, this is a real edge');
    console.log('  rather than a lucky streak.');
  } else if (totalPnl > 0) {
    console.log('\n  Marginally positive — thin enough that execution costs could erase it.');
  } else {
    console.log('\n  Negative after realistic fill costs. Before changing strategy, check');
    console.log('  whether calibration is off (the model is wrong) or calibration is fine');
    console.log('  but costs ate the edge (the trades are too small to clear the spread).');
  }

  db.close();
}

main();
