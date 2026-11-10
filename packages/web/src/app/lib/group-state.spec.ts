import { describe, it, expect } from 'vitest';
import {
  GROUP_STATE_PREFIX,
  readGroupOpen,
  writeGroupOpen,
  clearGroupStates,
  revealSettingsGroup,
} from './group-state';

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

describe('group-state', () => {
  it('readGroupOpen returns null when nothing is stored', () => {
    const storage = memoryStorage();
    expect(readGroupOpen(storage, 'library-processing')).toBeNull();
  });

  it('readGroupOpen parses only "true"/"false"', () => {
    const storage = memoryStorage();
    storage.setItem(`${GROUP_STATE_PREFIX}g`, 'true');
    expect(readGroupOpen(storage, 'g')).toBe(true);
    storage.setItem(`${GROUP_STATE_PREFIX}g`, 'false');
    expect(readGroupOpen(storage, 'g')).toBe(false);
    storage.setItem(`${GROUP_STATE_PREFIX}g`, 'corrupt');
    expect(readGroupOpen(storage, 'g')).toBeNull();
  });

  it('writeGroupOpen persists under the group-state prefix', () => {
    const storage = memoryStorage();
    writeGroupOpen(storage, 'system-health', true);
    expect(storage.getItem(`${GROUP_STATE_PREFIX}system-health`)).toBe('true');
    writeGroupOpen(storage, 'system-health', false);
    expect(storage.getItem(`${GROUP_STATE_PREFIX}system-health`)).toBe('false');
  });

  it('clearGroupStates removes every group-state key and the legacy admin-group prefix', () => {
    const storage = memoryStorage();
    writeGroupOpen(storage, 'system-health', true);
    writeGroupOpen(storage, 'library-processing', false);
    storage.setItem('nicotind-admin-group-user-management', 'true');
    storage.setItem('nicotind_token', 'keep-me');
    storage.setItem('nicotind-theme', 'keep-me-too');

    clearGroupStates(storage);

    expect(storage.getItem(`${GROUP_STATE_PREFIX}system-health`)).toBeNull();
    expect(storage.getItem(`${GROUP_STATE_PREFIX}library-processing`)).toBeNull();
    expect(storage.getItem('nicotind-admin-group-user-management')).toBeNull();
    expect(storage.getItem('nicotind_token')).toBe('keep-me');
    expect(storage.getItem('nicotind-theme')).toBe('keep-me-too');
  });

  it('clearGroupStates is a no-op on an empty storage', () => {
    const storage = memoryStorage();
    expect(() => clearGroupStates(storage)).not.toThrow();
  });
});

describe('revealSettingsGroup', () => {
  function page(expanded: boolean) {
    const root = document.createElement('div');
    root.innerHTML = `<section data-group-id="email-delivery">
      <button data-testid="settings-group-toggle" aria-expanded="${expanded}"></button>
    </section>`;
    const toggle = root.querySelector('button')!;
    let clicks = 0;
    toggle.addEventListener('click', () => clicks++);
    return { root, clicks: () => clicks };
  }

  it('opens a collapsed group through its own toggle', () => {
    const p = page(false);
    expect(revealSettingsGroup('email-delivery', p.root)).toBe(true);
    expect(p.clicks()).toBe(1);
  });

  it('leaves an open group open', () => {
    const p = page(true);
    expect(revealSettingsGroup('email-delivery', p.root)).toBe(true);
    expect(p.clicks()).toBe(0);
  });

  it('says false when the group is not on the page', () => {
    expect(revealSettingsGroup('nope', page(false).root)).toBe(false);
  });
});
