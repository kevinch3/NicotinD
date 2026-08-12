import type { Database } from 'bun:sqlite';
import { createLogger, type AddonManifest } from '@nicotind/core';

const log = createLogger('addon-store');

/** A registered remote addon: URL + outbound bearer + manifest snapshot. */
export interface AddonRegistration {
  id: string;
  url: string;
  token: string;
  manifest: AddonManifest;
  addedAt: number;
  addedBy: string;
}

interface Row {
  id: string;
  url: string;
  token: string;
  manifest_json: string;
  added_at: number;
  added_by: string;
}

export function listAddonRegistrations(db: Database): AddonRegistration[] {
  const rows = db.query<Row, []>(`SELECT * FROM addon_registrations ORDER BY added_at`).all();
  const regs: AddonRegistration[] = [];
  for (const row of rows) {
    try {
      regs.push({
        id: row.id,
        url: row.url,
        token: row.token,
        manifest: JSON.parse(row.manifest_json) as AddonManifest,
        addedAt: row.added_at,
        addedBy: row.added_by,
      });
    } catch {
      // A corrupt snapshot must never take the boot path down with it.
      log.warn({ id: row.id }, 'skipping addon registration with corrupt manifest_json');
    }
  }
  return regs;
}

export function saveAddonRegistration(db: Database, reg: AddonRegistration): void {
  db.run(
    `INSERT INTO addon_registrations (id, url, token, manifest_json, added_at, added_by)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       url = excluded.url, token = excluded.token,
       manifest_json = excluded.manifest_json,
       added_at = excluded.added_at, added_by = excluded.added_by`,
    [reg.id, reg.url, reg.token, JSON.stringify(reg.manifest), reg.addedAt, reg.addedBy],
  );
}

export function deleteAddonRegistration(db: Database, id: string): void {
  db.run(`DELETE FROM addon_registrations WHERE id = ?`, [id]);
}
