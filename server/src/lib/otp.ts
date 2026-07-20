import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';

import { db } from '../db/client.ts';
import { otpCodes } from '../db/schema.ts';
import {
  DEMO_OTP_CODE,
  DEMO_PHONE_E164,
  OTP_MAX_ATTEMPTS,
  OTP_RATE_LIMIT_PER_HOUR,
  OTP_RESEND_COOLDOWN_SECONDS,
  OTP_TTL_MINUTES,
} from './constants.ts';
import { generateOtpCode, hashWithPepper } from './crypto.ts';

// One OTP implementation, shared by the app signup path (routes/auth.ts) and the
// web account-deletion flow (routes/legal.ts) so the two can't drift. The app
// verify route layers user-creation on top of verifyAndConsumeOtp; the web flow
// deliberately does NOT (a verified phone must resolve to an existing account or
// nothing — you can't create an account just to delete it).

export type IssueOtpResult = { status: 200; code: string } | { status: 429 };

// Rate-limited issuance (5/hour, 30s resend cooldown) under a per-phone advisory
// lock — the count-then-insert check isn't backed by a unique constraint, so the
// lock is what stops concurrent requests for the same number from all slipping
// under the cap. The caller is responsible for sending `code` over SMS.
export async function issueOtpForPhone(phone: string): Promise<IssueOtpResult> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${phone})::bigint)`);

    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const recent = await tx
      .select()
      .from(otpCodes)
      .where(and(eq(otpCodes.phoneE164, phone), gt(otpCodes.createdAt, oneHourAgo)))
      .orderBy(desc(otpCodes.createdAt));

    if (recent.length >= OTP_RATE_LIMIT_PER_HOUR) return { status: 429 as const };
    const [last] = recent;
    if (last && Date.now() - last.createdAt.getTime() < OTP_RESEND_COOLDOWN_SECONDS * 1000) {
      return { status: 429 as const };
    }

    const code = phone === DEMO_PHONE_E164 ? DEMO_OTP_CODE : generateOtpCode();
    const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);
    await tx.insert(otpCodes).values({ phoneE164: phone, codeHash: hashWithPepper(code), expiresAt });

    return { status: 200 as const, code };
  });
}

export type VerifyOtpResult = { ok: true } | { ok: false; status: 400 | 429; error: string };

// Verify + consume the newest unexpired, unconsumed code for a phone. Has NO
// signup side effect (unlike the app verify route). Increments attempts on a
// wrong code and consumes on success, exactly as the app path does.
export async function verifyAndConsumeOtp(phone: string, code: string): Promise<VerifyOtpResult> {
  const [candidate] = await db
    .select()
    .from(otpCodes)
    .where(
      and(eq(otpCodes.phoneE164, phone), isNull(otpCodes.consumedAt), gt(otpCodes.expiresAt, new Date())),
    )
    .orderBy(desc(otpCodes.createdAt))
    .limit(1);

  if (!candidate) return { ok: false, status: 400, error: 'no_pending_code' };
  if (candidate.attempts >= OTP_MAX_ATTEMPTS) return { ok: false, status: 429, error: 'too_many_attempts' };

  if (candidate.codeHash !== hashWithPepper(code)) {
    await db.update(otpCodes).set({ attempts: candidate.attempts + 1 }).where(eq(otpCodes.id, candidate.id));
    return { ok: false, status: 400, error: 'invalid_code' };
  }

  await db.update(otpCodes).set({ consumedAt: new Date() }).where(eq(otpCodes.id, candidate.id));
  return { ok: true };
}
