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
  // The act/narrate split (providers/act-narrate.ts): an isolated,
  // forced-tool-choice action pass followed by a full-context narrate pass.
  // 'off' falls back to the original single-pass loop for the
  // OpenAI-compatible providers — kept as an instant rollback lever and for
  // A/B comparison of the false-claim rate (docs/goals-redesign-plan.md).
  AI_ACT_NARRATE: z.enum(['on', 'off']).default('on'),
  // The claim-check classifier (lib/ai/claim-check.ts) always calls
  // DeepSeek regardless of AI_PROVIDER — cheapest option for a ~100-token
  // yes/no call that runs on every zero-tool-call turn. Falls back to the
  // regex-only result if DEEPSEEK_API_KEY isn't set.
  CLAIM_CHECK_MODEL: z.string().default('deepseek-v4-flash'),
  // Override for local testing (e.g. forcing the fair-use limit down to
  // exercise the 429 path) without hand-editing usage.ts and having to
  // remember to revert it.
  FREE_DAILY_MESSAGES: z.coerce.number().int().positive().default(20),
  PLUS_DAILY_MESSAGES: z.coerce.number().int().positive().default(100),
  // Phase 7 billing: RevenueCat is the receipt-verification layer; the
  // `entitlements` table stays the source of truth (lib/billing/entitlement.ts
  // always refetches RC's current subscriber state rather than trusting event
  // payloads). Optional so the server boots without billing configured —
  // routes/billing.ts returns 503 billing_unconfigured until these are set.
  REVENUECAT_SECRET_API_KEY: z.string().optional(),
  REVENUECAT_WEBHOOK_SECRET: z.string().optional(),
  REVENUECAT_ENTITLEMENT_ID: z.string().default('plus'),
  // Free-plan creation caps (core three, CLAUDE.md §2/phase-7): task/goal
  // creation only — never completion or progress (lib/limits.ts).
  FREE_DAILY_TASKS: z.coerce.number().int().positive().default(2),
  FREE_MAX_ACTIVE_GOALS: z.coerce.number().int().positive().default(1),
  // Optional — same graceful-degradation pattern as REVENUECAT_SECRET_API_KEY.
  // Sentry.init only runs when this is set (index.ts), so the server boots
  // fine without error reporting configured.
  SENTRY_DSN: z.string().optional(),
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
