import Groq from 'groq-sdk';
import { env } from '../config/env.js';

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
