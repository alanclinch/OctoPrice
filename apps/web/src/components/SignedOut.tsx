/**
 * What someone sees without a valid invite link.
 *
 * Deliberately plain and unhelpful about specifics: it does not say whether a
 * link ever existed, only that this one will not get you in.
 */

import type { JSX } from 'react';

export function SignedOut({ reason }: { reason: 'missing' | 'invalid' }): JSX.Element {
  return (
    <div className="card" style={{ marginTop: 32 }}>
      <h2>OctoPrice</h2>
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
