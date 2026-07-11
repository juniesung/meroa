import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().url(),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  PORT: z.coerce.number().int().positive().default(8787),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  ANTHROPIC_API_KEY: z.string().min(1, 'ANTHROPIC_API_KEY is required'),
  ANTHROPIC_MODEL: z.string().default('claude-haiku-4-5'),
  // Override for local testing (e.g. forcing the fair-use limit down to
  // exercise the 429 path) without hand-editing usage.ts and having to
  // remember to revert it.
  FREE_DAILY_MESSAGES: z.coerce.number().int().positive().default(50),
  PLUS_DAILY_MESSAGES: z.coerce.number().int().positive().default(1000),
});

export const env = schema.parse(process.env);
