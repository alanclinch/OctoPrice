import { describe, expect, it } from 'vitest';
import { buildInviteMessage } from '../src/components/PeopleView.tsx';

describe('friend invitation message', () => {
  it('explains the app, notifications, default region and preserves the private link', () => {
    const link = 'https://example.test/?invite=private-token';
    const message = buildInviteMessage('Jamie', link, true);

    expect(message).toContain('Hi Jamie');
    expect(message).toContain('Octopus Agile electricity prices');
    expect(message).toContain('can notify you');
    expect(message).toContain("tomorrow's Agile prices");
    expect(message).toContain('Southern Scotland');
    expect(message).toContain('Confirm it');
    expect(message).toContain(link);
  });

  it('does not claim a reissued link resets an existing person’s settings', () => {
    const message = buildInviteMessage('Jamie', 'https://example.test/reissued', false);

    expect(message).toContain('existing region and alert settings are unchanged');
    expect(message).not.toContain('Southern Scotland');
  });
});
