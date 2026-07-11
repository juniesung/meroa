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
export const WELCOME_MESSAGE =
  "Hey — I'm Meroa. Just so it's clear up front: I'm an AI, not a person. I'm here to actually help — keep track of things, think through stuff with you, check in without being annoying about it. What's going on with you today?";
