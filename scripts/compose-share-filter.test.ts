import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), '..');
const compose = readFileSync(resolve(repoRoot, 'docker-compose.yml'), 'utf-8');

/** slskd's `command:` entries, e.g. `--downloads=/data/music/.downloads`. */
function slskdFlags(name: string): string[] {
  return [...compose.matchAll(new RegExp(`^\\s*-\\s*--${name}=(.+)$`, 'gm'))].map((m) =>
    m[1]!.trim(),
  );
}

describe('slskd share filters cover the acquisition staging dir', () => {
  // #843: staging lives INSIDE the shared music dir, so slskd would advertise
  // files the organizer is about to move, rename or re-encode away. The two
  // values sit two lines apart in compose precisely so they stay in sync;
  // this test is what makes "stay in sync" enforceable.
  const downloads = slskdFlags('downloads');
  const filters = slskdFlags('share-filter');

  test('slskd is configured with a downloads dir', () => {
    expect(downloads).toHaveLength(1);
  });

  test('some share-filter matches the configured staging dir', () => {
    const staging = `${downloads[0]!}/Some Album/01 - Track.flac`;
    const matched = filters.some((f) => new RegExp(f).test(staging));
    expect(matched).toBe(true);
  });

  test('the filters do not exclude a legitimate album whose name contains the word', () => {
    // `filters` are regex over the path, not globs — an unanchored `downloads`
    // would silently stop sharing real music.
    for (const p of [
      '/data/music/Artist/Downloads Vol. 2/01 - Track.opus',
      '/data/music/Artist/Unsorted Rarities/01 - Track.opus',
      '/data/music/Artist/Album/01 - Track.opus',
    ]) {
      const matched = filters.some((f) => new RegExp(f).test(p));
      expect({ path: p, matched }).toEqual({ path: p, matched: false });
    }
  });
});
