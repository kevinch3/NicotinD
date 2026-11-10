/**
 * Mail settings (docs/email-invitations.md, increment 3): the non-secret half in
 * `app_settings` under `mail` (JSON), the SMTP password under its own key
 * `mail_secret` so config export can leave it out (`CONFIG_SECTIONS.app_settings
 * .secretKeys`) and the API can stay write-only about it.
 *
 * ## Env pinning: presence wins, the whole block
 *
 * Same rule as the signup switch (`resolveRegistrationEnabled`): when
 * `NICOTIND_MAIL_TRANSPORT` is set, the environment *is* the mail config —
 * `NICOTIND_SMTP_*` fill it, defaults fill the rest, the stored settings are
 * ignored and the UI is read-only. Mixing a pinned transport with a host an
 * admin typed months ago is exactly the state nobody can reason about. Stored
 * settings are still kept, so removing the var restores them.
 *
 * `NICOTIND_PUBLIC_URL` is separate: it is where links point whether or not
 * mail is on, so it pins just that one field.
 */
import type { Database } from 'bun:sqlite';
import { MAIL_PRESET_IDS } from './presets.js';
import type { SmtpConfig } from './smtp.js';

export const MAIL_SETTINGS_KEY = 'mail';
export const MAIL_SECRET_KEY = 'mail_secret';

/** What an admin can choose. `outbox` is env-only (tests and e2e). */
export type MailTransportSetting = 'off' | 'smtp';
export type MailTransportKind = MailTransportSetting | 'outbox';

export interface MailSettings {
  transport: MailTransportSetting;
  presetId: string;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  fromAddress: string;
  fromName: string;
  /** Base for every link the server hands out; '' = derive (Funnel, request origin). */
  publicUrl: string;
  dailyCap: number;
}

export interface EffectiveMailSettings extends Omit<MailSettings, 'transport'> {
  transport: MailTransportKind;
}

export const DEFAULT_DAILY_CAP = 100;
export const MAX_DAILY_CAP = 10_000;

export const DEFAULT_MAIL_SETTINGS: MailSettings = {
  transport: 'off',
  presetId: 'custom',
  host: '',
  port: 587,
  secure: false,
  username: '',
  fromAddress: '',
  fromName: 'NicotinD',
  publicUrl: '',
  dailyCap: DEFAULT_DAILY_CAP,
};

/** Deliberately loose — one @, no spaces, a dot in the domain. The server decides the rest. */
const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;

export function looksLikeEmail(value: string): boolean {
  return value.length <= 254 && EMAIL_RE.test(value);
}

/** An absolute http(s) URL with no query or fragment, trailing slash removed; null if not one. */
export function normalizePublicUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.search || url.hash || url.username || url.password) return null;
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

export interface MailEnv {
  /** Set ⇒ the whole mail config is env-pinned. */
  pinned: Omit<EffectiveMailSettings, 'publicUrl'> | null;
  /** `NICOTIND_SMTP_PASSWORD`; used only while `pinned`. */
  password: string;
  /** `NICOTIND_PUBLIC_URL`, normalized; null when unset or not a URL. */
  publicUrl: string | null;
}

function parseTransportEnv(raw: string | undefined): MailTransportKind | undefined {
  const v = raw?.trim().toLowerCase();
  return v === 'off' || v === 'smtp' || v === 'outbox' ? v : undefined;
}

function parseBool(raw: string | undefined): boolean | undefined {
  const v = raw?.trim().toLowerCase();
  if (v === undefined) return undefined;
  if (['true', '1', 'yes', 'on'].includes(v)) return true;
  if (['false', '0', 'no', 'off'].includes(v)) return false;
  return undefined;
}

/**
 * The env half. An unparseable `NICOTIND_MAIL_TRANSPORT` pins nothing — the same
 * call as `readRegistrationEnv`: guessing would silently lock the card over a typo.
 */
