/**
 * Turning an invite link into a session.
 *
 * This looks trivial and is not, because of one specific hazard: on the first
 * load after a deployment, the service worker registered with `autoUpdate`
 * takes control and reloads the page. That aborts whatever request is in
 * flight - including this one.
 *
 * So two rules hold here:
 *
 *  - The token stays in the address bar until the outcome is *definitive*.
 *    If the page reloads mid-claim, the token is still there and the reload
 *    simply tries again. An earlier version removed it first, which turned a
 *    survivable interruption into a link that could never be used.
 *  - Only a 401 means the link is genuinely bad. A network failure means try
 *    again, and must not be reported as an invalid link.
 */

import { ApiError } from './api.ts';

export type ClaimOutcome =
  /** No invite token in the URL; nothing to do. */
  | { kind: 'absent' }
  /** Signed in. The token may now be forgotten. */
  | { kind: 'claimed'; userId: string }
  /** The server rejected the token. It will never work. */
  | { kind: 'rejected' }
  /** Could not reach the server. Keep the token and let the user retry. */
  | { kind: 'unreachable' };

export interface ClaimOptions {
  /** Performs the exchange. Injected so this is testable without a browser. */
  claim: (token: string) => Promise<{ user: { id: string } }>;
  /** Attempts before giving up, covering a reload racing the request. */
  attempts?: number;
  /** Injected in tests so retries do not actually wait. */
  delay?: (ms: number) => Promise<void>;
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Exchanges a token for a session, retrying transient failures.
 *
 * Returns what happened; the caller decides what to remove from the URL, so
 * this function stays free of browser globals.
 */
export async function claimAccessToken(
  token: string | null,
  options: ClaimOptions,
): Promise<ClaimOutcome> {
  if (!token) return { kind: 'absent' };

  const attempts = options.attempts ?? 3;
  const delay = options.delay ?? wait;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const { user } = await options.claim(token);
      return { kind: 'claimed', userId: user.id };
    } catch (error) {
      // A rejection is final: retrying a token the server does not know will
      // never start working, and saying "try again" would be a lie.
      if (error instanceof ApiError && error.status === 401) {
        return { kind: 'rejected' };
      }
      if (attempt === attempts) return { kind: 'unreachable' };
      // Back off a little, mostly to let a reloading page settle.
      await delay(200 * attempt);
    }
  }

  return { kind: 'unreachable' };
}
