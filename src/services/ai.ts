import { GoogleGenAI } from '@google/genai';
import { env } from '../config/env.js';

class AIService {
  private clients: GoogleGenAI[];
  private currentIndex: number = 0;

  constructor() {
    this.clients = env.GEMINI_API_KEY.map(key => new GoogleGenAI({ apiKey: key }));
    console.log(`🤖 AI Service initialized with ${this.clients.length} API keys.`);
  }

  /**
   * Returns a Gemini client, rotating to the next one in the list for each call.
   */
  getClient(): GoogleGenAI {
    if (this.clients.length === 0) {
      throw new Error("No Gemini API keys configured.");
    }
    
    const client = this.clients[this.currentIndex]!;
    this.currentIndex = (this.currentIndex + 1) % this.clients.length;
    
    return client;
  }
}

export const aiService = new AIService();
