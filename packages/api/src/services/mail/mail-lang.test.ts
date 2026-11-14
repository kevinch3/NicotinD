import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../../db.js';
import { mailLangOf, negotiateLang } from './mail-lang.js';

describe('negotiateLang', () => {
  it('matches a regional tag on its base language', () => {
    expect(negotiateLang('es-AR')).toBe('es');
    expect(negotiateLang('EN-gb')).toBe('en');
  });

  it('ranks by q-value, then by order, skipping languages without a catalog', () => {
    expect(negotiateLang('fr-FR,fr;q=0.9,es;q=0.8,en;q=0.7')).toBe('es');
    expect(negotiateLang('en;q=0.5,es;q=0.9')).toBe('es');
    expect(negotiateLang('de, es, en')).toBe('es');
  });

  it('ignores q=0 and gives null when nothing matches', () => {
    expect(negotiateLang('es;q=0, en;q=0.1')).toBe('en');
    expect(negotiateLang('fr, de')).toBeNull();
    expect(negotiateLang('')).toBeNull();
    expect(negotiateLang(undefined)).toBeNull();
  });
});

describe('mailLangOf', () => {
  it('saved language, then the request, then English', () => {
    const db = new Database(':memory:');
    applySchema(db);
    db.run("INSERT INTO users (id, username, password_hash, role) VALUES ('a', 'a', 'x', 'user')");
    db.run("INSERT INTO users (id, username, password_hash, role) VALUES ('b', 'b', 'x', 'user')");
    db.run("INSERT INTO user_settings (user_id, language) VALUES ('a', 'es')");
    expect(mailLangOf(db, 'a', 'en-US')).toBe('es');
    expect(mailLangOf(db, 'b', 'es-AR')).toBe('es');
    expect(mailLangOf(db, 'b', 'fr')).toBe('en');
    expect(mailLangOf(db, null, null)).toBe('en');
  });
});
