import { Component, Input, ɵSIGNAL as SIGNAL } from '@angular/core';
import { RouterLink, provideRouter } from '@angular/router';
import { TestBed } from '@angular/core/testing';
import {
  DOWNLOAD_ITEM_HOST_CLASS,
  DOWNLOAD_ITEM_TITLE_CLASS,
  canOpenInLibrary,
  hasMultipleDestinationAlbums,
  DownloadItemComponent,
} from './download-item.component';
import { resolveAlbumRoute } from '../../lib/route-utils';
import type { DownloadItem } from '../../lib/download-groups';
import { MenuPanelComponent } from '../menu-panel/menu-panel.component';

/**
 * `app-pipeline-stage-badge` declares its `stage` input via the signal
 * `input.required()` API, which the JIT vitest harness can't statically
 * register as a bindable template property (no ngtsc transform — see
 * track-row.component.spec.ts's comment and project memory "Web JIT vitest
 * can't drive input() signals"). Rendering the real `<app-download-item>`
 * template therefore needs a stand-in for that one child so the rest of the
 * template (the "View N albums" menu under test) can render for real; a
 * decorator-based `@Input()` *is* picked up by the JIT compiler, unlike the
 * signal API, so this stub is bindable where the real badge isn't.
 */
@Component({ selector: 'app-pipeline-stage-badge', standalone: true, template: '' })
class StubPipelineStageBadgeComponent {
  @Input() stage: unknown;
}

function item(over: Partial<DownloadItem> = {}): DownloadItem {
  return {
    key: 'k',
    kind: 'slskd',
    title: 'Album',
    method: 'slskd',
    stage: 'done',
    canRetry: false,
    canCancel: false,
    canRemove: true,
    ...over,
  };
}

// Regression for the user-reported bug: an acquire row whose title is a long
// Spotify URL with no break points
// (open.spotify.com/intl-es/album/3vdljVkOeuLzEXbUHvPp1u) stretched the row and
// overflowed the Downloads grid instead of truncating. The JIT vitest harness
// can't drive a required input() into a render and jsdom can't measure layout,
// so we assert the layout-critical class lists the template binds to. If anyone
// drops `min-w-0` (the actual bug) these fail.
describe('download-item truncation classes', () => {
  const hostClasses = DOWNLOAD_ITEM_HOST_CLASS.split(/\s+/);
  const titleClasses = DOWNLOAD_ITEM_TITLE_CLASS.split(/\s+/);

  it('host is a block grid item that can shrink (block + min-w-0)', () => {
    expect(hostClasses).toContain('block');
    expect(hostClasses).toContain('min-w-0');
  });

  it('title can truncate inside its flex row (truncate + min-w-0)', () => {
    expect(titleClasses).toContain('truncate');
    // A flex item defaults to min-width:auto; without min-w-0 truncate is inert.
    expect(titleClasses).toContain('min-w-0');
  });
});

// The JIT harness can't drive a required input() into a render, so the
// "Open in Library" deep-link is asserted through its exported gating helper
// and the shared route resolver the template binds to.
describe('download-item "Open in Library" deep-link', () => {
  it('offers the link only when complete and an album id is known', () => {
    expect(canOpenInLibrary(item({ stage: 'done', albumId: 'a1' }))).toBe(true);
    // In-flight: no link even with an id.
    expect(canOpenInLibrary(item({ stage: 'downloading', albumId: 'a1' }))).toBe(false);
    // Done but id-less (direct non-hunt slskd download): no link.
    expect(canOpenInLibrary(item({ stage: 'done', albumId: undefined }))).toBe(false);
  });

  it('resolves the album id to the /library/albums/:id route', () => {
    expect(resolveAlbumRoute('a1')).toEqual(['/library', 'albums', 'a1']);
  });
});

