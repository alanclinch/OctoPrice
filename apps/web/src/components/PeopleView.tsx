/**
 * Who can use this installation.
 *
 * Owner-only. Each person gets a link; opening it once signs that device in
 * for good. There are no passwords to set or reset, which is the right shape
 * for sharing with family.
 *
 * A link is shown exactly once, when it is created or reissued, because only
 * its hash is stored. Losing one is not a problem: reissue, and the person's
 * rules and devices carry over untouched.
 */

import { useCallback, useEffect, useState } from 'react';
import type { JSX } from 'react';
import { api, type SessionUser } from '../api.ts';

interface IssuedLink {
  name: string;
  link: string;
}

export function PeopleView(): JSX.Element {
  const [people, setPeople] = useState<SessionUser[]>([]);
  const [name, setName] = useState('');
  const [issued, setIssued] = useState<IssuedLink | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const reload = useCallback(async () => {
    try {
      setPeople((await api.invites()).users);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load the list.');
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  };

  const invite = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!name.trim()) return;
    await run(async () => {
      const result = await api.createInvite(name.trim());
      setIssued({ name: result.user.name, link: result.link });
      setName('');
    });
  };

  const copy = async (link: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be refused; the link is on screen to copy by hand.
      setCopied(false);
    }
  };

  return (
    <>
      <div className="card">
        <h2>Invite someone</h2>
        <form onSubmit={(event) => void invite(event)}>
          <div className="field">
            <label htmlFor="person-name">Their name</label>
            <input
              id="person-name"
              type="text"
              value={name}
              placeholder="Mum"
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <button type="submit" className="btn primary" disabled={busy || !name.trim()}>
            {busy ? 'Creating…' : 'Create a link'}
          </button>
        </form>

        {issued && (
          <div className="issued-link">
            <p className="small" style={{ marginTop: 14, marginBottom: 6 }}>
              <strong>{issued.name}</strong>&rsquo;s link. Send it to them now — it is not shown
              again.
            </p>
            <code className="link-box">{issued.link}</code>
            <div className="btn-row" style={{ marginTop: 8 }}>
              <button type="button" className="btn" onClick={() => void copy(issued.link)}>
                {copied ? 'Copied' : 'Copy link'}
              </button>
              <button type="button" className="btn" onClick={() => setIssued(null)}>
                Done
              </button>
            </div>
          </div>
        )}

        {error && <p className="error">{error}</p>}
      </div>

      <div className="card">
        <h2>People</h2>
        {people.map((person) => (
          <div key={person.id} className="rule">
            <div className="rule-name">
              {person.name}
              {person.isOwner && (
                <span className="pill" style={{ marginLeft: 8 }}>
                  You
                </span>
              )}
            </div>
            <div className="rule-detail">
              {!person.hasLink
                ? 'No link issued yet'
                : person.claimedAt
                  ? `Signed in ${new Date(person.claimedAt).toLocaleDateString('en-GB')}`
                  : 'Link sent, not used yet'}
            </div>
            {!person.isOwner && (
              <div className="btn-row" style={{ marginTop: 8 }}>
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const result = await api.reissueLink(person.id);
                      setIssued({ name: result.user.name, link: result.link });
                    })
                  }
                >
                  New link
                </button>
                <button
                  type="button"
                  className="btn danger"
                  disabled={busy}
                  onClick={() => {
                    if (!confirm(`Remove ${person.name} and everything they have set up?`)) return;
                    void run(() => api.removeInvite(person.id));
                  }}
                >
                  Remove
                </button>
              </div>
            )}
          </div>
        ))}

        <p className="muted small">
          Everyone has their own region, their own alert rules and their own devices. Nobody can see
          or change anyone else&rsquo;s.
        </p>
      </div>
    </>
  );
}
