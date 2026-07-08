import {
  DOWNLOAD_ITEM_HOST_CLASS,
  DOWNLOAD_ITEM_TITLE_CLASS,
  canOpenInLibrary,
} from './download-item.component';
import { resolveAlbumRoute } from '../../lib/route-utils';
import type { DownloadItem } from '../../lib/download-groups';

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
