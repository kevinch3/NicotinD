/**
 * Portable export/import of NicotinD's *configuration* — the state a rescan
 * can't reproduce. Distinct from the daily backup (`services/backup.ts`), which
 * snapshots the whole SQLite file including the library index: that's the
 * disaster-recovery artifact, this is the host-migration one.
 *
 * A table earns a place here only if its rows encode a **human decision or a
 * credential**. Everything the scanner rebuilds from disk is excluded by design.
 * See docs/config-export.md.
 */
import type { Database } from 'bun:sqlite';
import { createLogger } from '@nicotind/core';

const log = createLogger('config-export');

/** Bumped only on a breaking bundle-shape change; import refuses a higher one. */
export const CONFIG_BUNDLE_VERSION = 1;

export type ConfigSection =
  | 'app_settings'
  | 'plugins'
  | 'plugin_kv'
  | 'users'
  | 'user_settings'
  | 'playlists'
  | 'playlist_songs'
  | 'playlist_visibility'
  | 'watchlist'
  | 'library_genre_aliases'
  | 'library_genre_overrides'
  | 'library_artist_aliases'
  | 'library_artist_identity'
  | 'library_metadata_overrides';

type Row = Record<string, unknown>;

interface SectionSpec {
  /** Columns holding credentials; blanked unless the export opts into secrets. */
  secretColumns?: string[];
}

/**
 * Ordered: a section may only reference rows in a section before it, so a
 * sequential import never writes a dangling reference (users → user_settings →
 * playlists → playlist_songs). Conflict targets are read from the live schema
 * (`primaryKeyOf`), never hardcoded — five of the fourteen have a primary key
 * that doesn't match the obvious guess.
 */
export const CONFIG_SECTIONS: Record<ConfigSection, SectionSpec> = {
  app_settings: {},
  plugins: {},
  plugin_kv: { secretColumns: ['value'] },
  users: { secretColumns: ['password_hash'] },
  user_settings: {},
  playlists: {},
  playlist_songs: {},
  playlist_visibility: {},
  watchlist: {},
  library_genre_aliases: {},
  library_genre_overrides: {},
  library_artist_aliases: {},
  library_artist_identity: {},
  library_metadata_overrides: {},
};

export interface ConfigBundle {
  bundleVersion: number;
  generatedAt: number;
  /** Server version that produced it — advisory, never a gate. */
  appVersion?: string;
  /** False when credential columns were blanked out. */
  includesSecrets: boolean;
  sections: Partial<Record<ConfigSection, Row[]>>;
}

export interface SectionPlan {
  section: ConfigSection;
  create: number;
  update: number;
  /** Rows dropped because the table doesn't exist here, or every column is unknown. */
  skip: number;
  /** Columns present in the bundle but not in this install's schema. */
  unknownColumns: string[];
}

export interface ImportPlan {
  bundleVersion: number;
  generatedAt: number;
  appVersion?: string;
  includesSecrets: boolean;
  sections: SectionPlan[];
  /** Non-fatal problems worth showing before the user commits. */
  warnings: string[];
}

/** Column names of `table`, or null when the table doesn't exist. */
function columnsOf(db: Database, table: string): Set<string> | null {
  const rows = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
  return rows.length ? new Set(rows.map((r) => r.name)) : null;
}

