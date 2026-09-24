/**
 * The keyboard vocabulary (#1296) as one table: `KeyboardShortcutsService`
 * dispatches from it and the `?` sheet renders it, so the two cannot drift.
 * `keyToAction` is pure — the service reduces the DOM to `ShortcutContext`.
 * See docs/web-ui.md "Keyboard shortcuts".
 */

/** The subset of `KeyboardEvent` the mapping reads. */
export interface ShortcutKeyEvent {
  readonly key: string;
  readonly code?: string;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly repeat?: boolean;
  readonly defaultPrevented?: boolean;
}

export interface ShortcutContext {
  readonly tvBuild: boolean;
  /** TV only: the full-screen player is the active route (#438). */
  readonly tvPlayerRoute: boolean;
  /** Focus is in an input/textarea/select/contenteditable (`isTextEntryTarget`). */
  readonly textEntry: boolean;
  /** Focus is on something Space natively activates (button, link, role=button …). */
  readonly activatable: boolean;
}

export type ShortcutId =
  | 'togglePlay'
  | 'seekBack'
  | 'seekForward'
  | 'prevTrack'
  | 'nextTrack'
  | 'like'
  | 'radio'
  | 'toggleNowPlaying'
  | 'queueTab'
  | 'lyricsTab'
  | 'search'
  | 'vocalMute'
  | 'close'
  | 'help'
  | 'tvSeekBack'
  | 'tvSeekForward';

/**
 * - `desktop`: every non-TV build.
 * - `tv-player`: TV build, `/player` route only — the D-pad owns every other key there.
 * - `back-stack`: listed for the sheet only; `BackButtonService`'s Escape
 *   listener dispatches it through the shared `BackHandlerStack` (#398), which
 *   must keep working from inside a text field, where this table never fires.
 */
export type ShortcutScope = 'desktop' | 'tv-player' | 'back-stack';

export interface ShortcutEntry {
  readonly id: ShortcutId;
  /** Key caps as the help sheet shows them. */
  readonly keys: readonly string[];
  readonly labelKey: string;
  readonly scope: ShortcutScope;
  readonly match: (e: ShortcutKeyEvent) => boolean;
  /** Signed seek step for the seek entries. */
  readonly seekSeconds?: number;
  /** Whether a held key re-fires (seeking does; toggles must not flap). */
  readonly repeatable?: boolean;
  /** Space yields to a focused button's own activation. */
  readonly spaceYields?: boolean;
}

export const SEEK_STEP_SECONDS = 5;
/** The TV player's step, as docs/tv-ux.md's key table states it. */
export const TV_SEEK_STEP_SECONDS = 10;

const isSpace = (e: ShortcutKeyEvent): boolean => e.code === 'Space' || e.key === ' ';
const letter =
  (l: string) =>
  (e: ShortcutKeyEvent): boolean =>
    e.key.toLowerCase() === l;
const arrow =
  (key: 'ArrowLeft' | 'ArrowRight', shift: boolean) =>
  (e: ShortcutKeyEvent): boolean =>
    e.key === key && e.shiftKey === shift;

