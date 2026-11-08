import { describe, expect, it } from 'bun:test';
import { depsDataDir } from './download-deps-paths.js';

/**
 * The first-run downloader hard-coded ~/.nicotind while boot looks for the
 * Lidarr binary under the configured data dir. With NICOTIND_DATA_DIR set, the
 * download landed where boot never looked, and every start downloaded again.
 */
describe('depsDataDir', () => {
  it('follows NICOTIND_DATA_DIR, expanding ~', () => {
    expect(depsDataDir({ NICOTIND_DATA_DIR: '~/srv/nd', HOME: '/home/u' })).toBe('/home/u/srv/nd');
    expect(depsDataDir({ NICOTIND_DATA_DIR: '/data/nd', HOME: '/home/u' })).toBe('/data/nd');
  });

  it('defaults to ~/.nicotind, as before', () => {
    expect(depsDataDir({ HOME: '/home/u' })).toBe('/home/u/.nicotind');
  });
});
