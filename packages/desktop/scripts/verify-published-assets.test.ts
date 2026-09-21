import { describe, expect, it } from 'bun:test';
import {
  isPublishedArtifact,
  missingFromRelease,
  publishedArtifacts,
  verifyPublished,
} from './verify-published-assets.js';

/** What `release/` looks like after a Linux packaging run. */
const LINUX_OUTPUT = [
  'NicotinD-0.8.39.AppImage',
  'NicotinD_0.8.39_amd64.deb',
  'latest-linux.yml',
  'builder-debug.yml',
  'builder-effective-config.yaml',
];

/** The v0.8.39 release as it actually stood: mobile assets only. */
const RELEASE_1261 = [
  'NicotinD-0.8.39-unsigned.ipa',
  'NicotinD-0.8.39.apk',
  'NicotinD-TV-0.8.39.apk',
];

describe('publishedArtifacts', () => {
  it('keeps the installers and the updater feed, drops the build intermediates', () => {
    expect(publishedArtifacts(LINUX_OUTPUT)).toEqual([
      'NicotinD-0.8.39.AppImage',
      'NicotinD_0.8.39_amd64.deb',
      'latest-linux.yml',
    ]);
  });

  it('keeps the dmg, its blockmap and the mac feed', () => {
    expect(
      publishedArtifacts([
        'NicotinD-0.8.39-arm64.dmg',
        'NicotinD-0.8.39-arm64.dmg.blockmap',
        'latest-mac.yml',
        'builder-effective-config.yaml',
      ]),
    ).toEqual([
      'NicotinD-0.8.39-arm64.dmg',
      'NicotinD-0.8.39-arm64.dmg.blockmap',
      'latest-mac.yml',
    ]);
  });

  it('treats the updater feed as publishable but not electron-builder debug yml', () => {
    expect(isPublishedArtifact('latest-linux.yml')).toBe(true);
    expect(isPublishedArtifact('latest-mac.yml')).toBe(true);
    expect(isPublishedArtifact('builder-debug.yml')).toBe(false);
    expect(isPublishedArtifact('builder-effective-config.yaml')).toBe(false);
  });
});

describe('missingFromRelease', () => {
  // The regression: electron-builder logged `skipped publishing` for every file
  // and exited 0, so the job was green with nothing attached (#1261).
  it('reports every desktop artifact when the publisher skipped them all', () => {
    expect(missingFromRelease(publishedArtifacts(LINUX_OUTPUT), RELEASE_1261)).toEqual([
      'NicotinD-0.8.39.AppImage',
      'NicotinD_0.8.39_amd64.deb',
      'latest-linux.yml',
    ]);
  });

  it('reports the feed alone when the installers landed but the feed did not', () => {
    expect(
      missingFromRelease(publishedArtifacts(LINUX_OUTPUT), [
        ...RELEASE_1261,
        'NicotinD-0.8.39.AppImage',
        'NicotinD_0.8.39_amd64.deb',
      ]),
    ).toEqual(['latest-linux.yml']);
  });

  it('is empty when every artifact is attached', () => {
    expect(
      missingFromRelease(publishedArtifacts(LINUX_OUTPUT), [
        ...RELEASE_1261,
        'NicotinD-0.8.39.AppImage',
        'NicotinD_0.8.39_amd64.deb',
        'latest-linux.yml',
      ]),
    ).toEqual([]);
  });

  // The mobile jobs upload to the same release; their assets must not vouch for
  // ours, which is exactly what made the v0.8.39 run look plausible.
  it('does not accept unrelated assets as cover', () => {
    expect(missingFromRelease(['NicotinD-0.8.39.AppImage'], RELEASE_1261)).toEqual([
      'NicotinD-0.8.39.AppImage',
    ]);
  });
});

describe('verifyPublished', () => {
  const noSleep = async () => {};

  it('clears as soon as a retry sees the assets', async () => {
    const seen = [RELEASE_1261, [...RELEASE_1261, 'NicotinD-0.8.39.AppImage']];
    let call = 0;
    const missing = await verifyPublished(
      ['NicotinD-0.8.39.AppImage'],
      async () => seen[call++] ?? [],
      'v0.8.39',
      { attempts: 3, delayMs: 0, sleep: noSleep },
    );
    expect(missing).toEqual([]);
    expect(call).toBe(2);
  });

  it('still fails when the assets never appear, and stops after the last attempt', async () => {
    let call = 0;
    const missing = await verifyPublished(
      ['NicotinD-0.8.39.AppImage', 'latest-linux.yml'],
      async () => {
        call += 1;
        return RELEASE_1261;
      },
      'v0.8.39',
      { attempts: 3, delayMs: 0, sleep: noSleep },
    );
    expect(missing).toEqual(['NicotinD-0.8.39.AppImage', 'latest-linux.yml']);
    expect(call).toBe(3);
  });
});
