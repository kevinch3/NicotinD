import {
  HELP_SHORTCUTS,
  SHORTCUTS,
  keyToAction,
  type ShortcutContext,
  type ShortcutKeyEvent,
} from './keyboard-shortcuts';

const DESKTOP: ShortcutContext = {
  tvBuild: false,
  tvPlayerRoute: false,
  textEntry: false,
  activatable: false,
};

function key(k: string, mods: Partial<ShortcutKeyEvent> = {}): ShortcutKeyEvent {
  return {
    key: k,
    code: k === ' ' ? 'Space' : undefined,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    ...mods,
  };
}

const idOf = (e: ShortcutKeyEvent, ctx: ShortcutContext = DESKTOP) =>
  keyToAction(e, ctx)?.id ?? null;

describe('keyToAction — the desktop vocabulary (#1296)', () => {
  it.each([
    [key(' '), 'togglePlay'],
    [key('k'), 'togglePlay'],
    [key('ArrowLeft'), 'seekBack'],
    [key('ArrowRight'), 'seekForward'],
    [key('ArrowLeft', { shiftKey: true }), 'prevTrack'],
    [key('ArrowRight', { shiftKey: true }), 'nextTrack'],
    [key('l'), 'like'],
    [key('L', { shiftKey: true }), 'like'],
    [key('r'), 'radio'],
    [key('n'), 'toggleNowPlaying'],
    [key('q'), 'queueTab'],
    [key('y'), 'lyricsTab'],
    [key('m'), 'vocalMute'],
    [key('/'), 'search'],
    [key('?', { shiftKey: true }), 'help'],
  ] as const)('%o → %s', (event, id) => {
    expect(idOf(event)).toBe(id);
  });

  it('seeks 5 s each way on desktop', () => {
    expect(keyToAction(key('ArrowLeft'), DESKTOP)?.seekSeconds).toBe(-5);
    expect(keyToAction(key('ArrowRight'), DESKTOP)?.seekSeconds).toBe(5);
  });

  it('leaves unmapped keys alone, including media keys (the media session owns them)', () => {
    for (const k of ['a', 'j', 'Enter', 'Tab', 'ArrowUp', 'MediaPlayPause', 'MediaTrackNext']) {
      expect(idOf(key(k))).toBeNull();
    }
  });

  it('never dispatches Escape — BackButtonService owns it through the shared stack', () => {
    expect(idOf(key('Escape'))).toBeNull();
  });

  it('never fires on a Ctrl/Meta/Alt chord (browser and OS shortcuts)', () => {
    for (const mod of ['ctrlKey', 'metaKey', 'altKey'] as const) {
      for (const k of [' ', 'l', 'n', 'r', '/', 'ArrowLeft', 'ArrowRight']) {
        expect(idOf(key(k, { [mod]: true }))).toBeNull();
      }
    }
  });

  it('never fires from a text field', () => {
    for (const k of [' ', 'l', 'r', '/', '?', 'ArrowLeft']) {
      expect(idOf(key(k), { ...DESKTOP, textEntry: true })).toBeNull();
    }
  });

  it('Space yields to a focused button, K does not', () => {
    const onButton = { ...DESKTOP, activatable: true };
    expect(idOf(key(' '), onButton)).toBeNull();
    expect(idOf(key('k'), onButton)).toBe('togglePlay');
  });

  it('skips a keypress something else already claimed', () => {
    expect(idOf(key('ArrowRight', { defaultPrevented: true }))).toBeNull();
  });

  it('a held key re-fires only the seeks', () => {
    expect(idOf(key('ArrowRight', { repeat: true }))).toBe('seekForward');
    expect(idOf(key(' ', { repeat: true }))).toBeNull();
    expect(idOf(key('l', { repeat: true }))).toBeNull();
  });
});

describe('keyToAction — the TV build', () => {
  const TV: ShortcutContext = { ...DESKTOP, tvBuild: true };

  it('is inert off the player route: the D-pad owns every key', () => {
    for (const k of [' ', 'k', 'l', 'n', '/', '?', 'ArrowLeft', 'ArrowRight']) {
      expect(idOf(key(k), TV)).toBeNull();
    }
  });

  it('seeks 10 s on the /player route, and nothing else fires there', () => {
    const player = { ...TV, tvPlayerRoute: true };
    expect(keyToAction(key('ArrowLeft'), player)?.seekSeconds).toBe(-10);
    expect(keyToAction(key('ArrowRight'), player)?.seekSeconds).toBe(10);
    expect(idOf(key(' '), player)).toBeNull();
    expect(idOf(key('ArrowRight', { shiftKey: true }), player)).toBeNull();
  });
});

describe('the shortcut table', () => {
  it('the help sheet lists every desktop entry and Escape, never the TV-only rows', () => {
    const listed = HELP_SHORTCUTS.map((s) => s.id);
    const desktop = SHORTCUTS.filter((s) => s.scope === 'desktop').map((s) => s.id);
    expect(listed).toEqual(expect.arrayContaining([...desktop, 'close']));
    expect(listed.some((id) => id.startsWith('tv'))).toBe(false);
  });

  it('no two in-scope entries match the same key', () => {
    const probes = [' ', 'k', 'l', 'r', 'n', 'q', 'y', 'm', '/', '?', 'ArrowLeft', 'ArrowRight'];
    for (const scope of ['desktop', 'tv-player'] as const) {
      for (const k of probes) {
        for (const shiftKey of [false, true]) {
          const hits = SHORTCUTS.filter((s) => s.scope === scope && s.match(key(k, { shiftKey })));
          expect(hits.length, `${scope} ${shiftKey ? 'Shift+' : ''}${k}`).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});
