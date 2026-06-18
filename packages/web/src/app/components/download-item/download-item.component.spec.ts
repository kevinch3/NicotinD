import { DOWNLOAD_ITEM_HOST_CLASS, DOWNLOAD_ITEM_TITLE_CLASS } from './download-item.component';

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
