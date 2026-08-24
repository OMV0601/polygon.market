import { env } from '../../config/env';
import { RISK } from '../../config/constants';
import { logger } from '../logger/logger';
import { eventKey } from '../../lib/markets';
import { PolymarketClient } from '../polymarket/PolymarketClient';
import { Database } from '../ledger/Database';
import type {
  CandidatePayload,
  CheckResult,
  ExecutionMode,
  RejectionReason,
  RiskDecision,
} from './types';

export class RiskManager {
  constructor(
    private readonly db: Database,
    private readonly bullpen: PolymarketClient
  ) {}

  // ── Entry point ────────────────────────────────────────────────────────────

  async evaluate(candidate: CandidatePayload): Promise<RiskDecision> {
    const warnings: string[] = [];

    logger.info('RiskManager: evaluating candidate', {
      strategy: candidate.strategyModule,
      slug: candidate.marketSlug,
      outcome: candidate.outcome,
      suggestedSize: candidate.suggestedSize,
    });

    // Checks run in order — first failure short-circuits and logs a rejection.
    const checks: Array<() => Promise<CheckResult> | CheckResult> = [
      () => this.checkSpread(candidate),
      () => this.checkLiquidity(candidate),
      () => this.checkVolume(candidate),
      () => this.checkExposureLimit(candidate),
      () => this.checkDailyDeploymentLimit(candidate),
      () => this.checkEventConcentration(candidate),
      () => this.checkDailyLossLimit(),
      () => this.checkDuplicatePosition(candidate),
    ];

    for (const check of checks) {
      const result = await check();
      if (result.warning) warnings.push(result.warning);

      if (!result.passed) {
        return this.buildRejection(candidate, result.detail ?? 'Check failed', warnings);
      }
    }

    const executionMode = this.resolveExecutionMode();
    const decision: RiskDecision = {
      approved: true,
      warnings,
      executionMode,
      checkedAt: new Date(),
    };

    this.auditApproval(candidate);

    logger.info('RiskManager: candidate approved', {
      slug: candidate.marketSlug,
      executionMode,
      warnings: warnings.length,
    });

    return decision;
  }

  // ── Individual checks ──────────────────────────────────────────────────────

  private async checkSpread(candidate: CandidatePayload): Promise<CheckResult> {
    try {
      const book = await this.bullpen.orderBook(candidate.marketSlug, candidate.outcome);
      const spread = book.bestAsk - book.bestBid;

      if (spread > env.SPREAD_CEILING) {
        return {
          passed: false,
          detail: `Spread ${spread.toFixed(4)} exceeds ceiling ${env.SPREAD_CEILING} on ${candidate.marketSlug}`,
        };
      }

      if (spread > env.SPREAD_CEILING * 0.8) {
        return {
          passed: true,
          warning: `Spread ${spread.toFixed(4)} is approaching the ceiling (${(spread / env.SPREAD_CEILING * 100).toFixed(0)}%)`,
        };
      }

      return { passed: true };
    } catch (err) {
      // Order book fetch failure is non-fatal for the spread check specifically,
      // but we warn loudly so the operator knows data quality is degraded.
      logger.warn('RiskManager: spread check skipped — orderbook fetch failed', {
        slug: candidate.marketSlug,
        error: (err as Error).message,
      });
      return {
        passed: true,
        warning: `Spread check skipped: orderbook unavailable for ${candidate.marketSlug}`,
      };
    }
  }

  private async checkLiquidity(candidate: CandidatePayload): Promise<CheckResult> {
    const requiredLiquidity = candidate.suggestedSize * env.LIQUIDITY_MULTIPLIER;

    try {
      const book = await this.bullpen.orderBook(candidate.marketSlug, candidate.outcome);
      const availableLiquidity = book.asks.reduce((sum, level) => sum + level.size * level.price, 0);

      if (availableLiquidity < requiredLiquidity) {
        return {
          passed: false,
          detail:
            `Insufficient liquidity: need ${requiredLiquidity.toFixed(2)} USDC (${env.LIQUIDITY_MULTIPLIER}x), ` +
            `found ${availableLiquidity.toFixed(2)} USDC on ${candidate.marketSlug}`,
        };
      }

      return { passed: true };
    } catch (err) {
      logger.warn('RiskManager: liquidity check skipped — orderbook fetch failed', {
        slug: candidate.marketSlug,
        error: (err as Error).message,
      });
      return {
        passed: true,
        warning: `Liquidity check skipped: orderbook unavailable for ${candidate.marketSlug}`,
      };
    }
  }

  private checkVolume(candidate: CandidatePayload): CheckResult {
    // Candidates should populate externalSignalData.volume24h from the discovery scan.
    const volume = candidate.externalSignalData?.volume24h as number | undefined;
    const floor = this.volumeFloorFor(candidate.strategyModule);

    if (volume != null && volume < floor) {
      return {
        passed: false,
        detail: `24h volume ${volume.toFixed(0)} USDC is below minimum ${floor} USDC`,
      };
    }

    return { passed: true };
  }

