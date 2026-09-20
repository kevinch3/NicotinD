/**
 * The web `MaintenanceStatus.taskId` union is a hand-written mirror of
 * `MAINTENANCE_TASK_IDS`, duplicated deliberately (see the note above the
 * interface) rather than shared through core.
 *
 * A mirror nothing checks is a mirror that drifts, and this one already had:
 * `artwork-backfill` was registered as a task and shipped, but never reached
 * the web type, so a status response naming it did not typecheck on the client.
 * The union and the registry are in different packages with different
 * type-check surfaces, so nothing else was ever going to catch it.
 *
 * Asserts both directions against the server's own list — the denominator is
 * read from the registry, never restated here.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAINTENANCE_TASK_IDS } from './tasks.js';

const WEB_TYPES = join(import.meta.dir, '../../../../web/src/app/services/api/api-types.ts');

/** The `taskId:` union from `MaintenanceStatus`, as string literals. */
function webTaskIds(): string[] {
  const src = readFileSync(WEB_TYPES, 'utf-8');
  const iface = src.slice(src.indexOf('export interface MaintenanceStatus'));
  const line = iface.slice(0, iface.indexOf('}')).match(/^\s*taskId:\s*([^;]+);/m);
  if (!line) throw new Error('could not find MaintenanceStatus.taskId — has the shape changed?');
  return [...line[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
}

describe('MaintenanceStatus.taskId mirrors MAINTENANCE_TASK_IDS', () => {
  it('finds the union, so a silent parse failure cannot pass this suite', () => {
    // Fail on what the test cannot classify, rather than reporting an empty set
    // as agreement.
    expect(webTaskIds().length).toBeGreaterThan(0);
  });

  it('names every registered task', () => {
    const web = new Set(webTaskIds());
    const missing = MAINTENANCE_TASK_IDS.filter((id) => !web.has(id));
    expect(missing).toEqual([]);
  });

  it('names no task the server does not register', () => {
    const server = new Set<string>([...MAINTENANCE_TASK_IDS, 'null']);
    // `| null` is the idle case, not a task.
    const extra = webTaskIds().filter((id) => !server.has(id));
    expect(extra).toEqual([]);
  });
});
