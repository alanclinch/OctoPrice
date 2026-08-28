/**
 * What someone sees without a valid invite link.
 *
 * Deliberately plain and unhelpful about specifics: it does not say whether a
 * link ever existed, only that this one will not get you in.
 */

import type { JSX } from 'react';
import { Brand } from './Brand.tsx';

export function SignedOut({
  reason,
}: {
  reason: 'missing' | 'invalid' | 'unreachable';
}): JSX.Element {
  if (reason === 'unreachable') {
    return (
      <div className="card" style={{ marginTop: 32 }}>
        <Brand level={2} />
        <p>Could not reach the server to sign you in.</p>
        <p className="muted small">
          Your link is still good. Pull down to refresh, or open it again in a moment.
        </p>
        <button type="button" className="btn primary" onClick={() => window.location.reload()}>
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="card" style={{ marginTop: 32 }}>
      <Brand level={2} />
      <p>
        {reason === 'invalid'
          ? 'That link will not sign you in. It may have been replaced by a newer one.'
          : 'This app is shared by invitation.'}
      </p>
      <p className="muted small" style={{ marginBottom: 0 }}>
        Ask whoever set it up to send you a link. Opening it once signs this device in and you will
        not need to do it again.
      </p>
    </div>
  );
}