  /**
   * The $10k floor exists so wallet-mirror only copies trades in markets deep
   * enough that a whale's fill isn't the whole book. Temperature markets run a
   * median of about $3k a day and every one of them clears $1k, so applying the
   * wallet-mirror floor to them rejected every weather candidate. Depth at our
   * position sizes is checked separately by checkLiquidity.
   */
  private volumeFloorFor(strategy: string): number {
    return strategy === 'WEATHER'
      ? RISK.WEATHER_MIN_VOLUME_24H_USDC
      : RISK.MIN_VOLUME_24H_USDC;
  }

  private checkExposureLimit(candidate: CandidatePayload): CheckResult {
    // WALLET_BALANCE_USDC=0 means the user hasn't configured their balance yet.
    // Skip the check and warn rather than incorrectly blocking every trade.
    if (env.WALLET_BALANCE_USDC === 0) {
      return {
        passed: true,
        warning: 'Exposure check skipped: set WALLET_BALANCE_USDC in .env to enable it',
      };
    }

    const maxSingleTrade = (env.MAX_POSITION_SIZE_PCT / 100) * env.WALLET_BALANCE_USDC;

    if (candidate.suggestedSize > maxSingleTrade) {
      return {
        passed: false,
        detail:
          `Proposed size ${candidate.suggestedSize.toFixed(2)} USDC exceeds ` +
          `${env.MAX_POSITION_SIZE_PCT}% of wallet balance ${env.WALLET_BALANCE_USDC} USDC ` +
          `(max per trade: ${maxSingleTrade.toFixed(2)} USDC)`,
      };
    }

    // Total portfolio cap: never let open exposure exceed the full bankroll
    const totalOpenExposure = this.db.getTotalOpenExposureUsdc();
    if (totalOpenExposure + candidate.suggestedSize > env.WALLET_BALANCE_USDC) {
      return {
        passed: false,
        detail:
          `Portfolio fully deployed: ${totalOpenExposure.toFixed(2)} USDC open + ` +
          `${candidate.suggestedSize.toFixed(2)} USDC proposed exceeds bankroll ` +
          `${env.WALLET_BALANCE_USDC} USDC`,
      };
    }

    return { passed: true };
  }

  // Drip-feed control: caps how much new capital can be deployed per day so the
  // bot can't empty the bankroll in a single burst.
  private checkDailyDeploymentLimit(candidate: CandidatePayload): CheckResult {
    if (env.MAX_DAILY_DEPLOYMENT_USDC === 0) return { passed: true };

    const deployedToday = this.db.getDailyDeployedUsdc();

    if (deployedToday + candidate.suggestedSize > env.MAX_DAILY_DEPLOYMENT_USDC) {
      return {
        passed: false,
        detail:
          `Daily deployment limit reached: ${deployedToday.toFixed(2)} USDC already deployed today + ` +
          `${candidate.suggestedSize.toFixed(2)} USDC proposed exceeds daily cap ` +
          `${env.MAX_DAILY_DEPLOYMENT_USDC} USDC. Resets at 00:00 UTC.`,
      };
    }

    if (deployedToday > env.MAX_DAILY_DEPLOYMENT_USDC * 0.8) {
      return {
        passed: true,
        warning: `Daily deployment at ${((deployedToday / env.MAX_DAILY_DEPLOYMENT_USDC) * 100).toFixed(0)}% of the ${env.MAX_DAILY_DEPLOYMENT_USDC} USDC cap`,
      };
    }

    return { passed: true };
  }

  // Caps how much capital can sit on any single underlying event (e.g. all the
  // different bets on one match). Prevents the bankroll from concentrating into
  // a handful of correlated markets.
  private checkEventConcentration(candidate: CandidatePayload): CheckResult {
    if (env.WALLET_BALANCE_USDC === 0) return { passed: true };

    const key = eventKey(candidate.marketSlug);
    const eventExposure = this.db.getOpenExposureByEventPrefix(key);
    const maxEventExposure = (RISK.MAX_EVENT_EXPOSURE_PCT / 100) * env.WALLET_BALANCE_USDC;

    if (eventExposure + candidate.suggestedSize > maxEventExposure) {
      return {
        passed: false,
        detail:
          `Event concentration limit: ${eventExposure.toFixed(2)} USDC already open on ` +
          `'${key}' + ${candidate.suggestedSize.toFixed(2)} USDC proposed exceeds ` +
          `${RISK.MAX_EVENT_EXPOSURE_PCT}% cap (${maxEventExposure.toFixed(2)} USDC)`,
      };
    }

    if (eventExposure > maxEventExposure * 0.7) {
      return {
        passed: true,
        warning: `Event '${key}' at ${((eventExposure / maxEventExposure) * 100).toFixed(0)}% of its concentration cap`,
      };
    }

    return { passed: true };
  }

