import { describe, expect, it } from 'bun:test';
import { releaseArtifactPaths } from './release-artifacts.js';

describe('releaseArtifactPaths', () => {
  it('lists installers, blockmaps and update feeds, and skips build intermediates', () => {
    expect(
      releaseArtifactPaths('/r', [
        'NicotinD-0.8.103.AppImage',
        'NicotinD_0.8.103_amd64.deb',
        'latest-linux.yml',
        'builder-debug.yml',
        'builder-effective-config.yaml',
        'NicotinD-0.8.103-arm64.dmg.blockmap',
      ]),
    ).toEqual([
      '/r/NicotinD-0.8.103-arm64.dmg.blockmap',
      '/r/NicotinD-0.8.103.AppImage',
      '/r/NicotinD_0.8.103_amd64.deb',
      '/r/latest-linux.yml',
    ]);
  });
});
