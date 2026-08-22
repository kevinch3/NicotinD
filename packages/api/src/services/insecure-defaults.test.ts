import { describe, it, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  DOCKER_SOCKET,
  PLACEHOLDER_TOKEN,
  REMOVAL_RELEASE,
  findInsecureDefaults,
} from './insecure-defaults.js';

let db: Database;

function addonTable(): void {
  db.run(`CREATE TABLE addon_registrations (
    id TEXT PRIMARY KEY, url TEXT NOT NULL, token TEXT NOT NULL,
    manifest_json TEXT NOT NULL, added_at INTEGER NOT NULL, added_by TEXT NOT NULL
  )`);
}

function register(id: string, url: string, token: string): void {
  db.run('INSERT INTO addon_registrations VALUES (?, ?, ?, ?, ?, ?)', [
    id,
    url,
    token,
    '{}',
    0,
    'admin',
  ]);
}

const noSocket = { socketExists: () => false };

beforeEach(() => {
  db = new Database(':memory:');
});

describe('findInsecureDefaults', () => {
  it('says nothing when the deployment is configured properly', () => {
    addonTable();
    register('a', 'http://slskd-addon:8585', 'a-real-secret');
    expect(findInsecureDefaults(db, noSocket)).toEqual([]);
  });

  it('flags an addon actually REGISTERED with the placeholder token', () => {
    addonTable();
    register('a', 'http://slskd-addon:8585', PLACEHOLDER_TOKEN);
    register('b', 'http://ytdlp-addon:8586', 'fine');
    const found = findInsecureDefaults(db, noSocket);
    expect(found.map((f) => f.code)).toEqual(['addon-token-default']);
    // The URL is named so the operator knows which one to fix.
    expect(found[0]?.message).toContain('http://slskd-addon:8585');
    expect(found[0]?.message).not.toContain('http://ytdlp-addon:8586');
  });

  it('flags the docker socket when it is mounted', () => {
    addonTable();
    const found = findInsecureDefaults(db, { socketExists: (p) => p === DOCKER_SOCKET });
    expect(found.map((f) => f.code)).toEqual(['docker-socket-mounted']);
  });

  it('names the release each default goes away in', () => {
    addonTable();
    register('a', 'http://x', PLACEHOLDER_TOKEN);
    const found = findInsecureDefaults(db, { socketExists: () => true });
    expect(found).toHaveLength(2);
    // A deprecation notice without a deadline is a suggestion.
    for (const f of found) expect(f.message).toContain(REMOVAL_RELEASE);
  });

  it('reports the token before the socket', () => {
    addonTable();
    register('a', 'http://x', PLACEHOLDER_TOKEN);
    const found = findInsecureDefaults(db, { socketExists: () => true });
    // A placeholder credential is reachable by anything on the Docker network —
    // a lower bar than the RCE the socket escalates.
    expect(found.map((f) => f.code)).toEqual(['addon-token-default', 'docker-socket-mounted']);
  });

  it('survives a database with no addon_registrations table', () => {
    // A boot-time advisory must never be the thing that stops a boot.
    expect(() => findInsecureDefaults(db, noSocket)).not.toThrow();
    expect(findInsecureDefaults(db, noSocket)).toEqual([]);
  });
});