  private checkDailyLossLimit(): CheckResult {
    const dailyPnl = this.db.getDailyRealizedPnl();

    if (dailyPnl < 0) {
      // The denominator must be a fixed base. Using open exposure meant it
      // shrank every time a losing position closed — the same event that grows
      // the numerator — so one bad day could report a 3000% drawdown and
      // freeze the bot permanently.
      if (env.WALLET_BALANCE_USDC <= 0) {
        return {
          passed: true,
          warning:
            'Daily loss limit skipped: set WALLET_BALANCE_USDC in .env to give drawdown a denominator',
        };
      }

      const lost = Math.abs(dailyPnl);
      const lossPct = (lost / env.WALLET_BALANCE_USDC) * 100;

      // Whichever cap binds first stops trading. The absolute limit exists
      // because that is the number a person actually reacts to; the percentage
      // keeps a meaning if the bankroll changes.
      const absoluteCap = env.MAX_DAILY_LOSS_USDC > 0 ? env.MAX_DAILY_LOSS_USDC : Infinity;
      const percentCap = (env.MAX_DAILY_LOSS_PCT / 100) * env.WALLET_BALANCE_USDC;
      const cap = Math.min(absoluteCap, percentCap);
      const boundBy = absoluteCap <= percentCap ? 'absolute' : 'percentage';

      if (lost >= cap) {
        return {
          passed: false,
          detail:
            `Daily loss limit reached: $${lost.toFixed(2)} lost today ` +
            `(${lossPct.toFixed(1)}% of bankroll), cap $${cap.toFixed(2)} ` +
            `(${boundBy}). No new positions until 00:00 UTC.`,
        };
      }

      if (lost >= cap * 0.75) {
        return {
          passed: true,
          warning:
            `Daily loss $${lost.toFixed(2)} is at ${((lost / cap) * 100).toFixed(0)}% ` +
            `of the $${cap.toFixed(2)} cap`,
        };
      }
    }

    return { passed: true };
  }

  private checkDuplicatePosition(candidate: CandidatePayload): CheckResult {
    const existing = this.db.getOpenPositionsBySlug(candidate.marketSlug);

    if (existing.length === 0) return { passed: true };

    const totalSizeInMarket = existing.reduce((sum, p) => sum + p.shares * p.entryPrice, 0);
    // Use wallet balance as denominator — not open exposure — so the % is meaningful
    const portfolioBase = env.WALLET_BALANCE_USDC || 1;
    const marketExposurePct = (totalSizeInMarket / portfolioBase) * 100;

    if (marketExposurePct >= env.MAX_POSITION_SIZE_PCT) {
      return {
        passed: false,
        detail:
          `Already at maximum exposure (${marketExposurePct.toFixed(1)}%) for market ${candidate.marketSlug}. ` +
          `Existing positions: ${existing.length}`,
      };
    }

    return {
      passed: true,
      warning: `Existing position in ${candidate.marketSlug} (${marketExposurePct.toFixed(1)}% exposure). Adding to it.`,
    };
  }

  // ── Execution lock ─────────────────────────────────────────────────────────

  private resolveExecutionMode(): ExecutionMode {
    if (!env.LIVE_EXECUTION_ENABLED) return 'DRY_RUN';
    return 'LIVE';
  }

  // ── Audit helpers ──────────────────────────────────────────────────────────

  private buildRejection(
    candidate: CandidatePayload,
    detail: string,
    warnings: string[]
  ): RiskDecision {
    // Map detail strings to typed rejection reasons
    const reason = this.classifyRejection(detail);

    logger.warn('RiskManager: candidate rejected', {
      strategy: candidate.strategyModule,
      slug: candidate.marketSlug,
      reason,
      detail,
    });

    this.db.updateCandidateRiskStatus(
      candidate.externalSignalData?._candidateId as number,
      'REJECTED',
      reason,
      detail
    );

    return {
      approved: false,
      rejectionReason: reason,
      rejectionDetail: detail,
      warnings,
      executionMode: 'DRY_RUN',
      checkedAt: new Date(),
    };
  }

  private auditApproval(candidate: CandidatePayload): void {
    const candidateId = candidate.externalSignalData?._candidateId as number | undefined;
    if (candidateId) {
      this.db.updateCandidateRiskStatus(candidateId, 'APPROVED');
    }
  }

  private classifyRejection(detail: string): RejectionReason {
    const d = detail.toLowerCase();
    if (d.includes('spread')) return 'SPREAD_CEILING_EXCEEDED';
    if (d.includes('liquidity')) return 'LIQUIDITY_FLOOR_FAILED';
    if (d.includes('concentration')) return 'EVENT_CONCENTRATION_LIMIT';
    if (d.includes('daily deployment')) return 'DAILY_DEPLOYMENT_LIMIT_REACHED';
    if (d.includes('maximum exposure')) return 'DUPLICATE_MAX_POSITION';
    if (d.includes('exposure') || d.includes('deployed')) return 'EXPOSURE_LIMIT_EXCEEDED';
    if (d.includes('daily loss')) return 'DAILY_LOSS_LIMIT_REACHED';
    if (d.includes('volume')) return 'INSUFFICIENT_VOLUME_24H';
    return 'SPREAD_CEILING_EXCEEDED'; // safe fallback
  }
}