export function readMailEnv(env: Record<string, string | undefined> = process.env): MailEnv {
  const publicUrl = env.NICOTIND_PUBLIC_URL ? normalizePublicUrl(env.NICOTIND_PUBLIC_URL) : null;
  const transport = parseTransportEnv(env.NICOTIND_MAIL_TRANSPORT);
  if (!transport) return { pinned: null, publicUrl, password: '' };
  const rawPort = Number(env.NICOTIND_SMTP_PORT);
  const port =
    Number.isInteger(rawPort) && rawPort >= 1 && rawPort <= 65535
      ? rawPort
      : DEFAULT_MAIL_SETTINGS.port;
  const from = env.NICOTIND_SMTP_FROM?.trim() ?? '';
  return {
    publicUrl,
    password: env.NICOTIND_SMTP_PASSWORD ?? '',
    pinned: {
      transport,
      presetId: 'custom',
      host: env.NICOTIND_SMTP_HOST?.trim() ?? '',
      port,
      secure: parseBool(env.NICOTIND_SMTP_SECURE) ?? port === 465,
      username: env.NICOTIND_SMTP_USER?.trim() ?? '',
      fromAddress: from,
      fromName: DEFAULT_MAIL_SETTINGS.fromName,
      dailyCap: DEFAULT_DAILY_CAP,
    },
  };
}

export type MailSettingsPatchResult =
  | { ok: true; settings: MailSettings; password: string | null | undefined }
  | { ok: false; code: 'VALIDATION_ERROR'; error: string };

const fail = (error: string): MailSettingsPatchResult => ({
  ok: false,
  code: 'VALIDATION_ERROR',
  error,
});

/**
 * Apply a PUT body onto the current settings and validate the result as a
 * whole. Pure. Absent fields keep their value; `password` absent keeps the
 * stored one (`undefined`), `''` clears it (`null`), anything else replaces it.
 */
export function applyMailSettingsPatch(
  current: MailSettings,
  input: Record<string, unknown>,
): MailSettingsPatchResult {
  const next: MailSettings = { ...current };
  const str = (key: string, max: number): string | null | undefined => {
    const v = input[key];
    if (v === undefined) return undefined;
    if (typeof v !== 'string' || v.length > max) return null;
    return v.trim();
  };

  if (input.transport !== undefined) {
    if (input.transport !== 'off' && input.transport !== 'smtp') {
      return fail('transport must be "off" or "smtp"');
    }
    next.transport = input.transport;
  }
  if (input.presetId !== undefined) {
    if (typeof input.presetId !== 'string' || !MAIL_PRESET_IDS.includes(input.presetId)) {
      return fail(`presetId must be one of ${MAIL_PRESET_IDS.join(', ')}`);
    }
    next.presetId = input.presetId;
  }
  const host = str('host', 253);
  if (host === null || (host && /\s/.test(host))) return fail('host must be a hostname');
  if (host !== undefined) next.host = host;
  if (input.port !== undefined) {
    const port = input.port;
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
      return fail('port must be an integer from 1 to 65535');
    }
    next.port = port;
  }
  if (input.secure !== undefined) {
    if (typeof input.secure !== 'boolean') return fail('secure must be a boolean');
    next.secure = input.secure;
  }
  const username = str('username', 254);
  if (username === null) return fail('username must be a string of at most 254 characters');
  if (username !== undefined) next.username = username;
  const fromAddress = str('fromAddress', 254);
  if (fromAddress === null || (fromAddress && !looksLikeEmail(fromAddress))) {
    return fail('fromAddress must be an email address');
  }
  if (fromAddress !== undefined) next.fromAddress = fromAddress;
  const fromName = str('fromName', 100);
  // CR/LF would let a display name write its own headers.
  if (fromName === null || (fromName && /[\r\n]/.test(fromName))) {
    return fail('fromName must be one line of at most 100 characters');
  }
  if (fromName !== undefined) next.fromName = fromName;
  const publicUrl = str('publicUrl', 2048);
  if (publicUrl === null) return fail('publicUrl must be an http(s) URL');
  if (publicUrl !== undefined) {
    if (publicUrl === '') next.publicUrl = '';
    else {
      const normalized = normalizePublicUrl(publicUrl);
      if (!normalized) return fail('publicUrl must be an http(s) URL with no query or fragment');
      next.publicUrl = normalized;
    }
  }
  if (input.dailyCap !== undefined) {
    const cap = input.dailyCap;
    if (typeof cap !== 'number' || !Number.isInteger(cap) || cap < 1 || cap > MAX_DAILY_CAP) {
      return fail(`dailyCap must be an integer from 1 to ${MAX_DAILY_CAP}`);
    }
    next.dailyCap = cap;
  }

  let password: string | null | undefined;
  if (input.password !== undefined) {
    if (typeof input.password !== 'string' || input.password.length > 1024) {
      return fail('password must be a string');
    }
    password = input.password === '' ? null : input.password;
  }

  if (next.transport === 'smtp') {
    if (!next.host) return fail('host is required to send through SMTP');
    if (!next.fromAddress) return fail('fromAddress is required to send through SMTP');
  }
  return { ok: true, settings: next, password };
}

