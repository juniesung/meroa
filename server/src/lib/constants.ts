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
