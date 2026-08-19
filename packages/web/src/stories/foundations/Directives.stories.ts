import type { Meta, StoryObj } from '@storybook/angular';
import { Component } from '@angular/core';
import { moduleMetadata } from '@storybook/angular';
import { TvNavGroupDirective } from '../../app/directives/tv-nav-group.directive';
import { TvNavItemDirective } from '../../app/directives/tv-nav-item.directive';
import { BottomChromeSafeDirective } from '../../app/directives/bottom-chrome-safe.directive';

/**
 * Storying a directive needs a host component: Storybook renders a *component*,
 * and a directive has nothing to render on its own. The wrapper lives beside the
 * story, is never exported to the app, and stays as thin as it can while still
 * reproducing the real usage — a wrapper that invents its own layout documents
 * the wrapper rather than the directive.
 */
@Component({
  selector: 'app-tv-nav-grid-demo',
  standalone: true,
  imports: [TvNavGroupDirective, TvNavItemDirective],
  template: `
    <p class="text-xs text-theme-muted mb-3">
      Click a tile, then use the arrow keys. Focus moves within the group; Tab never enters it
      twice, because only the active tile carries <code>tabindex=0</code>.
    </p>
    <div
      appTvNavGroup
      axis="grid"
      class="grid grid-cols-4 gap-3 p-3 rounded-xl bg-theme-surface-2"
      style="grid-template-columns: repeat(4, minmax(0, 1fr))"
    >
      <!-- The row wrapper is not decoration: a grid-axis group makes each item a
           gridcell, and ARIA requires gridcells to sit inside a row. Using
           display:contents satisfies that while leaving the CSS grid layout
           intact. Every real grid in library.component.html does exactly this,
           so the story reproduces it rather than inventing simpler markup that
           would document the wrapper instead of the directive. Omitting it here
           is what the a11y gate caught. -->
      <div role="row" style="display: contents">
        @for (tile of tiles; track tile) {
          <button
            appTvNavItem
            class="aspect-square rounded-lg bg-theme-surface border border-theme text-theme-primary text-sm focus:outline-none focus:ring-2 focus:ring-[var(--theme-accent)]"
          >
            {{ tile }}
          </button>
        }
      </div>
    </div>
  `,
})
class TvNavGridDemoComponent {
  readonly tiles = Array.from({ length: 12 }, (_, i) => i + 1);
}

/** Vertical axis — the shape every `TrackRowComponent`-based list uses. */
@Component({
  selector: 'app-tv-nav-list-demo',
  standalone: true,
  imports: [TvNavGroupDirective, TvNavItemDirective],
  template: `
    <div appTvNavGroup axis="vertical" class="rounded-xl bg-theme-surface-2 p-2 space-y-1">
      @for (row of rows; track row) {
        <button
          appTvNavItem
          class="w-full text-left px-3 py-2 rounded-lg bg-theme-surface text-theme-primary text-sm focus:outline-none focus:ring-2 focus:ring-[var(--theme-accent)]"
        >
          {{ row }}
        </button>
      }
    </div>
  `,
})
class TvNavListDemoComponent {
  readonly rows = ['Track one', 'Track two', 'Track three', 'Track four'];
}

/**
 * The bottom-chrome failure, side by side.
 *
 * The story renders its own `data-bottom-chrome` bar, because Storybook has no
 * mini-player and `measureBottomChromeInset()` measures whatever carries that
 * attribute — with nothing to measure the inset is 0 and both panels would look
 * identical, which would document nothing.
 */
@Component({
  selector: 'app-bottom-chrome-demo',
  standalone: true,
  imports: [BottomChromeSafeDirective],
  template: `
    <div class="grid grid-cols-2 gap-4" style="height: 320px">
      <div class="flex flex-col min-h-0">
        <p class="text-xs font-semibold text-theme-primary mb-1">Without the directive</p>
        <p class="text-[10px] text-theme-muted mb-2">Last rows sit under the chrome.</p>
        <div
          tabindex="0"
          class="flex-1 min-h-0 overflow-y-auto rounded-lg border border-theme bg-theme-surface p-2"
        >
          @for (row of rows; track row) {
            <div class="px-2 py-2 text-sm text-theme-primary border-b border-theme">{{ row }}</div>
          }
        </div>
      </div>

      <div class="flex flex-col min-h-0">
        <p class="text-xs font-semibold text-theme-primary mb-1">With appBottomChromeSafe</p>
        <p class="text-[10px] text-theme-muted mb-2">Reserves room; the last row is reachable.</p>
        <!-- tabindex: the directive sets overflow-y:auto on its host, so the host
             becomes a scrollable region and needs keyboard access. -->
        <div
          appBottomChromeSafe
          tabindex="0"
          class="flex-1 min-h-0 rounded-lg border border-theme bg-theme-surface p-2"
        >
          @for (row of rows; track row) {
            <div class="px-2 py-2 text-sm text-theme-primary border-b border-theme">{{ row }}</div>
          }
        </div>
      </div>
    </div>

    <!-- Stands in for the mini-player + tab bar, which share one z-50 plane. -->
    <div
      data-bottom-chrome
      class="fixed bottom-0 left-0 right-0 h-16 z-50 flex items-center justify-center text-xs font-medium bg-theme-surface-2 border-t border-theme text-theme-muted"
    >
      simulated bottom chrome (mini-player + tab bar)
    </div>
  `,
})
class BottomChromeDemoComponent {
  readonly rows = Array.from({ length: 14 }, (_, i) => `Row ${i + 1}`);
}

/**
 * The shared directives, which the component catalog otherwise doesn't cover.
 *
 * **Caveat for the TV stories:** desktop Chromium has **no spatial navigation**, so
 * these document the focus *wiring* — that the roving tabindex moves and that only
 * one item is tabbable — and not real D-pad behaviour. An Android WebView has
 * spatial navigation and desktop Chrome does not, which is precisely the gap that
 * hid issue #436; the only place that behaviour is actually exercised is
 * `bun run e2e:tv` against the emulator.
 */
const meta: Meta = {
  title: 'Foundations/Directives',
  decorators: [
    moduleMetadata({
      imports: [TvNavGridDemoComponent, TvNavListDemoComponent, BottomChromeDemoComponent],
    }),
  ],
};
export default meta;

type Story = StoryObj;

/** Grid axis: arrows move by row and column. Turn the **TV build** global on to review it as the 10-foot surface. */
export const TvNavGrid: Story = { render: () => ({ template: '<app-tv-nav-grid-demo />' }) };

/** Vertical axis: the list shape used by every song listing. */
export const TvNavList: Story = { render: () => ({ template: '<app-tv-nav-list-demo />' }) };

/** The bottom-chrome inset, with and without the directive. */
export const BottomChromeSafe: Story = {
  render: () => ({ template: '<app-bottom-chrome-demo />' }),
};