// The JIT harness can't drive a required input() into a render, so the
// "View N albums" menu's gating is asserted through its exported gating
// helper, matching the "Open in Library" convention above.
describe('download-item "View N albums" menu gating', () => {
  it('offers the menu only when complete with more than one destination album', () => {
    expect(
      hasMultipleDestinationAlbums(
        item({
          stage: 'done',
          albumId: null,
          destinationAlbums: [
            { albumArtist: 'A', albumTitle: 'One', albumId: 'a1' },
            { albumArtist: 'B', albumTitle: 'Two', albumId: 'a2' },
          ],
        }),
      ),
    ).toBe(true);
  });

  it('does not offer the menu for a single-album job (the plain link covers it)', () => {
    expect(
      hasMultipleDestinationAlbums(
        item({ stage: 'done', albumId: 'a1', destinationAlbums: [{ albumArtist: 'A', albumTitle: 'One', albumId: 'a1' }] }),
      ),
    ).toBe(false);
    expect(canOpenInLibrary(item({ stage: 'done', albumId: 'a1' }))).toBe(true);
  });

  it('does not offer the menu while still in flight, even with multiple destination albums', () => {
    expect(
      hasMultipleDestinationAlbums(
        item({
          stage: 'downloading',
          destinationAlbums: [
            { albumArtist: 'A', albumTitle: 'One', albumId: 'a1' },
            { albumArtist: 'B', albumTitle: 'Two', albumId: 'a2' },
          ],
        }),
      ),
    ).toBe(false);
  });

  it('is false when destinationAlbums is absent or empty', () => {
    expect(hasMultipleDestinationAlbums(item({ stage: 'done' }))).toBe(false);
    expect(hasMultipleDestinationAlbums(item({ stage: 'done', destinationAlbums: [] }))).toBe(false);
  });
});

/**
 * Straight write to the signal node behind `ɵSIGNAL`, matching the pattern
 * already sanctioned in track-row.component.spec.ts for driving a required
 * `input()` in the JIT vitest harness (no ngtsc, no input-transform support).
 * Call only before the fixture's first `detectChanges()`.
 */
function setInputValue<T>(inputSignal: () => T, value: T): void {
  (inputSignal as unknown as Record<typeof SIGNAL, { value: T }>)[SIGNAL].value = value;
}

// The real "View N albums" menu row is rendered here (rather than only
// asserted through the gating helper above) so the album-id → route wiring
// is exercised end to end, not just the show/hide condition.
describe('download-item "View N albums" menu — rendered rows', () => {
  function setup(multiItem: DownloadItem) {
    TestBed.configureTestingModule({
      imports: [DownloadItemComponent],
      providers: [provideRouter([])],
    });
    // Swap the required-input child for the JIT-friendly stub above; leave
    // everything else (the real template, MenuPanelComponent, RouterLink)
    // untouched so the menu under test is exercised for real.
    TestBed.overrideComponent(DownloadItemComponent, {
      set: { imports: [RouterLink, MenuPanelComponent, StubPipelineStageBadgeComponent] },
    });
    const fixture = TestBed.createComponent(DownloadItemComponent);
    setInputValue(fixture.componentInstance.item, multiItem);
    fixture.detectChanges();
    return fixture;
  }

  it('renders a row per destination album, linking to its own album route', () => {
    const fixture = setup(
      item({
        stage: 'done',
        albumId: null,
        destinationAlbums: [
          { albumArtist: 'Artist A', albumTitle: 'Album A', albumId: 'alb-a' },
          { albumArtist: 'Artist B', albumTitle: 'Album B', albumId: 'alb-b' },
        ],
      }),
    );
    const trigger = fixture.nativeElement.querySelector(
      '[data-testid="download-view-albums"]',
    ) as HTMLElement;
    expect(trigger.textContent).toContain('View 2 albums');

    trigger.click();
    fixture.detectChanges();

    const rows = fixture.nativeElement.querySelectorAll(
      '[data-testid="download-album-row"]',
    ) as NodeListOf<HTMLAnchorElement>;
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain('Album A');
    expect(rows[0].getAttribute('href')).toBe('/library/albums/alb-a');
    expect(rows[1].textContent).toContain('Album B');
    expect(rows[1].getAttribute('href')).toBe('/library/albums/alb-b');
  });

  it('does not render the menu trigger for a single-album job', () => {
    const fixture = setup(
      item({
        stage: 'done',
        albumId: 'a1',
        destinationAlbums: [{ albumArtist: 'A', albumTitle: 'One', albumId: 'a1' }],
      }),
    );
    expect(fixture.nativeElement.querySelector('[data-testid="download-view-albums"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="download-open-album"]')).not.toBeNull();
  });
});
