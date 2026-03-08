import { config } from 'dotenv';
import { z } from 'zod'; // We'll install zod for env validation

// Load environment variables from .env file
config();

// Define the schema for our environment variables
const envSchema = z.object({
  GEMINI_API_KEY: z.string().min(1, "GEMINI_API_KEY is required"),
  TELEGRAM_BOT_TOKEN: z.string().min(1, "TELEGRAM_BOT_TOKEN is required"),
  GMAIL_USER: z.string().email("GMAIL_USER must be a valid email address").min(1, "GMAIL_USER is required"),
  GMAIL_APP_PASSWORD: z.string().min(1, "GMAIL_APP_PASSWORD is required"),
  JSEARCH_RAPIDAPI_KEY: z.string().min(1, "JSEARCH_RAPIDAPI_KEY is required for auto job hunting"),
});

// Parse and validate the environment variables
const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  console.error("❌ Invalid environment variables:", parsedEnv.error.format());
  process.exit(1);
}

// Export the validated environment variables
export const env = parsedEnv.data;
