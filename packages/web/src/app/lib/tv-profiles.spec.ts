import { describe, it, expect } from 'vitest';
import { loadProfiles, rememberProfile, forgetProfile, TV_PROFILES_KEY } from './tv-profiles';

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

describe('tv profiles store', () => {
  it('remembers people most-recently-used first, keyed by username', () => {
    const storage = memoryStorage();
    let t = 1000;
    const now = () => t;
    rememberProfile(storage, 'http://a', { username: 'ana', role: 'user', token: 'jwt-a' }, now);
    t = 2000;
    rememberProfile(storage, 'http://a', { username: 'ben', role: 'admin', token: 'jwt-b' }, now);
    t = 3000;
    const people = rememberProfile(
      storage,
      'http://a',
      { username: 'ana', role: 'user', token: 'jwt-a2' },
      now,
    );
    expect(people.map((p) => p.username)).toEqual(['ana', 'ben']);
    // Re-remembering replaces the token (a refreshed JWT) and keeps one row.
    expect(people[0].token).toBe('jwt-a2');
    expect(loadProfiles(storage, 'http://a')).toEqual(people);
  });

  it('forget removes exactly that person', () => {
    const storage = memoryStorage();
    rememberProfile(storage, 'http://a', { username: 'ana', role: 'user', token: 'a' });
    rememberProfile(storage, 'http://a', { username: 'ben', role: 'user', token: 'b' });
    expect(forgetProfile(storage, 'http://a', 'ana').map((p) => p.username)).toEqual(['ben']);
  });

  it('survives corrupt storage contents', () => {
    const storage = memoryStorage();
    storage.setItem(`${TV_PROFILES_KEY}::http://a`, '{not json');
    expect(loadProfiles(storage, 'http://a')).toEqual([]);
    storage.setItem(
      `${TV_PROFILES_KEY}::http://a`,
      JSON.stringify([{ username: 'x' }, 7, { username: 'ok', role: 'user', token: 't' }]),
    );
    expect(loadProfiles(storage, 'http://a').map((p) => p.username)).toEqual(['ok']);
  });

  it("keeps each server's people apart, a bare install included", () => {
    const storage = memoryStorage();
    rememberProfile(storage, 'http://a', { username: 'ana', role: 'user', token: 'a' });
    rememberProfile(storage, 'http://b', { username: 'ben', role: 'user', token: 'b' });
    rememberProfile(storage, '', { username: 'cy', role: 'user', token: 'c' });
    expect(loadProfiles(storage, 'http://a').map((p) => p.username)).toEqual(['ana']);
    expect(loadProfiles(storage, 'http://b').map((p) => p.username)).toEqual(['ben']);
    expect(loadProfiles(storage, '').map((p) => p.username)).toEqual(['cy']);
    forgetProfile(storage, 'http://b', 'ana');
    expect(loadProfiles(storage, 'http://a').map((p) => p.username)).toEqual(['ana']);
  });
});
