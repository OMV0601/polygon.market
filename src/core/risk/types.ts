export type StrategyModule =
  | 'WALLET_MIRROR'
  | 'WEATHER'
  | 'NEWS_CATALYST'
  | 'CORRELATION_ARB';

export type Outcome = 'YES' | 'NO';

export type ExecutionMode = 'DRY_RUN' | 'LIVE';

export type RejectionReason =
  | 'SPREAD_CEILING_EXCEEDED'
  | 'LIQUIDITY_FLOOR_FAILED'
  | 'EXPOSURE_LIMIT_EXCEEDED'
  | 'EVENT_CONCENTRATION_LIMIT'
  | 'DAILY_DEPLOYMENT_LIMIT_REACHED'
  | 'DAILY_LOSS_LIMIT_REACHED'
  | 'DUPLICATE_MAX_POSITION'
  | 'INSUFFICIENT_VOLUME_24H'
  | 'STALE_EXTERNAL_DATA'
  | 'FORECAST_HORIZON_TOO_FAR'
  | 'NEWS_ALREADY_PRICED_IN'
  | 'ARB_MARGIN_TOO_THIN';

// ─── Module-specific supplemental data ───────────────────────────────────────

export interface ForecastData {
  source: 'NWS' | 'OPEN_METEO';
  city: string;
  forecastedValue: number;
  unit: string;
  confidenceInterval: [number, number];
  fetchedAt: Date;
}

export interface NewsItem {
  headline: string;
  source: string;
  sentiment: 'YES_CATALYST' | 'NO_CATALYST' | 'NEUTRAL';
  publishedAt: Date;
  url: string;
}

export interface ArbLeg {
  marketSlug: string;
  outcome: Outcome;
  price: number;
  liquidity: number;
}

// ─── Core payload ─────────────────────────────────────────────────────────────

export interface CandidatePayload {
  strategyModule: StrategyModule;
  marketSlug: string;
  outcome: Outcome;
  impliedProbability: number;         // 0–1
  externalSignalData: Record<string, unknown>;
  confidenceScore: number;            // 0–1
  suggestedSize: number;              // USDC

  // Module A
  walletAlias?: string;
  walletAddress?: string;
  priceDelta?: number;

  // Module B
  forecastData?: ForecastData;

  // Module C
  newsItem?: NewsItem;
  priceMoveSinceNews?: number;        // 0–1, fraction of market price move

  // Module D
  correlatedLeg?: ArbLeg;
  expectedArbMarginPostFee?: number;
}

// ─── Risk decision ────────────────────────────────────────────────────────────

export interface CheckResult {
  passed: boolean;
  detail?: string;
  warning?: string;
}

export interface RiskDecision {
  approved: boolean;
  rejectionReason?: RejectionReason;
  rejectionDetail?: string;
  adjustedSize?: number;
  warnings: string[];
  executionMode: ExecutionMode;
  checkedAt: Date;
}
