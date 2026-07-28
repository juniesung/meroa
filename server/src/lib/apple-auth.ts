import { createRemoteJWKSet, importPKCS8, jwtVerify, SignJWT } from 'jose';

import { env } from '../env.ts';
import { logger } from '../logger.ts';

// Verifies a "Sign in with Apple" identity token. The client (expo-apple-
// authentication) performs the actual sign-in and hands us Apple's signed
// identity token; we verify it against Apple's public keys — no Apple server
// secret needed for login (only account-deletion revocation needs one, later).
//
// The verification IS the security boundary: Apple signs the token, we check the
// signature against Apple's rotating JWKS, and enforce issuer + audience so a
// token minted for a different app can't be replayed here. Same posture as every
// other auth check in this app — a guarantee in code (docs/chat-architecture.md).

const APPLE_ISSUER = 'https://appleid.apple.com';
// jose caches + refreshes the key set (Apple rotates keys); one shared instance.
const appleJwks = createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'));

export type AppleIdentity = {
  // Apple's stable per-user, per-team identifier (the `sub` claim). This is the
  // account key — it never changes for a given Apple ID on our app.
  appleUserId: string;
  // Present only on the FIRST sign-in (Apple omits it afterward), and only if the
  // user agreed to share it. Never rely on it for identity — it's the sub.
  email: string | null;
};

export async function verifyAppleIdentityToken(idToken: string): Promise<AppleIdentity> {
  const { payload } = await jwtVerify(idToken, appleJwks, {
    issuer: APPLE_ISSUER,
    audience: env.APPLE_BUNDLE_ID,
  });
  const sub = payload.sub;
  if (typeof sub !== 'string' || sub.length === 0) {
    throw new Error('apple identity token missing sub');
  }
  const email = typeof payload.email === 'string' ? payload.email : null;
  return { appleUserId: sub, email };
}

// ── Token revocation (Apple guideline 5.1.1(v): revoke on account deletion) ──
// These need the Sign in with Apple server key (env APPLE_TEAM_ID / APPLE_KEY_ID
// / APPLE_PRIVATE_KEY). Optional + graceful: everything degrades to a no-op with
// a log when they're unset, so login is unaffected until they're configured.

export function appleRevocationConfigured(): boolean {
  return Boolean(env.APPLE_TEAM_ID && env.APPLE_KEY_ID && env.APPLE_PRIVATE_KEY);
}

// The short-lived ES256 client_secret JWT Apple's token + revoke endpoints
// require, signed with the .p8 key.
async function appleClientSecret(): Promise<string> {
  // Railway/env often stores the .p8 with escaped newlines — restore real ones.
  const pkcs8 = (env.APPLE_PRIVATE_KEY ?? '').replace(/\\n/g, '\n');
  const key = await importPKCS8(pkcs8, 'ES256');
  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: env.APPLE_KEY_ID ?? '' })
    .setIssuer(env.APPLE_TEAM_ID ?? '')
    .setIssuedAt()
    .setExpirationTime('5m')
    .setAudience(APPLE_ISSUER)
    .setSubject(env.APPLE_BUNDLE_ID)
    .sign(key);
}

// Exchange the sign-in authorization code for Apple's refresh token — kept solely
// to revoke on deletion. Returns null (not configured / failure) so login never
// breaks over this.
export async function exchangeAppleAuthCode(code: string): Promise<string | null> {
  if (!appleRevocationConfigured()) return null;
  try {
    const secret = await appleClientSecret();
    const res = await fetch(`${APPLE_ISSUER}/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.APPLE_BUNDLE_ID,
        client_secret: secret,
        grant_type: 'authorization_code',
        code,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, 'apple auth-code exchange failed');
      return null;
    }
    const json = (await res.json()) as { refresh_token?: string };
    return json.refresh_token ?? null;
  } catch (err) {
    logger.warn({ err }, 'apple auth-code exchange threw');
    return null;
  }
}

// Best-effort revoke of a user's Apple refresh token on account deletion.
export async function revokeAppleRefreshToken(refreshToken: string): Promise<void> {
  if (!appleRevocationConfigured()) {
    logger.warn('apple revocation not configured — skipping token revoke on deletion');
    return;
  }
  try {
    const secret = await appleClientSecret();
    const res = await fetch(`${APPLE_ISSUER}/auth/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.APPLE_BUNDLE_ID,
        client_secret: secret,
        token: refreshToken,
        token_type_hint: 'refresh_token',
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) logger.warn({ status: res.status }, 'apple token revoke failed');
  } catch (err) {
    logger.warn({ err }, 'apple token revoke threw');
  }
}
