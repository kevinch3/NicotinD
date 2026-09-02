/**
 * Tab-id collision guard (issue #882).
 *
 * "Duplicate tab" copies `sessionStorage`, so the copy boots holding the
 * original's tab id — two tabs, one device id, which is the bug this whole
 * change exists to fix. Same-origin tabs are exactly what `BroadcastChannel`
 * addresses: a channel never echoes to its sender, so hearing a claim for the
 * id you hold means a twin exists. The tab that hears "taken" is the one that
 * just announced, i.e. the newcomer — so the original keeps its id and any
 * cast pointed at it.
 */
import { mintId } from './device-id';

export const TAB_CHANNEL = 'nicotind_tab_id';

/** The slice of `BroadcastChannel` this guard uses. Typed as the real API
 *  hands it over — `MessageEvent`, not a narrowed shape — so the production
 *  call site needs no cast. */
export interface TabChannel {
  postMessage(data: unknown): void;
  onmessage: ((event: MessageEvent) => void) | null;
  close(): void;
}

type Notice = { kind: 'claim' | 'taken'; tabId: string };

function isNotice(data: unknown): data is Notice {
  const n = data as Notice | null;
  return !!n && (n.kind === 'claim' || n.kind === 'taken') && typeof n.tabId === 'string';
}

export function guardTabId(opts: {
  channel: TabChannel;
  tabId: string;
  persist: (tabId: string) => void;
  onRemint: (tabId: string) => void;
  mint?: () => string;
}): void {
  const { channel, persist, onRemint, mint = mintId } = opts;
  let mine = opts.tabId;

  channel.onmessage = ({ data }) => {
    if (!isNotice(data) || data.tabId !== mine) return;
    if (data.kind === 'claim') {
      channel.postMessage({ kind: 'taken', tabId: mine } satisfies Notice);
      return;
    }
    mine = mint();
    persist(mine);
    onRemint(mine);
    channel.postMessage({ kind: 'claim', tabId: mine } satisfies Notice);
  };

  channel.postMessage({ kind: 'claim', tabId: mine } satisfies Notice);
}
