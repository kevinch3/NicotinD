/**
 * A reopened installed iOS app silences the instance it replaces (#2074).
 *
 * iOS can keep a closed PWA's page alive and audible. Reopening the app then
 * starts a second instance beside it, and offline nothing reaches the first:
 * the playback socket is down. `BroadcastChannel` is same-origin and needs no
 * network, and never echoes to its sender — so hearing a launch means a newer
 * instance exists. See docs/web-ui.md "A reopened iOS app silences the old one".
 */
import { isStandaloneDisplay } from './install-prompt';
import { isAppleMobileUserAgent } from './platform';

export const INSTANCE_CHANNEL = 'nicotind_app_instance';

/** The slice of `BroadcastChannel` this uses. */
export interface InstanceChannel {
  postMessage(data: unknown): void;
  onmessage: ((event: MessageEvent) => void) | null;
}

/**
 * Only the installed iOS app: it has one window, so a second instance means
 * the first was closed. Browser tabs and desktop windows sit side by side on
 * purpose and must not pause each other.
 */
export function supersedesOlderInstances(
  win: {
    matchMedia?: (q: string) => { matches: boolean };
    navigator?: { standalone?: boolean; userAgent?: string; maxTouchPoints?: number };
  } = window,
): boolean {
  const nav = win.navigator;
  return (
    isAppleMobileUserAgent(nav?.userAgent ?? '', nav?.maxTouchPoints ?? 0) &&
    isStandaloneDisplay(win)
  );
}

/** Announce this launch; stand down when a newer one is heard. */
export function announceLaunch(opts: { channel: InstanceChannel; onSuperseded: () => void }): void {
  opts.channel.onmessage = ({ data }) => {
    if ((data as { kind?: unknown } | null)?.kind === 'launched') opts.onSuperseded();
  };
  opts.channel.postMessage({ kind: 'launched' });
}
