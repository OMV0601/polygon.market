import { z } from 'zod';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  BULLPEN_PATH: z.string().optional(),

  DB_PATH: z.string().default('./data/polygon.db'),

  DASHBOARD_PORT: z.coerce.number().int().min(1024).max(65535).default(3000),

  // Execution lock — must be the literal string "true" to enable live trading
  LIVE_EXECUTION_ENABLED: z
    .string()
    .transform((v) => v.toLowerCase() === 'true')
    .default('false'),

  MAX_POSITION_SIZE_PCT: z.coerce.number().min(0.1).max(100).default(5),
  MAX_DAILY_LOSS_PCT: z.coerce.number().min(0.1).max(100).default(10),
  SPREAD_CEILING: z.coerce.number().min(0).default(0.05),
  LIQUIDITY_MULTIPLIER: z.coerce.number().min(1).default(5),

  // Set to your actual USDC balance. 0 = skip the per-trade exposure check.
  WALLET_BALANCE_USDC: z.coerce.number().min(0).default(0),

  TRACKED_WALLETS: z
    .string()
    .optional()
    .transform((v) =>
      v
        ? v.split(',').map((w) => w.trim()).filter(Boolean)
        : []
    ),

  TWITTER_BEARER_TOKEN: z.string().optional(),
  NEWS_API_KEY: z.string().optional(),

  ANTHROPIC_API_KEY: z.string().optional(),

  // Comma-separated RSS feed URLs for Module C
  RSS_FEED_URLS: z
    .string()
    .default(
      'https://feeds.bbci.co.uk/news/rss.xml,' +
      'https://feeds.npr.org/1001/rss.xml,' +
      'https://rss.nytimes.com/services/xml/rss/nyt/World.xml'
    )
    .transform((v) => v.split(',').map((u) => u.trim()).filter(Boolean)),
});

export type Env = z.infer<typeof EnvSchema>;

const result = EnvSchema.safeParse(process.env);

if (!result.success) {
  console.error('[FATAL] Invalid environment configuration:');
  for (const [field, err] of Object.entries(result.error.flatten().fieldErrors)) {
    console.error(`  ${field}: ${(err as string[]).join(', ')}`);
  }
  process.exit(1);
}

export const env = result.data;
