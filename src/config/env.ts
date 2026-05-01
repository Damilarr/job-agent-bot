import { config } from "dotenv";
import { z } from "zod";

config();

const envSchema = z.object({
  GROQ_API_KEY: z.string().min(1, "GROQ_API_KEY is required"),
  TELEGRAM_BOT_TOKEN: z.string().min(1, "TELEGRAM_BOT_TOKEN is required"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  EMAIL_ENCRYPTION_KEY: z.string().min(16).optional(),
  HEADLESS: z
    .preprocess((val) => val === "true" || val === true, z.boolean())
    .default(true),
  FORCE_IPV4: z
    .preprocess((val) => val === "true" || val === true, z.boolean())
    .default(true),
});
const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  console.error("❌ Invalid environment variables:", parsedEnv.error.format());
  process.exit(1);
}

export const env = parsedEnv.data;
