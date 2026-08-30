import type { Database } from 'bun:sqlite';

/**
 * Runtime control for public self-signup (issue #824 follow-up).
 *
 * #824 shipped `NICOTIND_REGISTRATION` as an env-only flag, captured as a plain
 * boolean at boot — closing signup meant editing the environment and recreating
 * the container. This adds the persisted half so an admin can flip it from
 * Admin → User Management with no restart.
 *
 * ## Precedence: presence wins, not value
 *
 * This deliberately does **not** copy the acquisition switch's asymmetric floor
 * (`off` pins, `on` still lets an admin restrict further). Here the env var is
 * authoritative *when present*, in either direction: an operator who pins the
 * value in compose gets exactly that value and a read-only control, and an
 * operator who leaves it unset hands the decision to the admin UI. One rule,
 * both directions, nothing to reason about at 3am.
 *
 * A stored choice is still written while the env forces a value, so removing the
 * var later restores what the admin actually asked for instead of silently
 * discarding it.
 */
export const REGISTRATION_SETTING_KEY = 'registration_enabled';

/** Pure precedence rule, so the asymmetry with acquisition is testable alone. */
export function resolveRegistrationEnabled(
  envValue: boolean | undefined,
  stored: boolean | null,
  configDefault: boolean,
): boolean {
  if (envValue !== undefined) return envValue; // env set → locked, either way
  return stored ?? configDefault;
}

/**
 * The env half of the decision. Returns `undefined` for absent **and** for an
 * unparseable value — guessing there would silently lock the UI control over a
 * typo. Mirrors `parseBooleanEnv` in `src/main.ts`; kept local so the service
 * stays self-contained and the spellings are testable without the entry point.
 */
export function readRegistrationEnv(
  env: Record<string, string | undefined> = process.env,
): boolean | undefined {
  const raw = env.NICOTIND_REGISTRATION;
  if (raw === undefined) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  return undefined;
}

function readStored(db: Database): boolean | null {
  try {
    const row = db
      .query<{ value: string }, [string]>('SELECT value FROM app_settings WHERE key = ?')
      .get(REGISTRATION_SETTING_KEY);
    if (!row) return null;
    return row.value === '1' || row.value === 'true';
  } catch {
    // Schema-less DB (minimal test harness): fall back to the config decision.
    return null;
  }
}

/**
 * Live view of the signup switch. `enabled()` is read per registration attempt
 * and per `/registration-status` poll, and is deliberately **not** memoized: a
 * stale cache would mean an admin closing signup and the route carrying on
 * accepting accounts.
 */
export class RegistrationToggle {
  constructor(
    private readonly db: Database,
    private readonly envValue: boolean | undefined,
    private readonly configDefault: boolean,
  ) {}

  enabled(): boolean {
    return resolveRegistrationEnabled(this.envValue, readStored(this.db), this.configDefault);
  }

  /** True when the environment leaves the decision to the UI (governs read-only). */
  configurable(): boolean {
    return this.envValue === undefined;
  }

  /**
   * Persist an admin's choice. Returns the resulting effective value, which is
   * the env value regardless of `on` when the environment pins it.
   */
  set(on: boolean): boolean {
    this.db.run(
      `INSERT INTO app_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [REGISTRATION_SETTING_KEY, on ? '1' : '0'],
    );
    return this.enabled();
  }
}
