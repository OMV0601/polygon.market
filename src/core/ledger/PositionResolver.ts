import { logger } from '../logger/logger';
import { Database } from './Database';
import { httpGet } from '../../lib/http';

interface GammaResolution {
  slug: string;
  closed: boolean;
  active: boolean;
  outcomes: unknown;
  outcomePrices: unknown;
}

const GAMMA = 'https://gamma-api.polymarket.com';
const PRICE_UPDATE_INTERVAL_MS = 15 * 60 * 1000; // 15 min

export class PositionResolver {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly db: Database) {}

  start(): void {
    if (this.timer) return;
    // Run immediately, then every 15 min
    void this.run();
    this.timer = setInterval(() => void this.run(), PRICE_UPDATE_INTERVAL_MS);
    logger.info('PositionResolver: started', { intervalMs: PRICE_UPDATE_INTERVAL_MS });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async run(): Promise<void> {
    // Forecasts are scored first and independently of positions. Most forecasts
    // never become trades, and those are the ones that keep the calibration
    // sample honest — restricting scoring to markets we hold would measure the
    // entry threshold instead of the model.
    const forecastsScoredStandalone = await this.resolveOutstandingForecasts();

    const positions = this.db.getOpenSimulatedPositions();
    if (positions.length === 0) {
      logger.debug('PositionResolver: no open positions', { forecastsScoredStandalone });
      return;
    }

    // Group positions by slug so we only fetch each market once
    const bySlug = new Map<string, typeof positions>();
    for (const p of positions) {
      const list = bySlug.get(p.marketSlug) ?? [];
      list.push(p);
      bySlug.set(p.marketSlug, list);
    }

    logger.info('PositionResolver: checking markets', {
      uniqueMarkets: bySlug.size,
      totalPositions: positions.length,
    });

    let resolved = 0;
    let pricesUpdated = 0;
    let forecastsScored = forecastsScoredStandalone;

    for (const [slug, slugPositions] of bySlug) {
      try {
        const market = await this.fetchMarket(slug);
        if (!market) continue;

        const outcomes = parseArr(market.outcomes, ['Yes', 'No']);
        const prices   = parseArr(market.outcomePrices, ['0.5', '0.5']).map(parseFloat);

        if (market.closed) {
          // Winner = outcome with highest price (should be ~1.0)
          let winIdx = 0;
          for (let i = 1; i < prices.length; i++) {
            if (prices[i] > prices[winIdx]) winIdx = i;
          }
          const winnerLabel = (outcomes[winIdx] ?? '').toLowerCase();

          // Score the forecast whether or not it was ever traded. This is the
          // half of the loop that turns a resolution into evidence about the
          // model rather than just a P&L line.
          const scored = this.db.resolveForecasts(slug, winnerLabel === 'yes' ? 1 : 0);
          if (scored > 0) forecastsScored += scored;

          for (const pos of slugPositions) {
            const isWin = pos.outcome.toLowerCase() === winnerLabel;
            const exitPrice   = isWin ? 1.0 : 0.0;
            const realizedPnl = (exitPrice - pos.entryPrice) * pos.shares;
            this.db.closePosition(pos.id, exitPrice, realizedPnl);
            resolved++;
          }

          logger.info('PositionResolver: market resolved', {
            slug,
            winner: winnerLabel,
            closed: slugPositions.length,
            pnl: slugPositions
              .map((p) => {
                const win = p.outcome.toLowerCase() === winnerLabel;
                return ((win ? 1.0 : 0.0) - p.entryPrice) * p.shares;
              })
              .reduce((a, b) => a + b, 0)
              .toFixed(4),
          });
        } else {
          // Market still open — refresh current price for unrealized PnL
          for (const pos of slugPositions) {
            const outcomeIdx = outcomes.findIndex(
              (o) => o.toLowerCase() === pos.outcome.toLowerCase()
            );
            if (outcomeIdx >= 0 && prices[outcomeIdx] != null && !isNaN(prices[outcomeIdx])) {
              this.db.updatePositionPrice(pos.id, prices[outcomeIdx]);
              pricesUpdated++;
            }
          }
        }

        // Small delay to avoid hammering Gamma API
        await sleep(150);
      } catch (err) {
        logger.warn('PositionResolver: failed to check market', {
          slug,
          error: (err as Error).message,
        });
      }
    }

    if (resolved > 0 || pricesUpdated > 0 || forecastsScored > 0) {
      const summary = this.db.getPnlSummary();
      logger.info('PositionResolver: cycle complete', {
        resolved,
        pricesUpdated,
        forecastsScored,
        totalPnl: summary.totalPnl.toFixed(4),
        realizedPnl: summary.realizedPnl.toFixed(4),
        unrealizedPnl: summary.unrealizedPnl.toFixed(4),
        winRate: `${(summary.winRate * 100).toFixed(1)}%`,
        openCount: summary.openCount,
        closedCount: summary.closedCount,
      });
    } else {
      logger.debug('PositionResolver: cycle complete — no changes');
    }
  }

  /**
   * Walks markets that carry unresolved forecasts and records the outcome.
   * Returns how many forecasts were scored.
   */
  private async resolveOutstandingForecasts(): Promise<number> {
    const slugs = this.db.getUnresolvedForecastSlugs();
    if (slugs.length === 0) return 0;

    let scored = 0;
    let checked = 0;

    for (const slug of slugs) {
      try {
        const market = await this.fetchMarket(slug);
        checked++;
        if (!market?.closed) continue;

        const outcomes = parseArr(market.outcomes, ['Yes', 'No']);
        const prices = parseArr(market.outcomePrices, ['0.5', '0.5']).map(parseFloat);

        let winIdx = 0;
        for (let i = 1; i < prices.length; i++) {
          if (prices[i] > prices[winIdx]) winIdx = i;
        }
        const winner = (outcomes[winIdx] ?? '').toLowerCase();

        scored += this.db.resolveForecasts(slug, winner === 'yes' ? 1 : 0);
        await sleep(150);
      } catch (err) {
        logger.debug('PositionResolver: forecast resolution failed', {
          slug,
          error: (err as Error).message,
        });
      }
    }

    if (scored > 0) {
      const counts = this.db.getForecastCounts();
      logger.info('PositionResolver: forecasts scored', {
        scored,
        marketsChecked: checked,
        totalResolved: counts.resolved,
        stillPending: counts.pending,
      });
    }

    return scored;
  }

  private async fetchMarket(slug: string): Promise<GammaResolution | null> {
    const s = encodeURIComponent(slug);
    // The default Gamma query only returns ACTIVE markets. Once a market
    // resolves it disappears from that query and must be fetched with
    // closed=true. Try active first (price updates), then closed (resolution).
    const active = await httpGet<GammaResolution[]>(`${GAMMA}/markets?slug=${s}&limit=1`);
    if (active.data?.[0]) return active.data[0];

    const closed = await httpGet<GammaResolution[]>(`${GAMMA}/markets?slug=${s}&closed=true&limit=1`);
    return closed.data?.[0] ?? null;
  }
}

function parseArr(val: unknown, fallback: string[]): string[] {
  if (Array.isArray(val)) return val as string[];
  if (typeof val === 'string') {
    try { return JSON.parse(val) as string[]; } catch {}
  }
  return fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
