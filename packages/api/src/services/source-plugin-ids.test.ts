import { describe, expect, it } from 'bun:test';
import { sourceEnabled } from './source-plugin-ids.js';
import { BUNDLED_ARCHIVE_ID } from './addons/bundled/archive/index.js';

/**
 * #1728: the blended search and album hunt gate each metadata source on
 * `plugins.isEnabled(<source id>)`. archive.org's source id is 'archive', but
 * since it became a bundled addon (#511) the plugin that enables it is
 * 'bundled-archive', so the gate asked about a plugin that no longer exists
 * and archive.org never contributed a single candidate.
 */
describe('sourceEnabled', () => {
  const only = (...ids: string[]) => sourceEnabled({ isEnabled: (id) => ids.includes(id) });

  it('turns the archive source on when the bundled archive addon is enabled', () => {
    expect(only(BUNDLED_ARCHIVE_ID)('archive')).toBe(true);
  });

  it('keeps it off when the bundled archive addon is disabled', () => {
    expect(only()('archive')).toBe(false);
  });

  it('passes other sources through under their own id', () => {
    expect(only('spotify')('spotify')).toBe(true);
    expect(only(BUNDLED_ARCHIVE_ID)('spotify')).toBe(false);
  });
});
