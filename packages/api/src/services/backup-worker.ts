/**
 * Worker body for `snapshotDatabase`: `VACUUM INTO` on its own read-only
 * connection, so the copy runs off the main thread (#1313). A read-only
 * connection is enough — VACUUM INTO only reads the source.
 */
import { Database } from 'bun:sqlite';

declare const self: Worker;

self.onmessage = (event: MessageEvent<{ dbPath: string; target: string }>) => {
  const { dbPath, target } = event.data;
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      db.run('VACUUM INTO ?', [target]);
    } finally {
      db.close();
    }
    postMessage({ ok: true });
  } catch (err) {
    postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
