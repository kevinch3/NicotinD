import { beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../../db.js';
import { exportConfig } from '../config-export.js';
import {
  applyMailSettingsPatch,
  DEFAULT_MAIL_SETTINGS,
  MAIL_SECRET_KEY,
  MailSettingsStore,
  normalizePublicUrl,
  readMailEnv,
} from './settings.js';

let db: Database;
beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
});

const smtp = {
  transport: 'smtp',
  host: 'smtp.mailgun.org',
  port: 587,
  fromAddress: 'music@example.com',
};

describe('applyMailSettingsPatch', () => {
  it('starts off, with a cap of 100', () => {
    expect(DEFAULT_MAIL_SETTINGS).toMatchObject({ transport: 'off', dailyCap: 100, port: 587 });
  });

  it('merges a partial body onto the current settings', () => {
    const r = applyMailSettingsPatch(DEFAULT_MAIL_SETTINGS, { ...smtp, username: ' pm@ex.com ' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.settings).toMatchObject({ ...smtp, username: 'pm@ex.com', fromName: 'NicotinD' });
      expect(r.password).toBeUndefined();
    }
  });

  it.each([
    [{ port: 0 }],
    [{ port: 65536 }],
    [{ port: 25.5 }],
    [{ port: '587' }],
    [{ fromAddress: 'not-an-email' }],
    [{ fromAddress: 'a@b' }],
    [{ dailyCap: 0 }],
    [{ dailyCap: 10_001 }],
    [{ dailyCap: 1.5 }],
    [{ publicUrl: 'ftp://music.example.com' }],
    [{ publicUrl: 'music.example.com' }],
    [{ publicUrl: 'https://music.example.com/?q=1' }],
    [{ transport: 'outbox' }],
    [{ presetId: 'sendgrid-but-not-a-preset' }],
    [{ fromName: 'Evil\r\nBcc: everyone@example.com' }],
    [{ host: 'two words' }],
    [{ secure: 'yes' }],
  ])('refuses %p', (patch) => {
    const r = applyMailSettingsPatch(DEFAULT_MAIL_SETTINGS, patch);
    expect(r).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' });
  });

  it('accepts the bounds', () => {
    for (const patch of [{ port: 1 }, { port: 65535 }, { dailyCap: 1 }, { dailyCap: 10_000 }]) {
      expect(applyMailSettingsPatch(DEFAULT_MAIL_SETTINGS, patch).ok).toBe(true);
    }
  });

  it('requires a host and a From address before SMTP can be on', () => {
    expect(applyMailSettingsPatch(DEFAULT_MAIL_SETTINGS, { transport: 'smtp' }).ok).toBe(false);
    expect(
      applyMailSettingsPatch(DEFAULT_MAIL_SETTINGS, { transport: 'smtp', host: 'smtp.x.com' }).ok,
    ).toBe(false);
  });

  it('normalizes the public URL and lets an empty string clear it', () => {
    const set = applyMailSettingsPatch(DEFAULT_MAIL_SETTINGS, {
      publicUrl: ' https://music.example.com/ ',
    });
    expect(set.ok && set.settings.publicUrl).toBe('https://music.example.com');
    const cleared = applyMailSettingsPatch(
      { ...DEFAULT_MAIL_SETTINGS, publicUrl: 'https://x.example.com' },
      { publicUrl: '' },
    );
    expect(cleared.ok && cleared.settings.publicUrl).toBe('');
  });

  it('password: absent keeps, empty clears, a value replaces', () => {
    const keep = applyMailSettingsPatch(DEFAULT_MAIL_SETTINGS, {});
    const clear = applyMailSettingsPatch(DEFAULT_MAIL_SETTINGS, { password: '' });
    const set = applyMailSettingsPatch(DEFAULT_MAIL_SETTINGS, { password: 's3cret' });
    expect(keep.ok && keep.password).toBeUndefined();
    expect(clear.ok && clear.password).toBeNull();
    expect(set.ok && set.password).toBe('s3cret');
  });
});

describe('normalizePublicUrl', () => {
  it('keeps a sub-path deployment, drops the trailing slash', () => {
    expect(normalizePublicUrl('https://example.com/music/')).toBe('https://example.com/music');
  });
  it('refuses credentials in the URL', () => {
    expect(normalizePublicUrl('https://user:pw@example.com')).toBeNull();
  });
});

