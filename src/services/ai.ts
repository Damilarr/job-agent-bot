import Groq from 'groq-sdk';
import type { ChatCompletion, ChatCompletionCreateParamsNonStreaming } from 'groq-sdk/resources/chat/completions';
import { env } from '../config/env.js';

// Groq retires models periodically; keep the model name in one place.
export const GROQ_MODEL = 'openai/gpt-oss-120b';

/**
 * Replaces typographic dashes and hyphens that make generated text read as AI-written
 * (em dash, en dash, non-breaking/figure hyphens) with a plain "-".
 */
export function normalizeDashes(text: string): string {
  return text
    .replace(/[ \t]*[\u2014\u2015][ \t]*/g, ' - ')
    .replace(/[\u2010\u2011\u2012\u2013\u2212]/g, '-');
}

class AIService {
  private client: Groq;

  constructor() {
    // The free tier allows 8k tokens/minute, and one application makes several calls.
    // The SDK honours Groq's retry-after header on 429s, so allow enough retries to wait out a full window.
    this.client = new Groq({ apiKey: env.GROQ_API_KEY, maxRetries: 6 });
    console.log(`🤖 AI Service initialized with Groq.`);
  }

  /**
   * Chat completion with the shared model and low reasoning effort.
   * gpt-oss reasoning tokens count toward the rate limit, and these tasks don't need deep reasoning.
   */
  complete(params: Omit<ChatCompletionCreateParamsNonStreaming, 'model'>): Promise<ChatCompletion> {
    return this.client.chat.completions.create({
      model: GROQ_MODEL,
      reasoning_effort: 'low',
      ...params,
      stream: false,
    });
  }
}

export const aiService = new AIService();
