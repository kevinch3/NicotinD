import { describe, expect, it } from 'vitest';
import { guardTabId, type TabChannel } from './tab-id-guard';

/** A BroadcastChannel bus: a message reaches every port EXCEPT its sender,
 *  which is what makes "I heard a claim for my own id" mean "I have a twin". */
function bus() {
  const ports: { deliver: (data: unknown) => void }[] = [];
  return {
    port(): TabChannel {
      const self = {
        onmessage: null as ((e: MessageEvent) => void) | null,
        postMessage(data: unknown) {
          for (const p of ports) if (p !== entry) p.deliver(data);
        },
        close() {},
      };
      const entry = { deliver: (data: unknown) => self.onmessage?.({ data } as MessageEvent) };
      ports.push(entry);
      return self;
    },
  };
}

/** One tab. `ids` is the mint queue so the test can name what it gets. */
function tab(b: ReturnType<typeof bus>, tabId: string, ...ids: string[]) {
  const state = { tabId, persisted: [] as string[], reminted: [] as string[] };
  guardTabId({
    channel: b.port(),
    tabId,
    mint: () => ids.shift() ?? 'exhausted',
    persist: (id) => state.persisted.push(id),
    onRemint: (id) => {
      state.tabId = id;
      state.reminted.push(id);
    },
  });
  return state;
}

describe('guardTabId', () => {
  it('leaves a tab alone when no sibling claims its id', () => {
    const b = bus();
    const only = tab(b, 'tab-a');

    expect(only.reminted).toEqual([]);
  });

  it('leaves two tabs with distinct ids alone', () => {
    const b = bus();
    const first = tab(b, 'tab-a');
    const second = tab(b, 'tab-b');

    expect(first.reminted).toEqual([]);
    expect(second.reminted).toEqual([]);
  });

  it('re-mints the duplicated tab, not the original holding the session', () => {
    const b = bus();
    const original = tab(b, 'tab-a');
    const duplicate = tab(b, 'tab-a', 'tab-fresh');

    expect(original.reminted).toEqual([]);
    expect(duplicate.reminted).toEqual(['tab-fresh']);
  });

  it('persists the re-minted id so the duplicate keeps it across a reload', () => {
    const b = bus();
    tab(b, 'tab-a');
    const duplicate = tab(b, 'tab-a', 'tab-fresh');

    expect(duplicate.persisted).toEqual(['tab-fresh']);
  });

  it('settles: the re-minted claim does not bounce back off the original', () => {
    const b = bus();
    const original = tab(b, 'tab-a');
    const duplicate = tab(b, 'tab-a', 'tab-fresh', 'tab-again');

    expect(duplicate.reminted).toEqual(['tab-fresh']);
    expect(original.reminted).toEqual([]);
  });
});
