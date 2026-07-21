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
  // Hard paywall (no persistent free tier): a lapsed/never-started user gets
  // zero of everything below until they start a trial or subscribe — see
  // docs/phases/phase-7-premium-billing.md. Overridable for local testing
  // (e.g. temporarily raising this to exercise a non-zero 429 path) without
  // hand-editing usage.ts and having to remember to revert it.
  FREE_DAILY_MESSAGES: z.coerce.number().int().nonnegative().default(0),
  PLUS_DAILY_MESSAGES: z.coerce.number().int().positive().default(100),
  // Phase 7 billing: RevenueCat is the receipt-verification layer; the
  // `entitlements` table stays the source of truth (lib/billing/entitlement.ts
  // always refetches RC's current subscriber state rather than trusting event
  // payloads). Optional so the server boots without billing configured —
  // routes/billing.ts returns 503 billing_unconfigured until these are set.
  REVENUECAT_SECRET_API_KEY: z.string().optional(),
  REVENUECAT_WEBHOOK_SECRET: z.string().optional(),
  REVENUECAT_ENTITLEMENT_ID: z.string().default('plus'),
  // Same hard-paywall zero-default as FREE_DAILY_MESSAGES above (lib/limits.ts).
  FREE_DAILY_TASKS: z.coerce.number().int().nonnegative().default(0),
  FREE_MAX_ACTIVE_GOALS: z.coerce.number().int().nonnegative().default(0),
  // Optional — same graceful-degradation pattern as REVENUECAT_SECRET_API_KEY.
  // Sentry.init only runs when this is set (index.ts), so the server boots
  // fine without error reporting configured.
  SENTRY_DSN: z.string().optional(),
  // Proactive re-engagement pushes (routes/internal.ts's POST /internal/tick,
  // driven by an external Railway cron). CRON_SECRET guards that endpoint; when
  // it's unset the tick route refuses every call, so notifications stay off
  // until it's deliberately configured — no accidental sends in dev.
  CRON_SECRET: z.string().optional(),
  // A user is a win-back candidate once they've been inactive this many days.
  NOTIFY_WINBACK_AFTER_DAYS: z.coerce.number().int().positive().default(3),
  // The proactive-message cap (CLAUDE.md §2). Defaults: at most 1 proactive
  // push/day and 4/week, on top of the user-set task reminders (which are
  // client-local and never counted here). A user can tighten this via
  // prefs.notificationCap; these are the ceilings and the fallback.
  NOTIFY_MAX_PER_DAY: z.coerce.number().int().nonnegative().default(1),
  NOTIFY_MAX_PER_WEEK: z.coerce.number().int().nonnegative().default(4),
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