function readStoredSettings(db: Database): MailSettings {
  try {
    const row = db
      .query<{ value: string }, [string]>('SELECT value FROM app_settings WHERE key = ?')
      .get(MAIL_SETTINGS_KEY);
    if (!row) return { ...DEFAULT_MAIL_SETTINGS };
    const parsed = JSON.parse(row.value) as Partial<MailSettings>;
    // Re-validated through the patch path, so a hand-edited row can't smuggle
    // in a value the API would have refused; a bad row falls back to defaults.
    const applied = applyMailSettingsPatch(
      { ...DEFAULT_MAIL_SETTINGS, transport: 'off' },
      parsed as Record<string, unknown>,
    );
    return applied.ok ? applied.settings : { ...DEFAULT_MAIL_SETTINGS };
  } catch {
    return { ...DEFAULT_MAIL_SETTINGS };
  }
}

function readStoredPassword(db: Database): string {
  try {
    return (
      db
        .query<{ value: string }, [string]>('SELECT value FROM app_settings WHERE key = ?')
        .get(MAIL_SECRET_KEY)?.value ?? ''
    );
  } catch {
    return '';
  }
}

/**
 * Live view of the mail config — read on every call, never cached, so a save in
 * Admin applies to the very next send (the `RegistrationToggle` posture).
 */
export class MailSettingsStore {
  constructor(
    private readonly db: Database,
    private readonly env: MailEnv = readMailEnv(),
  ) {}

  /** False when `NICOTIND_MAIL_TRANSPORT` pins the whole block. */
  configurable(): boolean {
    return this.env.pinned === null;
  }

  /** False when `NICOTIND_PUBLIC_URL` (or the mail pin) fixes the link base. */
  publicUrlConfigurable(): boolean {
    return this.configurable() && this.env.publicUrl === null;
  }

  /** What the admin saved, env or not. */
  stored(): MailSettings {
    return readStoredSettings(this.db);
  }

  /** What sending actually uses. */
  effective(): EffectiveMailSettings {
    const publicUrl = this.publicUrl() ?? '';
    if (this.env.pinned) return { ...this.env.pinned, publicUrl };
    return { ...this.stored(), publicUrl };
  }

  password(): string {
    return this.env.pinned ? this.env.password : readStoredPassword(this.db);
  }

  passwordSet(): boolean {
    return this.password() !== '';
  }

  /** The operator's link base: env, then the saved setting; null = derive it. */
  publicUrl(): string | null {
    if (this.env.publicUrl) return this.env.publicUrl;
    if (this.env.pinned) return null;
    return this.stored().publicUrl || null;
  }

  /** The SMTP transport's config, or null when the effective transport is not SMTP. */
  smtpConfig(): SmtpConfig | null {
    const s = this.effective();
    if (s.transport !== 'smtp') return null;
    return {
      host: s.host,
      port: s.port,
      secure: s.secure,
      username: s.username,
      password: this.password(),
      fromAddress: s.fromAddress,
      fromName: s.fromName,
    };
  }

  /**
   * Validate and persist an admin's PUT. The caller refuses it first when
   * `configurable()` is false; this does not re-check, so a test can still
   * seed stored settings under a pin.
   */
  update(input: Record<string, unknown>): MailSettingsPatchResult {
    const result = applyMailSettingsPatch(this.stored(), input);
    if (!result.ok) return result;
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO app_settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [MAIL_SETTINGS_KEY, JSON.stringify(result.settings)],
      );
      if (result.password === null) {
        this.db.run('DELETE FROM app_settings WHERE key = ?', [MAIL_SECRET_KEY]);
      } else if (result.password !== undefined) {
        this.db.run(
          `INSERT INTO app_settings (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          [MAIL_SECRET_KEY, result.password],
        );
      }
    })();
    return result;
  }
}
