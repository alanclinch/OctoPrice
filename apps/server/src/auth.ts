/**
 * Access tokens and session resolution.
 *
 * There are no passwords and no email addresses. The owner creates an invite,
 * which is a user row plus a random token; the link carries the token, the
 * browser stores it in a cookie, and every request resolves it back to a
 * person. For a handful of friends and family this is the right shape: nothing
 * to remember, nothing to reset, and nothing worth stealing beyond access to
 * somebody's electricity alerts.
 *
 * Only the SHA-256 of a token is ever stored, so a copy of the database does
 * not hand over anyone's access. Web Crypto is used rather than `node:crypto`
 * because this runs unchanged in both Node and the Workers runtime.
 */

import type { User } from '@octoprice/core';
import type { Store } from './db/store.ts';

export const SESSION_COOKIE = 'octoprice_session';

/** A year. Long enough that family never has to think about it again. */
const SESSION_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

/** 256 bits of randomness, which is far beyond what this needs to resist. */
const TOKEN_BYTES = 32;

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Creates a fresh access token. The plain value is shown exactly once. */
export function generateToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

/** SHA-256 of a token, hex encoded. This is what the database holds. */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Extracts the token from a request.
 *
 * The cookie is the normal path. A bearer header is also accepted so the API
 * can be exercised with curl without juggling cookies.
 */
export function readToken(headers: {
  cookie?: string | null;
  authorization?: string | null;
}): string | null {
  const authorization = headers.authorization ?? '';
  if (authorization.toLowerCase().startsWith('bearer ')) {
    const value = authorization.slice(7).trim();
    if (value) return value;
  }

  for (const part of (headers.cookie ?? '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE) {
      const value = rest.join('=').trim();
      if (value) return decodeURIComponent(value);
    }
  }
  return null;
}

/**
 * `Set-Cookie` value for a session.
 *
 * HttpOnly so that a script cannot read the token; SameSite=Lax so the invite
 * link still works when followed from a message. Production and tests keep
 * Secure; an explicitly non-secure development origin may omit it so the PWA
 * can be tested from a phone on the local network as well as localhost.
 */
export function sessionCookie(token: string, secure = true): string {
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    ...(secure ? ['Secure'] : []),
    'SameSite=Lax',
    `Max-Age=${SESSION_MAX_AGE_SECONDS}`,
  ].join('; ');
}

/** `Set-Cookie` value that removes the session. */
export function clearSessionCookie(secure = true): string {
  return [
    `${SESSION_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    ...(secure ? ['Secure'] : []),
    'SameSite=Lax',
    'Max-Age=0',
  ].join('; ');
}

/**
 * Resolves a request's token to a user, recording that they were seen.
 *
 * Returns null for a missing or unknown token, which callers turn into a 401.
 */
export async function resolveUser(
  store: Store,
  token: string | null,
  now: Date,
): Promise<User | null> {
  if (!token) return null;

  const user = await store.findUserByTokenHash(await hashToken(token));
  if (!user) return null;

  await store.recordUserSeen(user.id, now);
  return user;
}

/** Builds the invite link for a token, given the site's own origin. */
export function inviteLink(origin: string, token: string): string {
  return `${origin.replace(/\/$/, '')}/?invite=${encodeURIComponent(token)}`;
}
