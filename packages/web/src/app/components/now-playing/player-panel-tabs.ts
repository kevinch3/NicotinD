import { InjectionToken, type Type } from '@angular/core';
import type { IconName } from '../icon/icon.component';

/** What a tab's badge may read. */
export interface PanelTabContext {
  queueCount: number;
  hasLyrics: boolean;
  /** Whether this tab is the one shown. */
  active: boolean;
}

/**
 * One tab of the Now Playing panel (#1681, docs/player-panel.md §4). A tab is
 * data: the shell renders the strip, the frame, the notch and the gesture, so
 * adding one is an entry here plus its body component, and no gesture code.
 *
 * A body must follow the contract's rules: exactly one vertical scroller
 * (`overflow-y-auto overflow-x-hidden`) inside the panel zone, `data-np-no-swipe`
 * on anything with a horizontal or long-press gesture of its own, no vertical
 * `pointerdown` handler, and any auto-scroll driven from its own inputs.
 * `player-panel-tabs.spec.ts` sweeps every registered template for the first two.
 */
export interface PlayerPanelTab {
  /** Persisted (`nicotind:np-panel`); never reused for a different tab. */
  id: string;
  icon: IconName;
  labelKey: string;
  /** Keeps `now-playing-tab-queue` / `-lyrics` stable for e2e. */
  testid: string;
  /** A number shows after the label; `true` is a dot on the icon. */
  badge?: (ctx: PanelTabContext) => number | boolean | null;
  /**
   * Rendered through `NgComponentOutlet` with a `snap` input. The two built-in
   * tabs leave it out: they talk back to the sheet through outputs, which an
   * outlet cannot bind, so the shell renders them itself.
   */
  body?: Type<unknown>;
  full: {
    /** D6: a strip with play/pause and next above a full panel, or the tab's own. */
    chrome: 'compact-transport' | 'own';
    /** Whether `full` exists beside the side column (§5). */
    atLg: boolean;
  };
}

export const DEFAULT_PLAYER_PANEL_TABS: readonly PlayerPanelTab[] = [
  {
    id: 'queue',
    icon: 'queue',
    labelKey: 'nowPlaying.nextUp',
    testid: 'now-playing-tab-queue',
    badge: ({ queueCount }) => (queueCount > 0 ? queueCount : null),
    // A full-width queue beside the side column buys nothing.
    full: { chrome: 'compact-transport', atLg: false },
  },
  {
    id: 'lyrics',
    icon: 'mic',
    labelKey: 'nowPlaying.lyrics',
    testid: 'now-playing-tab-lyrics',
    // Already reading them: no dot.
    badge: ({ hasLyrics, active }) => hasLyrics && !active,
    // Lyrics at full is karaoke (D5), which brings its own chrome and covers
    // the sheet at every width.
    full: { chrome: 'own', atLg: true },
  },
];

export const PLAYER_PANEL_TABS = new InjectionToken<readonly PlayerPanelTab[]>(
  'PLAYER_PANEL_TABS',
  { providedIn: 'root', factory: () => DEFAULT_PLAYER_PANEL_TABS },
);
