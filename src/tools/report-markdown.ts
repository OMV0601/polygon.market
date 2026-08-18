/**
 * Prints the daily summary as Markdown on stdout, for the scheduled job to
 * publish as a GitHub issue.
 *
 * This exists because SMTP is a second set of credentials that can rot
 * independently of the bot — a stray newline or a stale app password takes the
 * whole report offline while the trading itself is fine. Posting an issue uses
 * the token the workflow already has, and GitHub emails the repo owner anyway,
 * so the notification arrives without a password to maintain.
 */

import fs from 'fs';
import { Database } from '../core/ledger/Database';

const money = (v: number) => `${v >= 0 ? '+' : '−'}$${Math.abs(v).toFixed(2)}`;

// Written to a file rather than stdout: npm prints its own banner there and the
// logger writes to the console, both of which would land inside the report.
const OUT_PATH = process.argv[2] ?? 'report.md';

function main(): void {
  const db = new Database();
  db.initialize();

  const s = db.getPnlSummary();
  const opened = db.getPositionsOpenedToday();
  const closed = db.getPositionsClosedToday();
  const todayRealized = closed.reduce((a, p) => a + (p.realizedPnl ?? 0), 0);
  const date = new Date().toISOString().slice(0, 10);

  const out: string[] = [];

  out.push(`## polygon.market — ${date}`);
  out.push('');
  out.push('_Paper trading. No real money at any point._');
  out.push('');
  out.push('| | |');
  out.push('|---|---|');
  out.push(`| P&L, last 24h | **${money(todayRealized)}** |`);
  out.push(`| Total P&L | **${money(s.totalPnl)}** |`);
  out.push(`| Win rate | ${s.closedCount > 0 ? (s.winRate * 100).toFixed(0) + '%' : '—'} |`);
  out.push(`| Open positions | ${s.openCount} |`);
  out.push(`| Closed all-time | ${s.winCount}W / ${s.lossCount}L |`);
  out.push(`| Capital deployed | $${s.openExposure.toFixed(2)} |`);
  out.push('');

  out.push(`### Resolved in the last 24h (${closed.length})`);
  out.push('');
  if (closed.length === 0) {
    out.push('_Nothing resolved in the last 24 hours._');
  } else {
    out.push('| Market | Pick | Entry | Exit | P&L | |');
    out.push('|---|---|---|---|---|---|');
    for (const t of closed) {
      const pnl = t.realizedPnl ?? 0;
      out.push(
        `| \`${t.marketSlug}\` | ${t.outcome} | $${t.entryPrice.toFixed(2)} | ` +
          `${t.exitPrice != null ? '$' + t.exitPrice.toFixed(2) : '—'} | ` +
          `${money(pnl)} | ${pnl > 0 ? '✅' : '❌'} |`
      );
    }
  }
  out.push('');

  out.push(`### Opened in the last 24h (${opened.length})`);
  out.push('');
  if (opened.length === 0) {
    out.push('_No new positions in the last 24 hours._');
  } else {
    out.push('| Market | Pick | Entry | Stake |');
    out.push('|---|---|---|---|');
    for (const t of opened) {
      out.push(
        `| \`${t.marketSlug}\` | ${t.outcome} | $${t.entryPrice.toFixed(2)} | ` +
          `$${(t.shares * t.entryPrice).toFixed(2)} |`
      );
    }
  }
  out.push('');

  if (s.closedCount < 50) {
    out.push(
      `> Win rate is not meaningful yet — ${s.closedCount} closed of the ~50 needed ` +
        `to tell an edge from a streak. Run \`npm run track-record\` for calibration.`
    );
  }

  fs.writeFileSync(OUT_PATH, out.join('\n') + '\n', 'utf8');
  console.log(`Report written to ${OUT_PATH} (${out.length} lines)`);
  db.close();
}

main();
