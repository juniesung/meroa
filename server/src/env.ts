import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().url(),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  PORT: z.coerce.number().int().positive().default(8787),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  AI_PROVIDER: z.enum(['anthropic', 'openai', 'deepseek']).default('anthropic'),
  ANTHROPIC_API_KEY: z.string().min(1, 'ANTHROPIC_API_KEY is required'),
  ANTHROPIC_MODEL: z.string().default('claude-haiku-4-5'),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),
  DEEPSEEK_API_KEY: z.string().optional(),
  DEEPSEEK_MODEL: z.string().default('deepseek-v4-flash'),
  // The claim-check classifier (lib/ai/claim-check.ts) always calls
  // DeepSeek regardless of AI_PROVIDER — cheapest option for a ~100-token
  // yes/no call that runs on every zero-tool-call turn. Falls back to the
  // regex-only result if DEEPSEEK_API_KEY isn't set.
  CLAIM_CHECK_MODEL: z.string().default('deepseek-v4-flash'),
  // Override for local testing (e.g. forcing the fair-use limit down to
  // exercise the 429 path) without hand-editing usage.ts and having to
  // remember to revert it.
  FREE_DAILY_MESSAGES: z.coerce.number().int().positive().default(50),
  PLUS_DAILY_MESSAGES: z.coerce.number().int().positive().default(1000),
});

export const env = schema
  .refine((e) => e.AI_PROVIDER !== 'openai' || !!e.OPENAI_API_KEY, {
    message: 'OPENAI_API_KEY is required when AI_PROVIDER=openai',
    path: ['OPENAI_API_KEY'],
  })
  .refine((e) => e.AI_PROVIDER !== 'deepseek' || !!e.DEEPSEEK_API_KEY, {
    message: 'DEEPSEEK_API_KEY is required when AI_PROVIDER=deepseek',
    path: ['DEEPSEEK_API_KEY'],
  })
  .parse(process.env);
