import type { Database } from 'bun:sqlite';

/**
 * Runtime control for the deployment-wide acquisition kill-switch (issue #235).
 *
 * why this exists: #235 shipped `config.acquisitionEnabled` as an **env-only**
 * flag, read once at boot and captured as a plain boolean by the gate
 * middleware, the auth route and the search route. Turning acquisition off
 * therefore meant editing the environment and restarting — which the issue left
 * open with the note that "boot-constructed services can't tear down live".
 *
 * That framing turned out to overstate the problem. The two unattended pollers
 * already re-check `isAcquisitionEnabled()` **on every tick**, so they self-
 * disable the moment the value changes; they only needed to be *started*
 * unconditionally so a runtime enable has something to wake up. What genuinely
 * had to change is the three capture sites, from `boolean` to `() => boolean`.
 * Nothing needs to be torn down.
 *
 * ## Precedence: env is a hard floor, not a default
 *
 * `NICOTIND_ACQUISITION=off` stays an absolute kill — an admin **cannot** turn
 * acquisition on from the UI on an install whose operator disabled it. The
 * runtime toggle can only ever turn it *off* relative to the environment. A
 * deployment that ships without slskd (the streaming-only compose profile) must
 * not be re-enablable by whoever happens to hold an admin account.
 */
export const ACQUISITION_SETTING_KEY = 'acquisition_enabled';

/** Pure precedence rule, so the asymmetry is testable on its own. */
export function resolveAcquisitionEnabled(envEnabled: boolean, stored: boolean | null): boolean {
  if (!envEnabled) return false; // hard floor
  return stored ?? true; // unset → on, matching the pre-#235 default
}

function readStored(db: Database): boolean | null {
  try {
    const row = db
      .query<{ value: string }, [string]>('SELECT value FROM app_settings WHERE key = ?')
      .get(ACQUISITION_SETTING_KEY);
    if (!row) return null;
    return row.value === '1' || row.value === 'true';
  } catch {
    // Schema-less DB (minimal test harness): fall back to the env decision.
    return null;
  }
}

/**
 * Live view of the kill-switch. `enabled()` is called per request and per poller
 * tick, so it must stay cheap — the read is a single indexed lookup on a table
 * that is already hot, and is deliberately **not** memoized: a stale cache here
 * would mean an admin turning acquisition off and the routes carrying on.
 */
export class AcquisitionToggle {
  constructor(
    private readonly db: Database,
    private readonly envEnabled: boolean,
  ) {}

  enabled(): boolean {
    return resolveAcquisitionEnabled(this.envEnabled, readStored(this.db));
  }

  /** True when the environment permits acquisition at all (governs the UI). */
  configurable(): boolean {
    return this.envEnabled;
  }

  /**
   * Persist an admin's choice. Returns the resulting effective value, which is
   * `false` regardless of `on` when the environment forbids acquisition.
   */
  set(on: boolean): boolean {
    this.db.run(
      `INSERT INTO app_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [ACQUISITION_SETTING_KEY, on ? '1' : '0'],
    );
    return this.enabled();
  }
}