export const SHORTCUTS: readonly ShortcutEntry[] = [
  {
    id: 'togglePlay',
    keys: ['Space', 'K'],
    labelKey: 'shortcuts.togglePlay',
    scope: 'desktop',
    match: (e) => isSpace(e) || letter('k')(e),
    spaceYields: true,
  },
  {
    id: 'seekBack',
    keys: ['←'],
    labelKey: 'shortcuts.seekBack',
    scope: 'desktop',
    match: arrow('ArrowLeft', false),
    seekSeconds: -SEEK_STEP_SECONDS,
    repeatable: true,
  },
  {
    id: 'seekForward',
    keys: ['→'],
    labelKey: 'shortcuts.seekForward',
    scope: 'desktop',
    match: arrow('ArrowRight', false),
    seekSeconds: SEEK_STEP_SECONDS,
    repeatable: true,
  },
  {
    id: 'prevTrack',
    keys: ['Shift+←'],
    labelKey: 'shortcuts.prevTrack',
    scope: 'desktop',
    match: arrow('ArrowLeft', true),
  },
  {
    id: 'nextTrack',
    keys: ['Shift+→'],
    labelKey: 'shortcuts.nextTrack',
    scope: 'desktop',
    match: arrow('ArrowRight', true),
  },
  { id: 'like', keys: ['L'], labelKey: 'shortcuts.like', scope: 'desktop', match: letter('l') },
  { id: 'radio', keys: ['R'], labelKey: 'shortcuts.radio', scope: 'desktop', match: letter('r') },
  {
    id: 'toggleNowPlaying',
    keys: ['N'],
    labelKey: 'shortcuts.toggleNowPlaying',
    scope: 'desktop',
    match: letter('n'),
  },
  {
    id: 'queueTab',
    keys: ['Q'],
    labelKey: 'shortcuts.queueTab',
    scope: 'desktop',
    match: letter('q'),
  },
  {
    id: 'lyricsTab',
    keys: ['Y'],
    labelKey: 'shortcuts.lyricsTab',
    scope: 'desktop',
    match: letter('y'),
  },
  {
    id: 'vocalMute',
    keys: ['M'],
    labelKey: 'shortcuts.vocalMute',
    scope: 'desktop',
    match: letter('m'),
  },
  {
    id: 'search',
    keys: ['/'],
    labelKey: 'shortcuts.search',
    scope: 'desktop',
    match: (e) => e.key === '/',
  },
  {
    id: 'close',
    keys: ['Esc'],
    labelKey: 'shortcuts.close',
    scope: 'back-stack',
    match: (e) => e.key === 'Escape',
  },
  {
    id: 'help',
    keys: ['?'],
    labelKey: 'shortcuts.help',
    scope: 'desktop',
    match: (e) => e.key === '?',
  },
  {
    id: 'tvSeekBack',
    keys: ['←'],
    labelKey: 'shortcuts.seekBack',
    scope: 'tv-player',
    match: arrow('ArrowLeft', false),
    seekSeconds: -TV_SEEK_STEP_SECONDS,
    repeatable: true,
  },
  {
    id: 'tvSeekForward',
    keys: ['→'],
    labelKey: 'shortcuts.seekForward',
    scope: 'tv-player',
    match: arrow('ArrowRight', false),
    seekSeconds: TV_SEEK_STEP_SECONDS,
    repeatable: true,
  },
];

/** The rows the `?` sheet lists — everything a desktop keyboard can press. */
export const HELP_SHORTCUTS: readonly ShortcutEntry[] = SHORTCUTS.filter(
  (s) => s.scope !== 'tv-player',
);

function inScope(entry: ShortcutEntry, ctx: ShortcutContext): boolean {
  if (entry.scope === 'back-stack') return false;
  if (ctx.tvBuild) return entry.scope === 'tv-player' && ctx.tvPlayerRoute;
  return entry.scope === 'desktop';
}

/** The entry a keydown triggers, or null when it must be left alone. */
export function keyToAction(e: ShortcutKeyEvent, ctx: ShortcutContext): ShortcutEntry | null {
  // A modifier chord is a browser/OS shortcut (Alt+← Back, Ctrl+L, Cmd+N …),
  // and `key` is still the bare letter. Shift is not a chord here: it selects
  // prev/next on the arrows and produces `?`.
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  // Already claimed — a D-pad nav group moved focus, a splitter resized.
  if (e.defaultPrevented) return null;
  if (ctx.textEntry) return null;
  for (const entry of SHORTCUTS) {
    if (!inScope(entry, ctx) || !entry.match(e)) continue;
    if (e.repeat && !entry.repeatable) return null;
    if (entry.spaceYields && isSpace(e) && ctx.activatable) return null;
    return entry;
  }
  return null;
}
