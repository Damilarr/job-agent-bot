import { config } from 'dotenv';
import { z } from 'zod'; 

// Load environment variables from .env file
config();

// schema for environment variables
const envSchema = z.object({
  GEMINI_API_KEY: z.string().min(1, "GEMINI_API_KEY is required").transform(val => val.split(',').map(k => k.trim())),
  TELEGRAM_BOT_TOKEN: z.string().min(1, "TELEGRAM_BOT_TOKEN is required"),
  GMAIL_USER: z.string().email("GMAIL_USER must be a valid email address").min(1, "GMAIL_USER is required"),
  GMAIL_APP_PASSWORD: z.string().min(1, "GMAIL_APP_PASSWORD is required"),
  // Form Auto-Fill required fields
  PHONE_NUMBER: z.string().min(1, "PHONE_NUMBER is required for form filling"),
  LINKEDIN_URL: z.string().url("LINKEDIN_URL must be a valid URL").min(1, "LINKEDIN_URL is required"),
  GITHUB_URL: z.string().url("GITHUB_URL must be a valid URL").min(1, "GITHUB_URL is required"),
  PORTFOLIO_URL: z.string().url("PORTFOLIO_URL must be a valid URL").optional(),
  HEADLESS: z.preprocess((val) => val === 'true' || val === true, z.boolean()).default(true),
});
const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  console.error("❌ Invalid environment variables:", parsedEnv.error.format());
  process.exit(1);
}

export const env = parsedEnv.data;
