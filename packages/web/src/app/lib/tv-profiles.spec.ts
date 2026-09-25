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
    rememberProfile(storage, { username: 'ana', role: 'user', token: 'jwt-a' }, now);
    t = 2000;
    rememberProfile(storage, { username: 'ben', role: 'admin', token: 'jwt-b' }, now);
    t = 3000;
    const people = rememberProfile(
      storage,
      { username: 'ana', role: 'user', token: 'jwt-a2' },
      now,
    );
    expect(people.map((p) => p.username)).toEqual(['ana', 'ben']);
    // Re-remembering replaces the token (a refreshed JWT) and keeps one row.
    expect(people[0].token).toBe('jwt-a2');
    expect(loadProfiles(storage)).toEqual(people);
  });

  it('forget removes exactly that person', () => {
    const storage = memoryStorage();
    rememberProfile(storage, { username: 'ana', role: 'user', token: 'a' });
    rememberProfile(storage, { username: 'ben', role: 'user', token: 'b' });
    expect(forgetProfile(storage, 'ana').map((p) => p.username)).toEqual(['ben']);
  });

  it('survives corrupt storage contents', () => {
    const storage = memoryStorage();
    storage.setItem(TV_PROFILES_KEY, '{not json');
    expect(loadProfiles(storage)).toEqual([]);
    storage.setItem(
      TV_PROFILES_KEY,
      JSON.stringify([{ username: 'x' }, 7, { username: 'ok', role: 'user', token: 't' }]),
    );
    expect(loadProfiles(storage).map((p) => p.username)).toEqual(['ok']);
  });
});
