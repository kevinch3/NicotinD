// The people a TV knows (#1406). Pure localStorage helpers modelled on the
// server-registry session stash: no DI, unit-tested against a memory storage.
// The ACTIVE session keeps living in nicotind_token/username/role; this is the
// list the switcher reads, the active person included.

export interface TvProfile {
  username: string;
  role: string;
  /** The same 30-day device JWT the app already keeps, one per person. */
  token: string;
  lastUsedAt: number;
}

export const TV_PROFILES_KEY = 'nicotind_tv_profiles';

type StringStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function loadProfiles(storage: StringStorage): TvProfile[] {
  try {
    const parsed = JSON.parse(storage.getItem(TV_PROFILES_KEY) ?? '[]') as unknown;
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

function persist(storage: StringStorage, people: TvProfile[]): TvProfile[] {
  storage.setItem(TV_PROFILES_KEY, JSON.stringify(people));
  return people;
}

/** Upsert by username, bumping lastUsedAt. Most recently used first. */
export function rememberProfile(
  storage: StringStorage,
  profile: Omit<TvProfile, 'lastUsedAt'>,
  now = Date.now,
): TvProfile[] {
  const rest = loadProfiles(storage).filter((p) => p.username !== profile.username);
  return persist(
    storage,
    [{ ...profile, lastUsedAt: now() }, ...rest].sort((a, b) => b.lastUsedAt - a.lastUsedAt),
  );
}

export function forgetProfile(storage: StringStorage, username: string): TvProfile[] {
  return persist(
    storage,
    loadProfiles(storage).filter((p) => p.username !== username),
  );
}