describe('readMailEnv', () => {
  it('pins nothing when NICOTIND_MAIL_TRANSPORT is absent or a typo', () => {
    expect(readMailEnv({}).pinned).toBeNull();
    expect(readMailEnv({ NICOTIND_MAIL_TRANSPORT: 'smpt' }).pinned).toBeNull();
  });

  it('pins the whole block from NICOTIND_SMTP_*', () => {
    const env = readMailEnv({
      NICOTIND_MAIL_TRANSPORT: 'SMTP',
      NICOTIND_SMTP_HOST: 'smtp.fastmail.com',
      NICOTIND_SMTP_PORT: '465',
      NICOTIND_SMTP_USER: 'me@fastmail.com',
      NICOTIND_SMTP_PASSWORD: 'app-pw',
      NICOTIND_SMTP_FROM: 'me@fastmail.com',
    });
    expect(env.pinned).toMatchObject({
      transport: 'smtp',
      host: 'smtp.fastmail.com',
      port: 465,
      secure: true, // implied by 465 when NICOTIND_SMTP_SECURE is unset
      username: 'me@fastmail.com',
      fromAddress: 'me@fastmail.com',
    });
    expect(env.password).toBe('app-pw');
  });

  it('NICOTIND_SMTP_SECURE overrides the port inference; a bad port falls back to 587', () => {
    const env = readMailEnv({
      NICOTIND_MAIL_TRANSPORT: 'smtp',
      NICOTIND_SMTP_PORT: 'nope',
      NICOTIND_SMTP_SECURE: 'true',
    });
    expect(env.pinned).toMatchObject({ port: 587, secure: true });
  });

  it('reads NICOTIND_PUBLIC_URL on its own, without pinning mail', () => {
    const env = readMailEnv({ NICOTIND_PUBLIC_URL: 'https://music.example.com/' });
    expect(env).toEqual({ pinned: null, publicUrl: 'https://music.example.com', password: '' });
  });
});

describe('MailSettingsStore', () => {
  it('persists non-secret fields under `mail` and the password under its own key', () => {
    const store = new MailSettingsStore(db, readMailEnv({}));
    expect(store.update({ ...smtp, password: 'hunter2' }).ok).toBe(true);
    const mailRow = db
      .query<{ value: string }, []>("SELECT value FROM app_settings WHERE key = 'mail'")
      .get()!;
    expect(mailRow.value).not.toContain('hunter2');
    expect(JSON.parse(mailRow.value)).toMatchObject(smtp);
    expect(store.password()).toBe('hunter2');
    expect(store.passwordSet()).toBe(true);
    expect(store.smtpConfig()).toMatchObject({ host: 'smtp.mailgun.org', password: 'hunter2' });
  });

  it('keeps the password when a save omits it, clears it on an empty string', () => {
    const store = new MailSettingsStore(db, readMailEnv({}));
    store.update({ ...smtp, password: 'hunter2' });
    store.update({ fromName: 'Den' });
    expect(store.password()).toBe('hunter2');
    store.update({ password: '' });
    expect(store.passwordSet()).toBe(false);
    expect(db.query('SELECT 1 FROM app_settings WHERE key = ?').get(MAIL_SECRET_KEY)).toBeNull();
  });

  it('under an env pin the environment is the config; stored settings are kept, not used', () => {
    new MailSettingsStore(db, readMailEnv({})).update({ ...smtp, password: 'stored-pw' });
    const pinned = new MailSettingsStore(
      db,
      readMailEnv({ NICOTIND_MAIL_TRANSPORT: 'outbox', NICOTIND_SMTP_FROM: 'ci@example.com' }),
    );
    expect(pinned.configurable()).toBe(false);
    expect(pinned.publicUrlConfigurable()).toBe(false);
    expect(pinned.effective()).toMatchObject({
      transport: 'outbox',
      host: '',
      fromAddress: 'ci@example.com',
    });
    expect(pinned.password()).toBe('');
    expect(pinned.stored()).toMatchObject(smtp);
  });

  it('public URL: NICOTIND_PUBLIC_URL, then the saved setting, then none', () => {
    const plain = new MailSettingsStore(db, readMailEnv({}));
    expect(plain.publicUrl()).toBeNull();
    plain.update({ publicUrl: 'https://saved.example.com' });
    expect(plain.publicUrl()).toBe('https://saved.example.com');
    const env = new MailSettingsStore(
      db,
      readMailEnv({ NICOTIND_PUBLIC_URL: 'https://env.example.com' }),
    );
    expect(env.publicUrl()).toBe('https://env.example.com');
    expect(env.configurable()).toBe(true);
    expect(env.publicUrlConfigurable()).toBe(false);
  });

  it('a hand-edited, invalid row falls back to defaults rather than sending with it', () => {
    db.run("INSERT INTO app_settings (key, value) VALUES ('mail', ?)", [
      JSON.stringify({ transport: 'smtp', port: 99999 }),
    ]);
    expect(new MailSettingsStore(db, readMailEnv({})).stored()).toEqual(DEFAULT_MAIL_SETTINGS);
  });
});

describe('config export', () => {
  it('leaves the SMTP password out unless secrets are opted in; the rest of mail travels', () => {
    new MailSettingsStore(db, readMailEnv({})).update({ ...smtp, password: 'hunter2' });
    const redacted = exportConfig(db);
    const keys = (redacted.sections.app_settings ?? []).map((r) => r.key);
    expect(keys).toContain('mail');
    expect(keys).not.toContain(MAIL_SECRET_KEY);
    expect(JSON.stringify(redacted)).not.toContain('hunter2');

    const full = exportConfig(db, { includeSecrets: true });
    expect(full.sections.app_settings).toContainEqual({ key: MAIL_SECRET_KEY, value: 'hunter2' });
  });
});
