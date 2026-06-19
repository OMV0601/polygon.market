import { BaseStrategy } from '../base/BaseStrategy';
import { env } from '../../config/env';
import { STRATEGY_INTERVALS, RISK } from '../../config/constants';
import { logger } from '../../core/logger/logger';
import { isLowQualityMarket } from '../../lib/markets';
import type { BullpenWalletTransaction } from '../../core/bullpen/types';
import type { CandidatePayload, Outcome, StrategyModule } from '../../core/risk/types';

export class WalletMirrorStrategy extends BaseStrategy {
  protected readonly name: StrategyModule = 'WALLET_MIRROR';
  protected readonly intervalMs = STRATEGY_INTERVALS.WALLET_MIRROR_MS;

  protected async scan(): Promise<CandidatePayload[]> {
    const wallets = env.TRACKED_WALLETS;
    if (wallets.length === 0) {
      logger.warn('WalletMirror: TRACKED_WALLETS not configured — skipping scan');
      return [];
    }

    const candidates: CandidatePayload[] = [];
    const since = new Date(Date.now() - this.intervalMs * 2);

    for (const address of wallets) {
      try {
        const txs = await this.bullpen.walletTransactions(address, since);
        const newBuys = this.filterUnseen(txs, address);

        for (const tx of newBuys) {
          const candidate = await this.buildCandidate(tx, address);
          if (candidate) candidates.push(candidate);
        }
      } catch (err) {
        logger.warn('WalletMirror: wallet fetch failed', {
          wallet: address.slice(0, 10) + '…',
          error: (err as Error).message,
        });
      }
    }

    // Pace deployment: act only on the highest-confidence signals each cycle so
    // a burst of smart-money activity can't empty the bankroll in one pass.
    candidates.sort((a, b) => b.confidenceScore - a.confidenceScore);
    const selected = candidates.slice(0, RISK.MAX_TRADES_PER_CYCLE);

    if (candidates.length > selected.length) {
      logger.info('WalletMirror: pacing — deferring lower-confidence signals', {
        observed: candidates.length,
        selected: selected.length,
        cap: RISK.MAX_TRADES_PER_CYCLE,
      });
    }

    return selected;
  }

  private filterUnseen(txs: BullpenWalletTransaction[], address: string): BullpenWalletTransaction[] {
    const seen = this.db.getSeenTxHashes(address);
    return txs
      .filter((tx) => tx.side === 'BUY' && tx.txHash && !seen.has(tx.txHash))
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  }

