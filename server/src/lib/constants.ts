export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const REFRESH_TOKEN_TTL_DAYS = 30;

export const OTP_TTL_MINUTES = 10;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RATE_LIMIT_PER_HOUR = 5;
export const OTP_RESEND_COOLDOWN_SECONDS = 30;

// The seeded pre-install relationship used to demonstrate continuity
// (Phase 1 DoD) without a real SMS provider (that's Phase 9).
export const DEMO_PHONE_E164 = '+15555550100';
export const DEMO_OTP_CODE = '000000';

// Sent once, when a brand-new user's app conversation is first created
// (auth.ts's signup path, and dev-token.ts's equivalent for local testing).
// AI disclosure is woven in naturally ("your AI companion") rather than a
// standalone blunt sentence, per CLAUDE.md §2 — it must still hold from the
// very first message, just not read as a clinical disclaimer up front.
export const WELCOME_MESSAGE =
  "Hey — I'm Meroa, your AI companion. I'm here to help you actually follow through on the stuff that matters, keep track of it all, and be someone to think out loud with whenever something's on your mind. What's going on with you today?";
