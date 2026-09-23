import { beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { getUserPreferences, patchUserPreferences } from './user-preferences.js';

let db: Database;

function seedUser(id: string): void {
  db.run("INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, 'x', 'user')", [
    id,
    id,
  ]);
}

beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
  seedUser('u1');
});

describe('getUserPreferences', () => {
  it('is all-null (welcome not dismissed) for a user with no settings row', () => {
    expect(getUserPreferences(db, 'u1')).toEqual({
      homeView: null,
      theme: null,
      followSystemTheme: null,
      language: null,
      radioStrategy: null,
      welcomeDismissed: false,
    });
  });

  // The column predates this feature with a NOT NULL 'system' default that is
  // not a theme id: it means "never chosen", which is what null means here.
  it("reads the legacy theme default 'system' as null", () => {
    db.run('INSERT INTO user_settings (user_id) VALUES (?)', ['u1']);
    expect(getUserPreferences(db, 'u1').theme).toBeNull();
  });

  it('reads what the older per-key routes wrote (welcome, radio strategy)', () => {
    db.run(
      "INSERT INTO user_settings (user_id, welcome_dismissed, radio_strategy) VALUES ('u1', 1, 'similar')",
    );
    const prefs = getUserPreferences(db, 'u1');
    expect(prefs.welcomeDismissed).toBe(true);
    expect(prefs.radioStrategy).toBe('similar');
  });

  it('never returns a value the enumeration does not know (a hand-edited row)', () => {
    db.run(
      "INSERT INTO user_settings (user_id, theme, radio_strategy) VALUES ('u1', 'neon', 'wild')",
    );
    const prefs = getUserPreferences(db, 'u1');
    expect(prefs.theme).toBeNull();
    expect(prefs.radioStrategy).toBeNull();
  });
});

describe('patchUserPreferences', () => {
  it('creates the row on first write and returns the merged preferences', () => {
    const after = patchUserPreferences(db, 'u1', { homeView: 'shelves', theme: 'eink' });
    expect(after.homeView).toBe('shelves');
    expect(after.theme).toBe('eink');
    expect(after.language).toBeNull();
  });

  it('merges: a later patch of one key leaves the others alone', () => {
    patchUserPreferences(db, 'u1', { theme: 'forest', language: 'es', followSystemTheme: true });
    const after = patchUserPreferences(db, 'u1', { theme: 'oled' });
    expect(after).toMatchObject({ theme: 'oled', language: 'es', followSystemTheme: true });
  });

  it('writes the same columns the older routes read (welcome, radio strategy)', () => {
    patchUserPreferences(db, 'u1', { welcomeDismissed: true, radioStrategy: 'different' });
    const row = db
      .query<{ welcome_dismissed: number; radio_strategy: string }, [string]>(
        'SELECT welcome_dismissed, radio_strategy FROM user_settings WHERE user_id = ?',
      )
      .get('u1');
    expect(row).toEqual({ welcome_dismissed: 1, radio_strategy: 'different' });
  });

  it('does not touch the privacy consent column', () => {
    db.run("INSERT INTO user_settings (user_id, history_enabled) VALUES ('u1', 0)");
    patchUserPreferences(db, 'u1', { theme: 'oled' });
    const row = db
      .query<{ history_enabled: number }, [string]>(
        'SELECT history_enabled FROM user_settings WHERE user_id = ?',
      )
      .get('u1');
    expect(row?.history_enabled).toBe(0);
  });
});
