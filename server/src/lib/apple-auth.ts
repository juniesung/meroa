import { createRemoteJWKSet, jwtVerify } from 'jose';

import { env } from '../env.ts';

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
