import { describe, expect, it } from 'vitest';
import { tabForUser } from '../src/App.tsx';

describe('protected tab navigation', () => {
  it('falls back to prices for non-owners instead of rendering a blank page', () => {
    expect(tabForUser('forecast', false)).toBe('prices');
    expect(tabForUser('people', false)).toBe('prices');
  });

  it('keeps public tabs and owner tabs unchanged when permitted', () => {
    expect(tabForUser('settings', false)).toBe('settings');
    expect(tabForUser('forecast', true)).toBe('forecast');
    expect(tabForUser('people', true)).toBe('people');
  });
});
