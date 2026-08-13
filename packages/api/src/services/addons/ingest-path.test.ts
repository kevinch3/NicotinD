import { describe, expect, it } from 'bun:test';
import { safeIncomingPath } from './ingest-path.js';
import { AddonContractError } from './client.js';

const ROOT = '/data/addon-incoming';

describe('safeIncomingPath', () => {
  it('places a plain filename under incoming/<addon>/<job>/', () => {
    const p = safeIncomingPath(ROOT, 'slskd', 'job1', '01 - Song.flac');
    expect(p).toBe('/data/addon-incoming/slskd/job1/01 - Song.flac');
  });

  it('strips any directory components from the addon-supplied filename', () => {
    const p = safeIncomingPath(ROOT, 'slskd', 'job1', 'peer\\Music\\Album\\02.flac');
    expect(p).toBe('/data/addon-incoming/slskd/job1/02.flac');
    const p2 = safeIncomingPath(ROOT, 'slskd', 'job1', '/etc/passwd');
    expect(p2).toBe('/data/addon-incoming/slskd/job1/passwd');
  });

  it('rejects traversal-only / empty basenames that would escape the staging dir', () => {
    for (const bad of ['..', '../..', '.', '', '/', 'a/../..']) {
      expect(() => safeIncomingPath(ROOT, 'slskd', 'job1', bad), bad).toThrow(AddonContractError);
    }
  });

  it('rejects an addon id or job id that itself tries to traverse', () => {
    expect(() => safeIncomingPath(ROOT, '..', 'job1', 'x.flac')).toThrow(AddonContractError);
    expect(() => safeIncomingPath(ROOT, 'slskd', '../../etc', 'x.flac')).toThrow(
      AddonContractError,
    );
  });
});
