/**
 * Remote-playback device identity (issue #882).
 *
 * The audio output is the <audio> element, which lives in the TAB — so the tab
 * is the device. The id is `<profileId>:<tabId>`: the profile half is shared by
 * every tab of the browser (it seeds the display name and survives logout), the
 * tab half is `sessionStorage` so a reload keeps its id and an active cast
 * survives the receiver refreshing.
 */

export type KeyValueStore = Pick<Storage, 'getItem' | 'setItem'>;

export const PROFILE_ID_KEY = 'nicotind_device_id';
export const TAB_ID_KEY = 'nicotind_tab_id';

export function mintId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return (
    Array.from({ length: 16 }, () =>
      Math.floor(Math.random() * 256)
        .toString(16)
        .padStart(2, '0'),
    ).join('') +
    '-' +
    Date.now().toString(36)
  );
}

function readOrMint(store: KeyValueStore, key: string): string {
  const stored = store.getItem(key);
  if (stored) return stored;
  const id = mintId();
  store.setItem(key, id);
  return id;
}

/** This tab's id, minted once per tab and kept in `sessionStorage` so it
 *  survives a reload. Shared by the playback device id and the presence
 *  heartbeat — they must agree on which tab they are talking about. */
export function resolveTabId(session: KeyValueStore): string {
  return readOrMint(session, TAB_ID_KEY);
}

export function deviceIdFor(profileId: string, tabId: string): string {
  return `${profileId}:${tabId}`;
}

export function resolveDeviceId(local: KeyValueStore, session: KeyValueStore): string {
  return deviceIdFor(readOrMint(local, PROFILE_ID_KEY), resolveTabId(session));
}

/** The browser half of a device id. A legacy profile-only id is its own
 *  profile, so an id minted before #882 still resolves. */
export function profileIdOf(deviceId: string): string {
  const cut = deviceId.lastIndexOf(':');
  return cut === -1 ? deviceId : deviceId.slice(0, cut);
}
