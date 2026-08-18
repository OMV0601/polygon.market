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

  // Max capital the bot may deploy into new positions per calendar day (UTC).
  // 0 = no daily cap. Drip-feeds the bankroll instead of deploying it at once.
  MAX_DAILY_DEPLOYMENT_USDC: z.coerce.number().min(0).default(100),

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

  // ─── Daily email report (optional) ──────────────────────────────────────────
  // Gmail address that sends the report, plus a Google "app password".
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  // Who receives the report. Defaults to SMTP_USER if left blank.
  REPORT_EMAIL_TO: z.string().optional(),
  // Hour of day (UTC, 0–23) to send the daily summary.
  REPORT_HOUR_UTC: z.coerce.number().int().min(0).max(23).default(23),

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

/**
 * Credentials pasted into a secret store or .env pick up stray whitespace
 * surprisingly often — a trailing newline in a GitHub Actions secret is enough
 * to make Gmail reject an otherwise valid app password with a bad-credentials
 * error that names nothing useful. Trim them before validation so the value
 * that was intended is the value that gets used.
 */
const TRIMMED_KEYS = [
  'SMTP_USER',
  'SMTP_PASS',
  'REPORT_EMAIL_TO',
  'ANTHROPIC_API_KEY',
  'TWITTER_BEARER_TOKEN',
  'NEWS_API_KEY',
  'TRACKED_WALLETS',
] as const;

const rawEnv: NodeJS.ProcessEnv = { ...process.env };
for (const key of TRIMMED_KEYS) {
  const value = rawEnv[key];
  if (typeof value === 'string') rawEnv[key] = value.trim();
}

const result = EnvSchema.safeParse(rawEnv);

if (!result.success) {
  console.error('[FATAL] Invalid environment configuration:');
  for (const [field, err] of Object.entries(result.error.flatten().fieldErrors)) {
    console.error(`  ${field}: ${(err as string[]).join(', ')}`);
  }
  process.exit(1);
}

export const env = result.data;
