import { Database } from 'bun:sqlite';

/**
 * What the runner already tried, so a daily schedule does not spend a model
 * call (or a search) on the same unresolvable album every day. Local to the
 * runner on purpose: it is the runner's memory, not library data.
 */
export class AttemptStore {
  private readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.run(`CREATE TABLE IF NOT EXISTS attempts (
      cluster TEXT PRIMARY KEY,
      outcome TEXT NOT NULL,
      at      INTEGER NOT NULL
    )`);
  }

  isCoolingDown(cluster: string, now: number, cooldownDays: number): boolean {
    const row = this.db
      .query<{ at: number }, [string]>('SELECT at FROM attempts WHERE cluster = ?')
      .get(cluster);
    return !!row && now - row.at < cooldownDays * 86_400_000;
  }

  record(cluster: string, outcome: string, now: number): void {
    this.db.run(
      `INSERT INTO attempts (cluster, outcome, at) VALUES (?, ?, ?)
       ON CONFLICT(cluster) DO UPDATE SET outcome = excluded.outcome, at = excluded.at`,
      [cluster, outcome, now],
    );
  }

  close(): void {
    this.db.close();
  }
}
