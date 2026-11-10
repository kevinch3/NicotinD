import { describe, expect, it } from 'vitest';
import { buildInviteLink, parseInviteToken } from './invite-link';

describe('parseInviteToken', () => {
  it('reads the fragment form', () => {
    expect(parseInviteToken('#t=abc_DEF-1')).toBe('abc_DEF-1');
  });
  it('falls back to the query form', () => {
    expect(parseInviteToken('', '?t=xyz')).toBe('xyz');
  });
  it('returns null when absent or empty', () => {
    expect(parseInviteToken('', '')).toBeNull();
    expect(parseInviteToken('#t=', '')).toBeNull();
    expect(parseInviteToken('#other=1', '')).toBeNull();
  });
});

describe('buildInviteLink', () => {
  it('prefers the first server base', () => {
    expect(
      buildInviteLink(['https://box.ts.net/', 'http://lan:8484'], '/invite#t=a', 'http://x'),
    ).toEqual({ link: 'https://box.ts.net/invite#t=a', localOnly: false });
  });
  it('falls back to this origin and flags it as local-only', () => {
    expect(buildInviteLink([], '/invite#t=a', 'http://127.0.0.1:8484')).toEqual({
      link: 'http://127.0.0.1:8484/invite#t=a',
      localOnly: true,
    });
  });
});
