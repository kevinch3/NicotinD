import { describe, it, expect } from 'vitest';
import {
  loadServers,
  rememberServer,
  forgetServer,
  stashSession,
  readStashedSession,
  clearStashedSession,
} from './server-registry';

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

describe('server registry', () => {
  it('remembers servers most-recently-used first, keyed by URL', () => {
    const storage = memoryStorage();
    let t = 1000;
    const now = () => t;
    rememberServer(storage, { url: 'https://a.example', name: 'Home' }, now);
    t = 2000;
    rememberServer(storage, { url: 'https://b.example' }, now);
    t = 3000;
    const servers = rememberServer(storage, { url: 'https://a.example' }, now);
    expect(servers.map((s) => s.url)).toEqual(['https://a.example', 'https://b.example']);
    // Re-remembering without a name keeps the original; missing name falls back to host.
    expect(servers[0].name).toBe('Home');
    expect(servers[1].name).toBe('b.example');
    expect(loadServers(storage)).toEqual(servers);
  });

  it('forget removes the server and its stashed session', () => {
    const storage = memoryStorage();
    rememberServer(storage, { url: 'https://a.example' });
    stashSession(storage, 'https://a.example', { token: 'jwt', username: 'kev', role: 'admin' });
    const remaining = forgetServer(storage, 'https://a.example');
    expect(remaining).toEqual([]);
    expect(readStashedSession(storage, 'https://a.example')).toBeNull();
  });

  it('stash round-trips and clears', () => {
    const storage = memoryStorage();
    stashSession(storage, 'https://a.example', { token: 'jwt', username: 'kev', role: 'admin' });
    expect(readStashedSession(storage, 'https://a.example')).toEqual({
      token: 'jwt',
      username: 'kev',
      role: 'admin',
    });
    clearStashedSession(storage, 'https://a.example');
    expect(readStashedSession(storage, 'https://a.example')).toBeNull();
  });

  it('survives corrupt storage contents', () => {
    const storage = memoryStorage();
    storage.setItem('nicotind_servers', '{not json');
    expect(loadServers(storage)).toEqual([]);
    storage.setItem('nicotind_session::https://a.example', '42');
    expect(readStashedSession(storage, 'https://a.example')).toBeNull();
  });
});
