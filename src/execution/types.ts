import type { CandidatePayload, ExecutionMode, Outcome } from '../core/risk/types';

export interface ExecutionOrder {
  candidateId: number;
  candidate: CandidatePayload;
  action: 'BUY' | 'SELL';
  marketSlug: string;
  outcome: Outcome;
  sizeUsdc: number;
  limitPrice: number;
  mode: ExecutionMode;
  approvedAt: Date;
}

export interface FillResult {
  orderId?: string;
  txHash?: string;
  filledShares: number;
  avgFillPrice: number;
  totalCostUsdc: number;
  status: 'CONFIRMED' | 'PARTIAL' | 'FAILED' | 'SIMULATED';
  rawResponse?: string;
  filledAt: Date;
}
