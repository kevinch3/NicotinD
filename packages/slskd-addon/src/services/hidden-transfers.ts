import type { Database } from 'bun:sqlite';
import type { SlskdUserTransferGroup } from '@nicotind/slskd-client';
import { createLogger } from '@nicotind/core';

const log = createLogger('hidden-transfers');

/**
 * `hidden_transfers` is the local fallback for transfers slskd would not drop
 * from its own list. It is a fallback and not the mechanism: the clear/cancel
 * routes ask slskd to remove the transfer outright (`?remove=true`), and only
 * the ones slskd refuses — it removes nothing that is not already in a
 * `Completed` state, and an in-flight cancellation lands asynchronously — need
 * hiding at all. Left unpruned the table becomes a permanent ledger of things
 * that no longer exist (prod reached 19,845 rows to hide 11 directories).
 */
export interface HiddenTransferPlan {
  /** Hidden ids slskd no longer reports — the row is dead weight, drop it. */
  prune: string[];
  /**
   * Hidden ids slskd still reports in a completed state — the removal was
   * refused (or raced the cancellation) and can now succeed on a retry.
   */
  remove: Array<{ username: string; id: string }>;
}

function isCompleted(state: string): boolean {
  return state.startsWith('Completed,');
}

/**
 * Pure: diff the hidden-id ledger against slskd's live transfer list.
 *
 * An id absent from the live list is stale by definition — the transfer it
 * hides is gone, so the hide can go too. An id still present *and* completed
 * is a removal slskd can now honour, so it is worth re-asking rather than
 * hiding forever. An id present but still in flight is left strictly alone:
 * removing it would be a no-op and the hide is what is keeping it off screen.
 */
export function planHiddenTransferReconciliation(
  hiddenIds: Iterable<string>,
  groups: SlskdUserTransferGroup[],
): HiddenTransferPlan {
  const live = new Map<string, { username: string; state: string }>();
  for (const group of groups) {
    for (const dir of group.directories) {
      for (const file of dir.files) {
        live.set(file.id, { username: group.username, state: file.state });
      }
    }
  }

  const prune: string[] = [];
  const remove: Array<{ username: string; id: string }> = [];
  for (const id of hiddenIds) {
    const entry = live.get(id);
    if (!entry) {
      prune.push(id);
    } else if (isCompleted(entry.state)) {
      remove.push({ username: entry.username, id });
    }
  }

  return { prune, remove };
}

/** Drop hidden rows for transfers slskd no longer reports. Returns the count. */
export function pruneHiddenTransfers(db: Database, ids: string[]): number {
  if (ids.length === 0) return 0;
  const stmt = db.prepare('DELETE FROM hidden_transfers WHERE id = ?');
  const run = db.transaction((batch: string[]) => {
    for (const id of batch) stmt.run(id);
  });
  run(ids);
  return ids.length;
}

interface TransfersLike {
  getDownloads(): Promise<SlskdUserTransferGroup[]>;
  cancel(username: string, id: string, opts?: { remove?: boolean }): Promise<void>;
}

/**
 * Boot-time reconciliation: re-ask slskd to remove the completed transfers it
 * still lists but we are hiding, then prune every hidden id it no longer
 * reports. Self-healing across restarts, which is what mops up the in-flight
 * cancellations whose removal raced at clear time. Best-effort throughout —
 * an unreachable slskd must never block startup.
 */
export async function reconcileHiddenTransfers(
  db: Database,
  transfers: TransfersLike,
): Promise<{ pruned: number; removed: number }> {
  const hidden = db.query('SELECT id FROM hidden_transfers').all() as Array<{ id: string }>;
  if (hidden.length === 0) return { pruned: 0, removed: 0 };

  let groups: SlskdUserTransferGroup[];
  try {
    groups = await transfers.getDownloads();
  } catch {
    return { pruned: 0, removed: 0 };
  }

  const plan = planHiddenTransferReconciliation(
    hidden.map((h) => h.id),
    groups,
  );

  let removed = 0;
  for (const { username, id } of plan.remove) {
    try {
      await transfers.cancel(username, id, { remove: true });
      removed++;
    } catch {
      // slskd may refuse; the hide stays and the next boot retries.
    }
  }

  // Removals above leave their ids absent from the *next* fetch, not this one,
  // so they are pruned on the following reconciliation rather than here.
  const pruned = pruneHiddenTransfers(db, plan.prune);
  if (pruned > 0 || removed > 0) {
    log.info({ pruned, removed, hidden: hidden.length }, 'reconciled hidden transfers');
  }
  return { pruned, removed };
}
