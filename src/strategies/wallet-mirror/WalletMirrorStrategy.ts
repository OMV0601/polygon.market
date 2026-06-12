import { BaseStrategy } from '../base/BaseStrategy';
import { env } from '../../config/env';
import { STRATEGY_INTERVALS, RISK } from '../../config/constants';
import { logger } from '../../core/logger/logger';
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

    return candidates;
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
    // Persist the transaction so it's never re-evaluated
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

    // Skip crypto price markets — we only want prediction/event markets
    if (/^(btc|eth|sol|matic|bnb|xrp|doge|crypto)-/i.test(tx.marketSlug)) {
      logger.debug('WalletMirror: skipping crypto market', { slug: tx.marketSlug });
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

    // Confidence scales inversely with delta — tighter fill = higher confidence
    const confidenceScore = Math.max(0.1, 1 - delta / RISK.MAX_SMART_MONEY_PRICE_DELTA);
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

  private alias(address: string): string {
    return `wallet_${address.replace(/^0x/i, '').slice(0, 6)}`;
  }

  private size(confidence: number): number {
    if (env.WALLET_BALANCE_USDC === 0) return 10;
    const base = (env.MAX_POSITION_SIZE_PCT / 100) * env.WALLET_BALANCE_USDC;
    return Math.round(base * confidence * 100) / 100;
  }
}
