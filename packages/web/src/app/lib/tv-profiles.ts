// The people a TV knows (#1406). Pure localStorage helpers modelled on the
// server-registry session stash: no DI, unit-tested against a memory storage.
// The ACTIVE session keeps living in nicotind_token/username/role; this is the
// list the switcher reads, the active person included. Keyed per server like
// the session stash: a JWT from one server is never offered to another.

export interface TvProfile {
  username: string;
  role: string;
  /** The same 30-day device JWT the app already keeps, one per person. */
  token: string;
  lastUsedAt: number;
}

export const TV_PROFILES_KEY = 'nicotind_tv_profiles';

type StringStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** `server` is the saved server URL; empty on a bare install. */
function keyFor(server: string): string {
  return `${TV_PROFILES_KEY}::${server}`;
}

export function loadProfiles(storage: StringStorage, server: string): TvProfile[] {
  try {
    const parsed = JSON.parse(storage.getItem(keyFor(server)) ?? '[]') as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (p): p is TvProfile =>
          typeof p === 'object' &&
          p !== null &&
          typeof (p as TvProfile).username === 'string' &&
          !!(p as TvProfile).username &&
          typeof (p as TvProfile).token === 'string' &&
          !!(p as TvProfile).token,
      )
      .map((p) => ({
        username: p.username,
        role: typeof p.role === 'string' && p.role ? p.role : 'user',
        token: p.token,
        lastUsedAt: typeof p.lastUsedAt === 'number' ? p.lastUsedAt : 0,
      }))
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  } catch {
    return [];
  }
}

function persist(storage: StringStorage, server: string, people: TvProfile[]): TvProfile[] {
  storage.setItem(keyFor(server), JSON.stringify(people));
  return people;
}

/** Upsert by username, bumping lastUsedAt. Most recently used first. */
export function rememberProfile(
  storage: StringStorage,
  server: string,
  profile: Omit<TvProfile, 'lastUsedAt'>,
  now = Date.now,
): TvProfile[] {
  const rest = loadProfiles(storage, server).filter((p) => p.username !== profile.username);
  return persist(
    storage,
    server,
    [{ ...profile, lastUsedAt: now() }, ...rest].sort((a, b) => b.lastUsedAt - a.lastUsedAt),
  );
}

export function forgetProfile(
  storage: StringStorage,
  server: string,
  username: string,
): TvProfile[] {
  return persist(
    storage,
    server,
    loadProfiles(storage, server).filter((p) => p.username !== username),
  );
}
