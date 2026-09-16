import Groq from 'groq-sdk';
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
    this.client = new Groq({ apiKey: env.GROQ_API_KEY });
    console.log(`🤖 AI Service initialized with Groq.`);
  }

  getClient(): Groq {
    return this.client;
  }
}

export const aiService = new AIService();
