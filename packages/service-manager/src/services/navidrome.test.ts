import { describe, expect, it } from 'bun:test';
import type { NicotinDConfig } from '@nicotind/core';
import { buildNavidromeDefinition } from './navidrome.js';

function makeConfig(overrides: Partial<NicotinDConfig> = {}): NicotinDConfig {
  return {
    dataDir: '/tmp/nicotind-test-data',
    musicDir: '/tmp/nicotind-test-music',
    navidrome: { port: 4533 },
    ...overrides,
  } as NicotinDConfig;
}

describe('buildNavidromeDefinition', () => {
  it('pins album identity to artist+name so one folder = one album card', () => {
    // why: the hunt/fallback flow can drop foreign-edition files (deluxe/bonus)
    // carrying their own musicbrainz_albumid into one <Artist>/<Album> folder.
    // Navidrome's default PID splits that folder into a card per MBID; keying on
    // albumartistid+album collapses them back into a single album.
    const def = buildNavidromeDefinition(makeConfig());
    expect(def.env.ND_PID_ALBUM).toBe('albumartistid,album');
  });

  it('wires the music + data folders and port from config', () => {
    const def = buildNavidromeDefinition(
      makeConfig({ musicDir: '/srv/music', navidrome: { port: 9999 } } as Partial<NicotinDConfig>),
    );
    expect(def.env.ND_MUSICFOLDER).toBe('/srv/music');
    expect(def.env.ND_PORT).toBe('9999');
  });
});
