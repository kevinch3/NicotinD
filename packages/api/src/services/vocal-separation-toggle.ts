import type { Database } from 'bun:sqlite';

/**
 * Admin opt-in for ML vocal separation (issue #603), the `acquisition-toggle.ts`
 * shape with the opposite default.
 *
 * ## Precedence: the sidecar URL is a structural floor, and the default is OFF
 *
 * `configured` is "NICOTIND_SEPARATOR_URL is set" — without a sidecar there is
 * nothing to enable, so the toggle reads `false` whatever is stored and the UI
 * renders it read-only (`configurable: false`). With a sidecar the stored value
 * decides, and an unset row means **off**: separation is GPU work a household
 * instance may not want to spend, and the owner decided it is opt-in.
 */
export const VOCAL_SEPARATION_SETTING_KEY = 'vocal_separation_enabled';

/** Pure precedence rule, so the asymmetry is testable on its own. */
export function resolveVocalSeparationEnabled(
  configured: boolean,
  stored: boolean | null,
): boolean {
  if (!configured) return false; // structural floor
  return stored ?? false; // unset → off (opt-in)
}

function readStored(db: Database): boolean | null {
  try {
    const row = db
      .query<{ value: string }, [string]>('SELECT value FROM app_settings WHERE key = ?')
      .get(VOCAL_SEPARATION_SETTING_KEY);
    if (!row) return null;
    return row.value === '1' || row.value === 'true';
  } catch {
    // Schema-less DB (minimal test harness): fall back to the default.
    return null;
  }
}

/** Live view: read per request, never memoized, like the acquisition switch. */
export class VocalSeparationToggle {
  constructor(
    private readonly db: Database,
    private readonly configured: boolean,
  ) {}

  enabled(): boolean {
    return resolveVocalSeparationEnabled(this.configured, readStored(this.db));
  }

  /** True when a sidecar URL is configured at all (governs the UI). */
  configurable(): boolean {
    return this.configured;
  }

  /** Persist the admin's choice; returns the effective value. */
  set(on: boolean): boolean {
    this.db.run(
      `INSERT INTO app_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [VOCAL_SEPARATION_SETTING_KEY, on ? '1' : '0'],
    );
    return this.enabled();
  }
}
