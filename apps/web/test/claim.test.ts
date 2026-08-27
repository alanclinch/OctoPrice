/**
 * Regression tests for the invite-claim flow.
 *
 * The bug these exist for: a device with an older service worker reloads the
 * page as the new worker takes control, which aborted the claim request. The
 * old code had already stripped the token from the URL and reported any
 * failure as an invalid link, so a perfectly good invite became unusable and
 * said so in the most misleading way possible.
 */

import { describe, expect, it, vi } from 'vitest';
import { claimAccessToken } from '../src/claim.ts';
import { ApiError } from '../src/api.ts';

const noDelay = async (): Promise<void> => {};

describe('claimAccessToken', () => {
  it('does nothing when there is no token', async () => {
    const claim = vi.fn();
    expect(await claimAccessToken(null, { claim, delay: noDelay })).toEqual({ kind: 'absent' });
    expect(claim).not.toHaveBeenCalled();
  });

  it('claims a good token', async () => {
    const claim = vi.fn().mockResolvedValue({});
    expect(await claimAccessToken('good', { claim, delay: noDelay })).toEqual({ kind: 'claimed' });
    expect(claim).toHaveBeenCalledWith('good');
  });

  it('treats a 401 as final and does not retry it', async () => {
    const claim = vi.fn().mockRejectedValue(new ApiError('nope', 401));
    expect(await claimAccessToken('bad', { claim, delay: noDelay })).toEqual({ kind: 'rejected' });
    expect(claim).toHaveBeenCalledTimes(1);
  });

  it('retries a network failure and succeeds', async () => {
    // Exactly the reported failure: the first attempt is aborted by the
    // page reloading under a new service worker.
    const claim = vi
      .fn()
      .mockRejectedValueOnce(new ApiError('Could not reach the OctoPrice server', 0))
      .mockResolvedValue({});

    expect(await claimAccessToken('good', { claim, delay: noDelay })).toEqual({ kind: 'claimed' });
    expect(claim).toHaveBeenCalledTimes(2);
  });

  it('reports an unreachable server rather than an invalid link', async () => {
    const claim = vi
      .fn()
      .mockRejectedValue(new ApiError('Could not reach the OctoPrice server', 0));
    const outcome = await claimAccessToken('good', { claim, delay: noDelay, attempts: 3 });

    expect(outcome).toEqual({ kind: 'unreachable' });
    expect(claim).toHaveBeenCalledTimes(3);
  });

  it('retries a server error too', async () => {
    const claim = vi.fn().mockRejectedValue(new ApiError('boom', 500));
    await claimAccessToken('good', { claim, delay: noDelay, attempts: 2 });
    expect(claim).toHaveBeenCalledTimes(2);
  });

  it('backs off between attempts', async () => {
    const delay = vi.fn().mockResolvedValue(undefined);
    const claim = vi.fn().mockRejectedValue(new ApiError('offline', 0));

    await claimAccessToken('good', { claim, delay, attempts: 3 });

    // Two waits for three attempts, and never after the last one.
    expect(delay).toHaveBeenCalledTimes(2);
  });
});
