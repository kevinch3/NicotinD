// Collapsible settings-group persistence, shared by SettingsGroupComponent
// and the signout path. Pure localStorage helpers (DI-free, unit-testable),
// mirroring lib/server-registry.ts's style: functions over a Storage slice
// rather than a service, so both call sites use one implementation.

export const GROUP_STATE_PREFIX = 'nicotind-group-';

/** Dead keys from the pre-rename Admin-only AdminGroupComponent — still
 * cleared on signout so a stale prefix never accumulates on a shared device. */
const LEGACY_ADMIN_GROUP_PREFIX = 'nicotind-admin-group-';

type ReadWriteStorage = Pick<Storage, 'getItem' | 'setItem'>;
type EnumerableStorage = Pick<Storage, 'length' | 'key' | 'removeItem'>;

/** Reads a group's persisted open/closed state. Only 'true'/'false' parse —
 * anything else (missing, corrupt) returns null so the caller falls back to
 * its own default. */
export function readGroupOpen(storage: ReadWriteStorage, id: string): boolean | null {
  try {
    const raw = storage.getItem(GROUP_STATE_PREFIX + id);
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return null;
  } catch {
    return null;
  }
}

export function writeGroupOpen(storage: ReadWriteStorage, id: string, open: boolean): void {
  try {
    storage.setItem(GROUP_STATE_PREFIX + id, String(open));
  } catch {
    // localStorage unavailable (private mode, disabled) — fall back silently.
  }
}

/** Removes every persisted group-open key (current + legacy prefix) — called
 * on signout so a shared device doesn't leak one user's collapse habits into
 * the next session. */
export function clearGroupStates(storage: EnumerableStorage): void {
  const keysToRemove: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key && (key.startsWith(GROUP_STATE_PREFIX) || key.startsWith(LEGACY_ADMIN_GROUP_PREFIX))) {
      keysToRemove.push(key);
    }
  }
  keysToRemove.forEach((key) => storage.removeItem(key));
}
