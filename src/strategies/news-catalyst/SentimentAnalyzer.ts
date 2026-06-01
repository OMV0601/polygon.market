import Anthropic from '@anthropic-ai/sdk';
import { env } from '../../config/env';
import { logger } from '../../core/logger/logger';
import type { NewsItem } from '../../core/risk/types';

export interface SentimentResult {
  sentiment: NewsItem['sentiment'];
  confidence: number;
  reasoning: string;
  method: 'LLM' | 'KEYWORD';
}

const SYSTEM_PROMPT = `You are a prediction market analyst. Given a news headline and a market question, determine whether the news is a catalyst for YES, NO, or NEUTRAL for that market.

Return ONLY valid JSON with this exact shape:
{"sentiment":"YES_CATALYST"|"NO_CATALYST"|"NEUTRAL","confidence":0.0-1.0,"reasoning":"one sentence max"}`;

const YES_WORDS = ['confirmed', 'approved', 'passed', 'won', 'victory', 'elected', 'signed', 'appointed', 'certified', 'ratified', 'succeeded'];
const NO_WORDS = ['rejected', 'failed', 'blocked', 'lost', 'denied', 'resigned', 'withdrew', 'dismissed', 'dropped', 'suspended', 'acquitted', 'overturned'];

export class SentimentAnalyzer {
  private client: Anthropic | null;

  constructor() {
    this.client = env.ANTHROPIC_API_KEY
      ? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })
      : null;

    if (!this.client) {
      logger.warn('SentimentAnalyzer: ANTHROPIC_API_KEY not set — using keyword fallback');
    }
  }

  async classify(headline: string, marketTitle: string): Promise<SentimentResult> {
    if (this.client) {
      try {
        return await this.llmClassify(headline, marketTitle);
      } catch (err) {
        logger.warn('SentimentAnalyzer: LLM failed, falling back to keywords', {
          error: (err as Error).message,
        });
      }
    }
    return this.keywordClassify(headline);
  }

  private async llmClassify(headline: string, marketTitle: string): Promise<SentimentResult> {
    const response = await this.client!.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 150,
      system: [
        {
          type: 'text',
          text: SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' },
        },
      ] as Anthropic.Messages.TextBlockParam[],
      messages: [
        {
          role: 'user',
          content: `Headline: "${headline}"\nMarket: "${marketTitle}"`,
        },
      ],
    });

    const raw = response.content[0].type === 'text' ? response.content[0].text.trim() : '{}';
    const parsed = JSON.parse(raw) as {
      sentiment?: string;
      confidence?: number;
      reasoning?: string;
    };

    const sentiment = (['YES_CATALYST', 'NO_CATALYST', 'NEUTRAL'] as const).includes(
      parsed.sentiment as NewsItem['sentiment']
    )
      ? (parsed.sentiment as NewsItem['sentiment'])
      : 'NEUTRAL';

    return {
      sentiment,
      confidence: typeof parsed.confidence === 'number' ? Math.min(1, Math.max(0, parsed.confidence)) : 0.5,
      reasoning: parsed.reasoning ?? '',
      method: 'LLM',
    };
  }

  private keywordClassify(headline: string): SentimentResult {
    const lower = headline.toLowerCase();
    const yesHits = YES_WORDS.filter((w) => lower.includes(w)).length;
    const noHits = NO_WORDS.filter((w) => lower.includes(w)).length;

    if (yesHits > noHits)
      return { sentiment: 'YES_CATALYST', confidence: 0.45, reasoning: 'keyword match', method: 'KEYWORD' };
    if (noHits > yesHits)
      return { sentiment: 'NO_CATALYST', confidence: 0.45, reasoning: 'keyword match', method: 'KEYWORD' };
    return { sentiment: 'NEUTRAL', confidence: 0.2, reasoning: 'no strong keywords', method: 'KEYWORD' };
  }
}
