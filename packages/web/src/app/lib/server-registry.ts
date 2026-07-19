// Saved-servers registry + per-server session stash for the native shell.
// Pure localStorage helpers (DI-free, unit-testable): the native app can know
// several self-hosted servers, switch between them without retyping anything,
// and keep a signed-in session per server — switching away stashes the current
// JWT under the server's key, switching back restores it. No passwords are
// ever stored; the stash holds the same 30-day device JWT the app already
// keeps, scoped per server and cleared by an explicit sign-out.

export interface SavedServer {
  /** Canonical origin (normalizeServerUrl output) — the identity key. */
  url: string;
  /** Display name — the pairing payload's hostname, else the URL host. */
  name: string;
  lastUsedAt: number;
}

export interface StashedSession {
  token: string;
  username: string;
  role: string;
}

const SERVERS_KEY = 'nicotind_servers';
const STASH_PREFIX = 'nicotind_session::';

type StringStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function loadServers(storage: StringStorage): SavedServer[] {
  try {
    const parsed = JSON.parse(storage.getItem(SERVERS_KEY) ?? '[]') as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (s): s is SavedServer =>
          typeof s === 'object' &&
          s !== null &&
          typeof (s as SavedServer).url === 'string' &&
          !!(s as SavedServer).url,
      )
      .map((s) => ({
        url: s.url,
        name: typeof s.name === 'string' && s.name ? s.name : hostOf(s.url),
        lastUsedAt: typeof s.lastUsedAt === 'number' ? s.lastUsedAt : 0,
      }));
  } catch {
    return [];
  }
}

function persist(storage: StringStorage, servers: SavedServer[]): SavedServer[] {
  storage.setItem(SERVERS_KEY, JSON.stringify(servers));
  return servers;
}

/** Add or refresh a server entry (keyed by URL), bumping lastUsedAt. Most
 * recently used first. A provided name wins over a previously derived one. */
export function rememberServer(
  storage: StringStorage,
  entry: { url: string; name?: string },
  now = Date.now,
): SavedServer[] {
  const servers = loadServers(storage);
  const existing = servers.find((s) => s.url === entry.url);
  const updated: SavedServer = {
    url: entry.url,
    name: entry.name?.trim() || existing?.name || hostOf(entry.url),
    lastUsedAt: now(),
  };
  const rest = servers.filter((s) => s.url !== entry.url);
  return persist(storage, [updated, ...rest].sort((a, b) => b.lastUsedAt - a.lastUsedAt));
}

/** Remove a server and its stashed session. */
export function forgetServer(storage: StringStorage, url: string): SavedServer[] {
  clearStashedSession(storage, url);
  return persist(
    storage,
    loadServers(storage).filter((s) => s.url !== url),
  );
}

export function stashSession(storage: StringStorage, url: string, session: StashedSession): void {
  if (!url) return;
  storage.setItem(STASH_PREFIX + url, JSON.stringify(session));
}

export function readStashedSession(storage: StringStorage, url: string): StashedSession | null {
  try {
    const parsed = JSON.parse(storage.getItem(STASH_PREFIX + url) ?? 'null') as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as StashedSession).token === 'string' &&
      typeof (parsed as StashedSession).username === 'string'
    ) {
      return {
        token: (parsed as StashedSession).token,
        username: (parsed as StashedSession).username,
        role: typeof (parsed as StashedSession).role === 'string' ? (parsed as StashedSession).role : 'user',
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function clearStashedSession(storage: StringStorage, url: string): void {
  storage.removeItem(STASH_PREFIX + url);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
