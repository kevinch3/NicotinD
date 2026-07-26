import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import {
  CONFIG_BUNDLE_VERSION,
  CONFIG_SECTIONS,
  exportConfig,
  importConfig,
  previewImport,
  validateBundle,
  type ConfigBundle,
} from './config-export.js';

function freshDb(): Database {
  const db = new Database(':memory:');
  applySchema(db);
  return db;
}

function seed(db: Database): void {
  db.run(`INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?,?,?,?,?)`, [
    'u1',
    'admin',
    'hash-secret',
    'admin',
    1,
  ]);
  db.run(`INSERT INTO plugins (id, enabled) VALUES (?, ?)`, ['spotify', 1]);
  db.run(`INSERT INTO plugin_kv (plugin_id, key, value) VALUES (?,?,?)`, [
    'spotify',
    'clientSecret',
    'super-secret',
  ]);
  db.run(`INSERT INTO library_genre_aliases (alias, canonical, source, created_at) VALUES (?, ?, ?, ?)`, [
    'latinworld',
    'Latin',
    'user',
    1,
  ]);
}

describe('exportConfig', () => {
  it('captures config tables and redacts secrets by default', () => {
    const db = freshDb();
    seed(db);

    const bundle = exportConfig(db);

    expect(bundle.bundleVersion).toBe(CONFIG_BUNDLE_VERSION);
    expect(bundle.includesSecrets).toBe(false);
    expect(bundle.sections.users?.[0]?.['username']).toBe('admin');
    expect(bundle.sections.users?.[0]?.['password_hash']).toBeNull();
    expect(bundle.sections.plugin_kv?.[0]?.['value']).toBeNull();
    expect(bundle.sections.library_genre_aliases?.[0]?.['canonical']).toBe('Latin');
  });

  it('includes credentials when explicitly opted in', () => {
    const db = freshDb();
    seed(db);
    const bundle = exportConfig(db, { includeSecrets: true });
    expect(bundle.includesSecrets).toBe(true);
    expect(bundle.sections.users?.[0]?.['password_hash']).toBe('hash-secret');
    expect(bundle.sections.plugin_kv?.[0]?.['value']).toBe('super-secret');
  });

  it('never exports library tables a rescan can rebuild', () => {
    const db = freshDb();
    const exported = Object.keys(exportConfig(db).sections);
    expect(exported).not.toContain('library_songs');
    expect(exported).not.toContain('library_albums');
    expect(exported).not.toContain('library_artists');
    expect(exported).not.toContain('scan_cache');
  });
});

describe('validateBundle', () => {
  it('accepts a freshly exported bundle', () => {
    expect(validateBundle(exportConfig(freshDb()))).toBeNull();
  });

  it('refuses a bundle from a newer server', () => {
    const bundle = { ...exportConfig(freshDb()), bundleVersion: CONFIG_BUNDLE_VERSION + 1 };
    expect(validateBundle(bundle)).toMatch(/newer than this server supports/);
  });

  it('rejects unknown sections and non-objects', () => {
    expect(validateBundle({ bundleVersion: 1, sections: { library_songs: [] } })).toMatch(
      /Unknown section/,
    );
    expect(validateBundle('nope')).toMatch(/must be a JSON object/);
    expect(validateBundle({ bundleVersion: 1 })).toMatch(/Missing sections/);
  });
});

describe('previewImport', () => {
  it('reports creates without touching the target', () => {
    const source = freshDb();
    seed(source);
    const target = freshDb();

    const plan = previewImport(target, exportConfig(source, { includeSecrets: true }));
    const users = plan.sections.find((s) => s.section === 'users');

    expect(users).toMatchObject({ create: 1, update: 0, skip: 0 });
    expect(target.query(`SELECT COUNT(*) AS n FROM users`).get()).toMatchObject({ n: 0 });
  });

  it('reports updates for rows already present', () => {
    const source = freshDb();
    seed(source);
    const target = freshDb();
    seed(target);

    const plan = previewImport(target, exportConfig(source, { includeSecrets: true }));
    expect(plan.sections.find((s) => s.section === 'users')).toMatchObject({ create: 0, update: 1 });
  });

  it('drops columns this install does not have and says so', () => {
    const target = freshDb();
    const bundle: ConfigBundle = {
      bundleVersion: CONFIG_BUNDLE_VERSION,
      generatedAt: Date.now(),
      includesSecrets: true,
      sections: {
        library_genre_aliases: [
          { alias: 'x', canonical: 'X', source: 'user', created_at: 1, invented_column: 'boom' },
        ],
      },
    };

    const plan = previewImport(target, bundle);

    expect(plan.sections[0]?.unknownColumns).toEqual(['invented_column']);
    expect(plan.warnings.join(' ')).toMatch(/invented_column/);
  });

  it('warns that a redacted bundle will preserve local credentials', () => {
    const plan = previewImport(freshDb(), exportConfig(freshDb()));
    expect(plan.warnings.join(' ')).toMatch(/exported without secrets/);
  });
});

