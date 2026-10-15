import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import {
  listSubsonicKeys,
  mintSubsonicKey,
  revokeSubsonicKey,
  TooManySubsonicKeysError,
  verifySubsonicKey,
} from './subsonic-keys.js';

const db = new Database(':memory:');
applySchema(db);
db.run(
  "INSERT INTO users (id, username, password_hash, role) VALUES ('u1', 'ana', 'h', 'listener')",
);
db.run("INSERT INTO users (id, username, password_hash, role) VALUES ('u2', 'bo', 'h', 'admin')");

beforeEach(() => {
  db.run('DELETE FROM subsonic_api_keys');
  db.run("UPDATE users SET status = 'active'");
});

describe('subsonic API keys', () => {
  it('mints a prefixed key, stores only its hash, and verifies to the owner', () => {
    const { id, key } = mintSubsonicKey(db, 'u1', 'Music Assistant');
    expect(key.startsWith('nss_')).toBe(true);
    const stored = db
      .query<{ key_hash: string }, [string]>('SELECT key_hash FROM subsonic_api_keys WHERE id = ?')
      .get(id);
    expect(stored?.key_hash).not.toContain(key);
    expect(verifySubsonicKey(db, key)).toEqual({
      keyId: id,
      userId: 'u1',
      username: 'ana',
      role: 'listener',
    });
  });

  it('refuses unknown, malformed, revoked keys and disabled accounts', () => {
    expect(verifySubsonicKey(db, undefined)).toBeNull();
    expect(verifySubsonicKey(db, 'password')).toBeNull();
    expect(verifySubsonicKey(db, 'nss_nope')).toBeNull();

    const revoked = mintSubsonicKey(db, 'u1', 'old');
    expect(revokeSubsonicKey(db, 'u1', revoked.id)).toBe(true);
    expect(verifySubsonicKey(db, revoked.key)).toBeNull();

    const live = mintSubsonicKey(db, 'u1', 'live');
    db.run("UPDATE users SET status = 'disabled' WHERE id = 'u1'");
    expect(verifySubsonicKey(db, live.key)).toBeNull();
  });

  it('only lets the owner revoke, and lists only live keys', () => {
    const a = mintSubsonicKey(db, 'u1', 'a', 1);
    mintSubsonicKey(db, 'u1', 'b', 2);
    expect(revokeSubsonicKey(db, 'u2', a.id)).toBe(false);
    expect(listSubsonicKeys(db, 'u1').map((k) => k.name)).toEqual(['b', 'a']);
    revokeSubsonicKey(db, 'u1', a.id);
    expect(listSubsonicKeys(db, 'u1').map((k) => k.name)).toEqual(['b']);
    expect(listSubsonicKeys(db, 'u2')).toEqual([]);
  });

  it('touches last_used_at at most once a minute', () => {
    const { id, key } = mintSubsonicKey(db, 'u1', 'k');
    const lastUsed = () =>
      db
        .query<{ t: number | null }, [string]>(
          'SELECT last_used_at AS t FROM subsonic_api_keys WHERE id = ?',
        )
        .get(id)?.t;
    verifySubsonicKey(db, key, 1_000_000);
    expect(lastUsed()).toBe(1_000_000);
    verifySubsonicKey(db, key, 1_030_000);
    expect(lastUsed()).toBe(1_000_000);
    verifySubsonicKey(db, key, 1_061_000);
    expect(lastUsed()).toBe(1_061_000);
  });

  it('caps the active keys per user', () => {
    for (let i = 0; i < 20; i++) mintSubsonicKey(db, 'u2', `k${i}`);
    expect(() => mintSubsonicKey(db, 'u2', 'one too many')).toThrow(TooManySubsonicKeysError);
  });
});
