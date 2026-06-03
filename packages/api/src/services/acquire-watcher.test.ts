import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { AcquireWatcher } from './acquire-watcher.js';
import { _resetBinaryCache } from './ytdlp.service.js';

// `enabled` gates the feature independently of whether the binary is installed,
// and a missing binary always reports unavailable even when enabled. We use the
// `bun` binary as a known-present executable and a bogus path as known-absent so
// the test doesn't depend on yt-dlp/spotdl being installed in CI.

function makeWatcher(opts: {
  ytdlpEnabled: boolean;
  ytdlpBinary: string;
  spotdlEnabled: boolean;
  spotdlBinary: string;
}): AcquireWatcher {
  const db = new Database(':memory:');
  applySchema(db);
  return new AcquireWatcher({
    db,
    dataDir: '/tmp/nicotind-acquire-test',
    ytdlp: { enabled: opts.ytdlpEnabled, binaryPath: opts.ytdlpBinary, format: 'bestaudio', extraArgs: [] },
    spotdl: { enabled: opts.spotdlEnabled, binaryPath: opts.spotdlBinary },
    organizeBatch: async () => {},
    scanIncremental: async () => {},
  });
}

const PRESENT = 'bun';
const ABSENT = '/nonexistent/definitely-not-a-real-binary-xyz';

describe('AcquireWatcher availability gating', () => {
  beforeEach(() => _resetBinaryCache());

  it('reports yt-dlp unavailable when disabled, even if the binary exists', () => {
    const w = makeWatcher({ ytdlpEnabled: false, ytdlpBinary: PRESENT, spotdlEnabled: true, spotdlBinary: PRESENT });
    expect(w.isYtdlpAvailable()).toBe(false);
  });

  it('reports yt-dlp unavailable when enabled but the binary is missing', () => {
    const w = makeWatcher({ ytdlpEnabled: true, ytdlpBinary: ABSENT, spotdlEnabled: true, spotdlBinary: PRESENT });
    expect(w.isYtdlpAvailable()).toBe(false);
  });

  it('reports yt-dlp available when enabled and the binary exists', () => {
    const w = makeWatcher({ ytdlpEnabled: true, ytdlpBinary: PRESENT, spotdlEnabled: true, spotdlBinary: PRESENT });
    expect(w.isYtdlpAvailable()).toBe(true);
  });

  it('reports spotdl unavailable when disabled, even if the binary exists', () => {
    const w = makeWatcher({ ytdlpEnabled: true, ytdlpBinary: PRESENT, spotdlEnabled: false, spotdlBinary: PRESENT });
    expect(w.isSpotdlAvailable()).toBe(false);
  });

  it('rejects submit when the backend is unavailable', async () => {
    const w = makeWatcher({ ytdlpEnabled: false, ytdlpBinary: PRESENT, spotdlEnabled: false, spotdlBinary: PRESENT });
    await expect(w.submit('https://example.com', 'ytdlp')).rejects.toThrow(/not enabled/);
  });
});