  private async buildCandidate(
    tx: BullpenWalletTransaction,
    address: string
  ): Promise<CandidatePayload | null> {
    // Persist the transaction so it's never re-evaluated, even if we skip it.
    this.db.insertWalletTx({
      walletAddress: address,
      walletAlias: this.alias(address),
      marketSlug: tx.marketSlug,
      outcome: tx.outcome,
      side: tx.side,
      fillPrice: tx.fillPrice,
      shareCount: tx.shareCount,
      totalCost: tx.totalCost,
      txHash: tx.txHash,
    });

    // ── Quality gate 1: market type ──────────────────────────────────────────
    // Skip crypto price markets and structural longshots (exact scores, halves).
    if (isLowQualityMarket(tx.marketSlug)) {
      logger.debug('WalletMirror: skipping low-quality market', { slug: tx.marketSlug });
      return null;
    }

    // ── Quality gate 2: smart-money conviction ───────────────────────────────
    // Only follow bets the wallet actually committed to — ignore dust trades.
    if (tx.totalCost < RISK.MIN_SMART_MONEY_CONVICTION_USDC) {
      logger.debug('WalletMirror: smart-money bet below conviction floor — skipping', {
        slug: tx.marketSlug,
        betUsdc: tx.totalCost.toFixed(2),
        floor: RISK.MIN_SMART_MONEY_CONVICTION_USDC,
      });
      return null;
    }

    let currentAsk: number;
    let spread: number;

    try {
      const book = await this.bullpen.orderBook(tx.marketSlug, tx.outcome);
      currentAsk = book.bestAsk;
      spread = book.bestAsk - book.bestBid;
    } catch {
      logger.warn('WalletMirror: orderbook unavailable, skipping candidate', { slug: tx.marketSlug });
      return null;
    }

    // ── Quality gate 3: probability band ─────────────────────────────────────
    // Skip lottery-ticket longshots and capital-inefficient near-certainties.
    if (currentAsk < RISK.MIN_IMPLIED_PROBABILITY || currentAsk > RISK.MAX_IMPLIED_PROBABILITY) {
      logger.debug('WalletMirror: outside probability band — skipping', {
        slug: tx.marketSlug,
        impliedProb: currentAsk.toFixed(3),
        band: `${RISK.MIN_IMPLIED_PROBABILITY}-${RISK.MAX_IMPLIED_PROBABILITY}`,
      });
      return null;
    }

    const delta = currentAsk - tx.fillPrice;

    if (delta > RISK.MAX_SMART_MONEY_PRICE_DELTA) {
      logger.info('WalletMirror: price moved too far since smart money fill — discarding', {
        slug: tx.marketSlug,
        fillPrice: tx.fillPrice,
        currentAsk,
        delta: delta.toFixed(4),
        max: RISK.MAX_SMART_MONEY_PRICE_DELTA,
      });
      return null;
    }

    if (spread > RISK.MAX_WALLET_MIRROR_SPREAD) {
      logger.info('WalletMirror: spread too wide — discarding', {
        slug: tx.marketSlug,
        spread: spread.toFixed(4),
        max: RISK.MAX_WALLET_MIRROR_SPREAD,
      });
      return null;
    }

    const confidenceScore = this.confidence(delta, spread, tx.totalCost);
    const suggestedSize = this.size(confidenceScore);

    return {
      strategyModule: 'WALLET_MIRROR',
      marketSlug: tx.marketSlug,
      outcome: tx.outcome as Outcome,
      impliedProbability: currentAsk,
      externalSignalData: {
        fillPrice: tx.fillPrice,
        currentAsk,
        delta,
        spread,
        smartMoneyBetUsdc: tx.totalCost,
        txHash: tx.txHash,
        txTimestamp: tx.timestamp,
        walletAlias: this.alias(address),
      },
      confidenceScore,
      suggestedSize,
      walletAlias: this.alias(address),
      priceDelta: delta,
    };
  }

  // Composite confidence in [0.1, 1]: how closely we can still follow the
  // smart-money fill (freshness), how tight the book is (tightness), and how
  // much conviction the wallet showed (size of their bet).
  private confidence(delta: number, spread: number, smartMoneyBetUsdc: number): number {
    const freshness  = 1 - clamp01(delta / RISK.MAX_SMART_MONEY_PRICE_DELTA);
    const tightness  = 1 - clamp01(spread / RISK.MAX_WALLET_MIRROR_SPREAD);
    const conviction = clamp01(smartMoneyBetUsdc / RISK.SMART_MONEY_CONVICTION_REF_USDC);

    const score = 0.5 * freshness + 0.2 * tightness + 0.3 * conviction;
    return Math.max(0.1, Math.min(1, score));
  }

  private alias(address: string): string {
    return `wallet_${address.replace(/^0x/i, '').slice(0, 6)}`;
  }

  // Size scales from a floor fraction of the per-trade cap up to the full cap as
  // confidence rises — so weak signals stake less and capital spreads further.
  private size(confidence: number): number {
    if (env.WALLET_BALANCE_USDC === 0) return 10;
    const maxPerTrade = (env.MAX_POSITION_SIZE_PCT / 100) * env.WALLET_BALANCE_USDC;
    const floor = maxPerTrade * RISK.WALLET_MIRROR_BASE_SIZE_FRACTION;
    const sized = floor + (maxPerTrade - floor) * confidence;
    return Math.round(sized * 100) / 100;
  }
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
