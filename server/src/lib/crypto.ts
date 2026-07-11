import { createHash, randomBytes, randomInt } from 'node:crypto';

import { env } from '../env.ts';

/** Six-digit OTP, zero-padded. */
export function generateOtpCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

/**
 * SHA-256 with the server secret as a pepper. Fine for OTP codes and
 * refresh tokens — both are short-lived, high-entropy or attempt-capped,
 * not user-chosen passwords needing a slow KDF.
 */
export function hashWithPepper(value: string): string {
  return createHash('sha256').update(`${value}:${env.JWT_SECRET}`).digest('hex');
}

export function generateRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}
