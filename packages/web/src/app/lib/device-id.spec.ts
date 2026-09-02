import { describe, expect, it } from 'vitest';
import { profileIdOf, resolveDeviceId } from './device-id';

/** A tab's two storages: `local` is shared across every tab of the profile,
 *  `session` belongs to this tab alone. */
function tab(local: Map<string, string>, session = new Map<string, string>()) {
  const asStorage = (m: Map<string, string>) => ({
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
  });
  return { local: asStorage(local), session: asStorage(session), session_: session };
}

describe('resolveDeviceId', () => {
  it('gives two tabs of one profile different ids', () => {
    const profile = new Map<string, string>();
    const a = resolveDeviceId(tab(profile).local, tab(profile).session);
    const b = resolveDeviceId(tab(profile).local, tab(profile).session);

    expect(a).not.toBe(b);
  });

  it('keeps both tabs under one profile id, so siblings are recognizable', () => {
    const profile = new Map<string, string>();
    const a = resolveDeviceId(tab(profile).local, tab(profile).session);
    const b = resolveDeviceId(tab(profile).local, tab(profile).session);

    expect(profileIdOf(a)).toBe(profileIdOf(b));
  });

  it('reuses the same id when one tab reloads, so a cast survives a refresh', () => {
    const profile = new Map<string, string>();
    const session = new Map<string, string>();
    const first = resolveDeviceId(tab(profile, session).local, tab(profile, session).session);
    const afterReload = resolveDeviceId(tab(profile, session).local, tab(profile, session).session);

    expect(afterReload).toBe(first);
  });

  it('adopts a pre-existing profile id, so an upgrade keeps the device name', () => {
    const profile = new Map<string, string>([['nicotind_device_id', 'legacy-profile-uuid']]);
    const id = resolveDeviceId(tab(profile).local, tab(profile).session);

    expect(profileIdOf(id)).toBe('legacy-profile-uuid');
  });
});

describe('profileIdOf', () => {
  it('returns a bare legacy id unchanged', () => {
    expect(profileIdOf('legacy-profile-uuid')).toBe('legacy-profile-uuid');
  });
});
