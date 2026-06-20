import nodemailer from 'nodemailer';
import { env } from '../../config/env';
import { logger } from '../logger/logger';
import { Database } from '../ledger/Database';

type PnlSummary = ReturnType<Database['getPnlSummary']>;
type OpenedRow = ReturnType<Database['getPositionsOpenedToday']>[number];
type ClosedRow = ReturnType<Database['getPositionsClosedToday']>[number];

// Sends a once-a-day email summarising the bot's paper-trading activity:
// today's new bets, today's resolved bets (win/loss), and running totals.
export class DailyReport {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly db: Database) {}

  start(): void {
    if (!this.configured()) {
      logger.warn('DailyReport: email not configured (SMTP_USER / SMTP_PASS missing) — skipping');
      return;
    }
    this.scheduleNext();
    logger.info('DailyReport: scheduled', {
      hourUtc: env.REPORT_HOUR_UTC,
      to: env.REPORT_EMAIL_TO || env.SMTP_USER,
    });
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private configured(): boolean {
    return Boolean(env.SMTP_USER && env.SMTP_PASS);
  }

  private scheduleNext(): void {
    const ms = msUntilHourUtc(env.REPORT_HOUR_UTC);
    this.timer = setTimeout(() => {
      void this.sendReport()
        .catch((err) => logger.error('DailyReport: send failed', { error: (err as Error).message }))
        .finally(() => this.scheduleNext());
    }, ms);
  }

  // Builds and sends the report immediately. Used by the scheduler and the
  // `npm run report` test command.
  async sendReport(): Promise<void> {
    if (!this.configured()) {
      throw new Error('Email not configured: set SMTP_USER and SMTP_PASS in .env');
    }

    const summary = this.db.getPnlSummary();
    const opened = this.db.getPositionsOpenedToday();
    const closed = this.db.getPositionsClosedToday();
    const todayRealized = closed.reduce((s, p) => s + (p.realizedPnl ?? 0), 0);

    const date = new Date().toISOString().slice(0, 10);
    const dir = todayRealized >= 0 ? '▲' : '▼';
    const subject =
      `polygon.market — ${date}: ${dir} $${Math.abs(todayRealized).toFixed(2)} today ` +
      `(total ${summary.totalPnl >= 0 ? '+' : '-'}$${Math.abs(summary.totalPnl).toFixed(2)})`;

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    });

    await transporter.sendMail({
      from: `polygon.market <${env.SMTP_USER}>`,
      to: env.REPORT_EMAIL_TO || env.SMTP_USER,
      subject,
      html: this.buildHtml(date, summary, opened, closed, todayRealized),
    });

    logger.info('DailyReport: sent', {
      to: env.REPORT_EMAIL_TO || env.SMTP_USER,
      newBets: opened.length,
      resolved: closed.length,
      todayRealized: todayRealized.toFixed(2),
    });
  }

  private buildHtml(
    date: string,
    s: PnlSummary,
    opened: OpenedRow[],
    closed: ClosedRow[],
    todayRealized: number
  ): string {
    const money = (v: number) => `${v >= 0 ? '+' : '-'}$${Math.abs(v).toFixed(2)}`;
    const color = (v: number) => (v > 0 ? '#1a7f37' : v < 0 ? '#cf222e' : '#57606a');

    const stat = (label: string, value: string, c = '#24292f') =>
      `<td style="padding:10px 14px;border:1px solid #d0d7de;">
         <div style="font-size:11px;color:#57606a;text-transform:uppercase;letter-spacing:.5px;">${label}</div>
         <div style="font-size:20px;font-weight:700;color:${c};">${value}</div>
       </td>`;

    const closedRows = closed.length
      ? closed.map((t) => {
          const pnl = t.realizedPnl ?? 0;
          const win = pnl > 0;
          return `<tr>
            <td style="padding:6px 10px;border-bottom:1px solid #eaeef2;font-family:monospace;font-size:12px;">${t.marketSlug}</td>
            <td style="padding:6px 10px;border-bottom:1px solid #eaeef2;">${t.outcome}</td>
            <td style="padding:6px 10px;border-bottom:1px solid #eaeef2;">$${t.entryPrice.toFixed(2)}</td>
            <td style="padding:6px 10px;border-bottom:1px solid #eaeef2;">${t.exitPrice != null ? '$' + t.exitPrice.toFixed(2) : '—'}</td>
            <td style="padding:6px 10px;border-bottom:1px solid #eaeef2;font-weight:700;color:${color(pnl)};">${money(pnl)}</td>
            <td style="padding:6px 10px;border-bottom:1px solid #eaeef2;font-weight:700;color:${win ? '#1a7f37' : '#cf222e'};">${win ? 'WIN' : 'LOSS'}</td>
          </tr>`;
        }).join('')
      : `<tr><td colspan="6" style="padding:12px;color:#57606a;font-style:italic;">No bets resolved today.</td></tr>`;

    const openedRows = opened.length
      ? opened.map((t) => `<tr>
            <td style="padding:6px 10px;border-bottom:1px solid #eaeef2;font-family:monospace;font-size:12px;">${t.marketSlug}</td>
            <td style="padding:6px 10px;border-bottom:1px solid #eaeef2;">${t.outcome}</td>
            <td style="padding:6px 10px;border-bottom:1px solid #eaeef2;">$${t.entryPrice.toFixed(2)}</td>
            <td style="padding:6px 10px;border-bottom:1px solid #eaeef2;">$${(t.shares * t.entryPrice).toFixed(2)}</td>
          </tr>`).join('')
      : `<tr><td colspan="4" style="padding:12px;color:#57606a;font-style:italic;">No new bets placed today.</td></tr>`;

    return `
    <div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:680px;margin:0 auto;color:#24292f;">
      <h2 style="margin:0 0 4px;">polygon.market — Daily Summary</h2>
      <div style="color:#57606a;margin-bottom:18px;">${date} · paper trading (no real money)</div>

      <table style="border-collapse:collapse;margin-bottom:8px;"><tr>
        ${stat("Today's P&L", money(todayRealized), color(todayRealized))}
        ${stat('Total P&L', money(s.totalPnl), color(s.totalPnl))}
        ${stat('Win Rate', s.closedCount > 0 ? (s.winRate * 100).toFixed(0) + '%' : '—')}
      </tr><tr>
        ${stat('Open Positions', String(s.openCount))}
        ${stat('Closed (all-time)', `${s.winCount}W / ${s.lossCount}L`)}
        ${stat('Capital Deployed', `$${s.openExposure.toFixed(2)}`)}
      </tr></table>

      <h3 style="margin:22px 0 8px;">Bets resolved today (${closed.length})</h3>
      <table style="border-collapse:collapse;width:100%;font-size:13px;">
        <tr style="background:#f6f8fa;text-align:left;">
          <th style="padding:6px 10px;">Market</th><th style="padding:6px 10px;">Pick</th>
          <th style="padding:6px 10px;">Entry</th><th style="padding:6px 10px;">Exit</th>
          <th style="padding:6px 10px;">P&L</th><th style="padding:6px 10px;">Result</th>
        </tr>
        ${closedRows}
      </table>

      <h3 style="margin:22px 0 8px;">New bets placed today (${opened.length})</h3>
      <table style="border-collapse:collapse;width:100%;font-size:13px;">
        <tr style="background:#f6f8fa;text-align:left;">
          <th style="padding:6px 10px;">Market</th><th style="padding:6px 10px;">Pick</th>
          <th style="padding:6px 10px;">Entry</th><th style="padding:6px 10px;">Stake</th>
        </tr>
        ${openedRows}
      </table>

      <p style="color:#8b949e;font-size:12px;margin-top:24px;">
        Automated summary from your polygon.market bot. Win rate only becomes meaningful after ~50 closed trades.
      </p>
    </div>`;
  }
}

// Milliseconds from now until the next occurrence of the given UTC hour.
function msUntilHourUtc(hour: number): number {
  const now = new Date();
  const next = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, 0, 0, 0
  ));
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}
