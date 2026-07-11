import { jwtVerify, SignJWT } from 'jose';

import { ACCESS_TOKEN_TTL_SECONDS } from './constants.ts';
import { env } from '../env.ts';

const secret = new TextEncoder().encode(env.JWT_SECRET);

export async function signAccessToken(userId: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(secret);
}

export async function verifyAccessToken(token: string): Promise<string> {
  const { payload } = await jwtVerify(token, secret);
  if (!payload.sub) throw new Error('missing_subject');
  return payload.sub;
}