describe('importConfig', () => {
  it('round-trips a full config onto an empty install', () => {
    const source = freshDb();
    seed(source);
    const target = freshDb();

    importConfig(target, exportConfig(source, { includeSecrets: true }));

    expect(target.query(`SELECT * FROM users`).get()).toMatchObject({
      id: 'u1',
      username: 'admin',
      password_hash: 'hash-secret',
      role: 'admin',
    });
    expect(target.query(`SELECT * FROM plugin_kv`).get()).toMatchObject({
      value: 'super-secret',
    });
    expect(target.query(`SELECT * FROM library_genre_aliases`).get()).toMatchObject({
      canonical: 'Latin',
    });
  });

  it('is idempotent — importing twice changes nothing further', () => {
    const source = freshDb();
    seed(source);
    const target = freshDb();
    const bundle = exportConfig(source, { includeSecrets: true });

    importConfig(target, bundle);
    const first = target.query(`SELECT * FROM users`).all();
    importConfig(target, bundle);

    expect(target.query(`SELECT * FROM users`).all()).toEqual(first);
    expect(target.query(`SELECT COUNT(*) AS n FROM plugin_kv`).get()).toMatchObject({ n: 1 });
  });

  it('updates existing rows rather than duplicating them', () => {
    const source = freshDb();
    seed(source);
    source.run(`UPDATE library_genre_aliases SET canonical = ? WHERE alias = ?`, [
      'Latin Pop',
      'latinworld',
    ]);
    const target = freshDb();
    seed(target);

    importConfig(target, exportConfig(source, { includeSecrets: true }));

    expect(target.query(`SELECT COUNT(*) AS n FROM library_genre_aliases`).get()).toMatchObject({
      n: 1,
    });
    expect(target.query(`SELECT canonical FROM library_genre_aliases`).get()).toMatchObject({
      canonical: 'Latin Pop',
    });
  });

  it('a redacted bundle never wipes working credentials on the target', () => {
    const source = freshDb();
    seed(source);
    const target = freshDb();
    seed(target);
    target.run(`UPDATE plugin_kv SET value = ? WHERE plugin_id = ?`, ['live-secret', 'spotify']);

    importConfig(target, exportConfig(source)); // exported WITHOUT secrets

    expect(target.query(`SELECT value FROM plugin_kv`).get()).toMatchObject({
      value: 'live-secret',
    });
    expect(target.query(`SELECT password_hash FROM users`).get()).toMatchObject({
      password_hash: 'hash-secret',
    });
  });

  it('skips a row that collides on a non-key constraint without losing the rest', () => {
    const source = freshDb();
    seed(source);
    const target = freshDb();
    // Same username, different id — collides on the users.username UNIQUE index,
    // not on the `id` conflict target the upsert uses.
    target.run(`INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?,?,?,?,?)`, [
      'other-id',
      'admin',
      'other-hash',
      'admin',
      1,
    ]);

    const plan = importConfig(target, exportConfig(source, { includeSecrets: true }));

    expect(plan.warnings.join(' ')).toMatch(/conflicted with existing data/);
    // The unrelated section still landed.
    expect(target.query(`SELECT canonical FROM library_genre_aliases`).get()).toMatchObject({
      canonical: 'Latin',
    });
  });

  it('every declared section maps to a real table with a primary key', () => {
    const db = freshDb();
    for (const name of Object.keys(CONFIG_SECTIONS)) {
      const info = db.query<{ name: string; pk: number }, []>(`PRAGMA table_info(${name})`).all();
      expect(info.length, `${name} must exist`).toBeGreaterThan(0);
      expect(info.some((r) => r.pk > 0), `${name} needs a primary key`).toBe(true);
    }
  });
});