/** Primary-key columns in declared order — the upsert's conflict target. */
function primaryKeyOf(db: Database, table: string): string[] {
  return db
    .query<{ name: string; pk: number }, []>(`PRAGMA table_info(${table})`)
    .all()
    .filter((r) => r.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((r) => r.name);
}

/**
 * Snapshot every config section. Reading the live schema (rather than a
 * hardcoded column list per table) means a migration that adds a column is
 * carried automatically and can never silently drop data on export.
 */
export function exportConfig(
  db: Database,
  opts: { includeSecrets?: boolean; appVersion?: string } = {},
): ConfigBundle {
  const includeSecrets = opts.includeSecrets ?? false;
  const sections: Partial<Record<ConfigSection, Row[]>> = {};

  for (const [name, spec] of Object.entries(CONFIG_SECTIONS) as [ConfigSection, SectionSpec][]) {
    if (!columnsOf(db, name)) continue;
    const rows = db.query<Row, []>(`SELECT * FROM ${name}`).all();
    if (!includeSecrets && spec.secretColumns) {
      for (const row of rows) {
        for (const col of spec.secretColumns) {
          if (col in row) row[col] = null;
        }
      }
    }
    sections[name] = rows;
  }

  return {
    bundleVersion: CONFIG_BUNDLE_VERSION,
    generatedAt: Date.now(),
    appVersion: opts.appVersion,
    includesSecrets: includeSecrets,
    sections,
  };
}

/** Structural validation. Returns an error string, or null when the bundle is usable. */
export function validateBundle(value: unknown): string | null {
  if (!value || typeof value !== 'object') return 'Bundle must be a JSON object';
  const b = value as Partial<ConfigBundle>;
  if (typeof b.bundleVersion !== 'number') return 'Missing bundleVersion';
  if (b.bundleVersion > CONFIG_BUNDLE_VERSION) {
    return `Bundle version ${b.bundleVersion} is newer than this server supports (${CONFIG_BUNDLE_VERSION}) — upgrade first`;
  }
  if (!b.sections || typeof b.sections !== 'object') return 'Missing sections';
  for (const [name, rows] of Object.entries(b.sections)) {
    if (!(name in CONFIG_SECTIONS)) return `Unknown section "${name}"`;
    if (!Array.isArray(rows)) return `Section "${name}" must be an array`;
  }
  return null;
}

/** Rows reduced to columns this install actually has, plus what was dropped. */
function reconcile(
  rows: Row[],
  cols: Set<string>,
): { usable: Row[]; unknownColumns: string[]; dropped: number } {
  const unknown = new Set<string>();
  const usable: Row[] = [];
  let dropped = 0;
  for (const row of rows) {
    const out: Row = {};
    for (const [k, v] of Object.entries(row)) {
      if (cols.has(k)) out[k] = v;
      else unknown.add(k);
    }
    if (Object.keys(out).length === 0) dropped++;
    else usable.push(out);
  }
  return { usable, unknownColumns: [...unknown], dropped };
}

/**
 * What an import would change, without changing it. Runs the same reconciliation
 * as `importConfig`, so the preview can't disagree with the apply.
 */
export function previewImport(db: Database, bundle: ConfigBundle): ImportPlan {
  const warnings: string[] = [];
  const sections: SectionPlan[] = [];

  if (!bundle.includesSecrets) {
    warnings.push(
      'This bundle was exported without secrets: plugin credentials and user passwords are blank and will be preserved from this install rather than overwritten.',
    );
  }

  for (const name of Object.keys(CONFIG_SECTIONS) as ConfigSection[]) {
    const rows = bundle.sections[name];
    if (!rows?.length) continue;

    const cols = columnsOf(db, name);
    if (!cols) {
      sections.push({ section: name, create: 0, update: 0, skip: rows.length, unknownColumns: [] });
      warnings.push(`Section "${name}" skipped — no such table on this install.`);
      continue;
    }

    const { usable, unknownColumns, dropped } = reconcile(rows, cols);
    if (unknownColumns.length) {
      warnings.push(`Section "${name}": ignoring unknown column(s) ${unknownColumns.join(', ')}.`);
    }

    const key = primaryKeyOf(db, name);
    if (key.length === 0) {
      sections.push({ section: name, create: 0, update: 0, skip: rows.length, unknownColumns });
      warnings.push(`Section "${name}" skipped — no primary key to match rows on.`);
      continue;
    }

    let create = 0;
    let update = 0;
    let skip = dropped;
    const where = key.map((k) => `${k} IS ?`).join(' AND ');
    const exists = db.query(`SELECT 1 FROM ${name} WHERE ${where} LIMIT 1`);
    for (const row of usable) {
      if (key.some((k) => !(k in row))) {
        skip++;
        continue;
      }
      if (exists.get(...key.map((k) => row[k] as string))) update++;
      else create++;
    }
    sections.push({ section: name, create, update, skip, unknownColumns });
  }

  return {
    bundleVersion: bundle.bundleVersion,
    generatedAt: bundle.generatedAt,
    appVersion: bundle.appVersion,
    includesSecrets: bundle.includesSecrets,
    sections,
    warnings,
  };
}

/**
 * Apply the bundle as an additive upsert — existing rows are updated, absent
 * ones created, and rows this install has that the bundle lacks are left alone.
 * Replace-semantics are deliberately not offered: a wrong-bundle import would
 * then delete the target's users and plugin credentials.
 *
 * Blanked secret columns (an export taken without secrets) are skipped on
 * update, so importing a redacted bundle never wipes working credentials.
 *
 * Whole-bundle transaction, but a row that violates a *different* constraint
 * than the conflict target (a bundle user whose username is already taken by a
 * different id on this install) is counted and skipped rather than aborting —
 * one collision must not cost the other thirteen sections.
 */
export function importConfig(db: Database, bundle: ConfigBundle): ImportPlan {
  const plan = previewImport(db, bundle);
  const byName = new Map(plan.sections.map((s) => [s.section, s]));

  db.transaction(() => {
    for (const [name, spec] of Object.entries(CONFIG_SECTIONS) as [ConfigSection, SectionSpec][]) {
      const rows = bundle.sections[name];
      if (!rows?.length) continue;
      const cols = columnsOf(db, name);
      if (!cols) continue;
      const key = primaryKeyOf(db, name);
      if (key.length === 0) continue;

      const { usable } = reconcile(rows, cols);
      const redacted = !bundle.includesSecrets ? (spec.secretColumns ?? []) : [];

      for (const row of usable) {
        if (key.some((k) => !(k in row))) continue;

        const insertCols = Object.keys(row);
        const updateCols = insertCols.filter(
          (c) => !key.includes(c) && !(redacted.includes(c) && row[c] == null),
        );
        const values = insertCols.map((c) => row[c] as string | number | null);

        const sql =
          `INSERT INTO ${name} (${insertCols.join(', ')}) ` +
          `VALUES (${insertCols.map(() => '?').join(', ')}) ` +
          `ON CONFLICT (${key.join(', ')}) DO ` +
          (updateCols.length
            ? `UPDATE SET ${updateCols.map((c) => `${c} = excluded.${c}`).join(', ')}`
            : 'NOTHING');
        try {
          db.run(sql, values);
        } catch (err) {
          const s = byName.get(name);
          if (s) {
            s.skip++;
            if (s.create > 0) s.create--;
            else if (s.update > 0) s.update--;
          }
          plan.warnings.push(
            `Section "${name}": a row conflicted with existing data and was skipped (${err instanceof Error ? err.message : String(err)}).`,
          );
        }
      }
    }
  })();

  log.info(
    { sections: plan.sections.length, includesSecrets: bundle.includesSecrets },
    'Configuration import applied',
  );
  return plan;
}
