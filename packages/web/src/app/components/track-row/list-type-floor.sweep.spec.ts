import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

// #1654 type-scale floor: list text is never below 12px (`text-xs`). An
// arbitrary `text-[10px]` / `text-[11px]` in a track-list template is the
// regression this pins. Add a new track-list surface to LIST_TEMPLATES.
const APP = join(__dirname, '..', '..');

const LIST_TEMPLATES = [
  'components/track-row/track-row.component.html',
  'components/get-track-row/get-track-row.component.html',
  'components/download-item/download-item.component.html',
  'components/now-playing/now-playing-queue-panel/now-playing-queue-panel.component.html',
  'components/song-picker/song-picker.component.html',
  'pages/search/search.component.html',
  'pages/library/playlist-detail.component.html',
  'pages/library/library-songs.component.html',
];

/** Arbitrary font sizes under 12px, in px or rem. */
const BELOW_FLOOR = /text-\[(?:\d|1[01])(?:\.\d+)?px\]|text-\[0?\.[0-6]\d*rem\]/g;

describe('track-list type floor (#1654)', () => {
  it('sweeps every listed template', () => {
    const missing = LIST_TEMPLATES.filter((f) => !existsSync(join(APP, f)));
    expect(missing).toEqual([]);
    expect(LIST_TEMPLATES).toHaveLength(8);
  });

  it('has no text below 12px in a track-list template', () => {
    const offenders = LIST_TEMPLATES.flatMap((f) =>
      readFileSync(join(APP, f), 'utf8')
        .split('\n')
        .flatMap((text, i) => (text.match(BELOW_FLOOR) ?? []).map((m) => `${f}:${i + 1} ${m}`)),
    );
    expect(offenders).toEqual([]);
  });

  it('the pattern catches what it is for', () => {
    expect('text-[10px] text-[11px] text-[0.625rem]'.match(BELOW_FLOOR)).toHaveLength(3);
    expect('text-xs text-[12px] text-[13px] text-[0.75rem]'.match(BELOW_FLOOR)).toBeNull();
  });
});
