import { spawn } from 'child_process';
import path from 'path';
import { env } from '../../config/env';
import { BULLPEN } from '../../config/constants';
import { logger } from '../logger/logger';
import type {
  BullpenDiscoverResult,
  BullpenHealthStatus,
  BullpenOrderBook,
  BullpenPositionsResult,
  BullpenWalletTransaction,
} from './types';

// ─── Binary Resolution ────────────────────────────────────────────────────────

function resolveBin(): string {
  if (env.BULLPEN_PATH) return path.resolve(env.BULLPEN_PATH);
  return 'bullpen';
}

// ─── Core Executor ────────────────────────────────────────────────────────────

function execBullpen(args: string[], timeoutMs: number = BULLPEN.TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    const bin = resolveBin();
    let settled = false;

    const settle = (fn: () => void) => {
      if (!settled) {
        settled = true;
        fn();
      }
    };

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      settle(() =>
        reject(new Error(`bullpen timed out after ${timeoutMs}ms [args: ${args.join(' ')}]`))
      );
    }, timeoutMs);

    const proc = spawn(bin, args, { env: process.env, shell: false });
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        settle(() => reject(new Error(`bullpen exited ${code}: ${stderr.trim()}`)));
      } else {
        settle(() => resolve(stdout.trim()));
      }
    });

    proc.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (err.code === 'ENOENT') {
        settle(() =>
          reject(
            new Error(
              `bullpen binary not found at "${bin}". ` +
                `Install bullpen globally or set BULLPEN_PATH in .env`
            )
          )
        );
      } else {
        settle(() => reject(err));
      }
    });
  });
}

// ─── Retry with Exponential Backoff ──────────────────────────────────────────

async function execWithRetry(args: string[], retries = BULLPEN.MAX_RETRIES): Promise<string> {
  let lastError: Error = new Error('unknown');

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await execBullpen(args);
    } catch (err) {
      lastError = err as Error;
      if (attempt === retries) break;

      const backoffMs = BULLPEN.BACKOFF_BASE_MS * Math.pow(2, attempt);
      logger.warn('bullpen command failed, retrying', {
        attempt: attempt + 1,
        maxRetries: retries,
        backoffMs,
        command: args[0],
        error: lastError.message,
      });
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }

  throw lastError;
}

// ─── JSON Parse Helper ────────────────────────────────────────────────────────

function parseJson<T>(raw: string, context: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`Failed to parse bullpen response for "${context}": ${raw.slice(0, 200)}`);
  }
}

// ─── Public Client ────────────────────────────────────────────────────────────

export class BullpenClient {
  async healthCheck(): Promise<BullpenHealthStatus> {
    const start = Date.now();
    try {
      const raw = await execBullpen(['--version'], 3_000);
      return {
        connected: true,
        version: raw.trim(),
        latencyMs: Date.now() - start,
      };
    } catch (err) {
      return {
        connected: false,
        version: null,
        latencyMs: Date.now() - start,
        error: (err as Error).message,
      };
    }
  }

  async discover(filters?: { category?: string; minVolume?: number }): Promise<BullpenDiscoverResult> {
    const args = ['polymarket', 'discover', '--format', 'json'];
    if (filters?.category) args.push('--category', filters.category);
    if (filters?.minVolume != null) args.push('--min-volume', String(filters.minVolume));

    const raw = await execWithRetry(args);
    return parseJson<BullpenDiscoverResult>(raw, 'discover');
  }

  async positions(): Promise<BullpenPositionsResult> {
    const raw = await execWithRetry(['polymarket', 'positions', '--format', 'json']);
    return parseJson<BullpenPositionsResult>(raw, 'positions');
  }

  async orderBook(marketSlug: string, outcome: string): Promise<BullpenOrderBook> {
    const raw = await execWithRetry([
      'polymarket', 'orderbook',
      '--market', marketSlug,
      '--outcome', outcome,
      '--format', 'json',
    ]);
    return parseJson<BullpenOrderBook>(raw, `orderbook:${marketSlug}`);
  }

  async walletTransactions(walletAddress: string, since?: Date): Promise<BullpenWalletTransaction[]> {
    const args = ['polymarket', 'wallet', '--address', walletAddress, '--format', 'json'];
    if (since) args.push('--since', since.toISOString());

    const raw = await execWithRetry(args);
    return parseJson<BullpenWalletTransaction[]>(raw, `wallet:${walletAddress.slice(0, 8)}…`);
  }

  // Constructs but does NOT execute a buy command.
  // The ExecutionEngine is the only caller permitted to run the live variant.
  buildBuyCommand(marketSlug: string, outcome: string, amountUsdc: number): string {
    return `bullpen polymarket buy ${marketSlug} ${outcome} ${amountUsdc.toFixed(2)}`;
  }

  buildSellCommand(marketSlug: string, outcome: string, shares: number): string {
    return `bullpen polymarket sell ${marketSlug} ${outcome} ${shares.toFixed(4)}`;
  }

  // Live execution — only reachable when LIVE_EXECUTION_ENABLED=true
  async executeBuy(
    marketSlug: string,
    outcome: string,
    amountUsdc: number
  ): Promise<string> {
    if (!env.LIVE_EXECUTION_ENABLED) {
      logger.log('error', '[FATAL] executeBuy called while LIVE_EXECUTION_ENABLED=false — unauthorized execution attempt blocked', {
        marketSlug,
        outcome,
        amountUsdc,
      });
      throw new Error('UNAUTHORIZED_EXECUTION: LIVE_EXECUTION_ENABLED is false');
    }

    logger.info('Submitting live BUY order via bullpen', { marketSlug, outcome, amountUsdc });
    const raw = await execWithRetry([
      'polymarket', 'buy',
      marketSlug, outcome, String(amountUsdc),
      '--format', 'json',
    ]);
    return raw;
  }
}
