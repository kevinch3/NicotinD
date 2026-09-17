import { describe, expect, it } from 'bun:test';
import { buildPlistBuddyCommands } from './ios-plist.js';

describe('buildPlistBuddyCommands', () => {
  it('always sets UIBackgroundModes to [audio] for background playback', () => {
    const cmds = buildPlistBuddyCommands({});
    expect(cmds).toContain('Delete :UIBackgroundModes');
    expect(cmds).toContain('Add :UIBackgroundModes array');
    expect(cmds).toContain('Add :UIBackgroundModes:0 string audio');
  });

  it('declares no camera usage — the QR scanner was removed (#1168)', () => {
    // The new truth, stated rather than the assertion deleted: iOS shows the
    // usage string in a permission prompt, so declaring one for a camera the
    // app can no longer open would be a prompt with nothing behind it.
    const cmds = buildPlistBuddyCommands({});
    expect(cmds.some((c) => c.includes('NSCameraUsageDescription'))).toBe(false);
  });

  it('deletes the array before re-adding it so re-runs stay idempotent', () => {
    const cmds = buildPlistBuddyCommands({});
    expect(cmds.indexOf('Delete :UIBackgroundModes')).toBeLessThan(
      cmds.indexOf('Add :UIBackgroundModes array'),
    );
  });

  it('Adds-then-Sets each version key so it works whether or not the key exists', () => {
    const cmds = buildPlistBuddyCommands({ shortVersion: '1.2.3', build: 1_002_003 });
    expect(cmds.indexOf('Add :CFBundleShortVersionString string 1.2.3')).toBeLessThan(
      cmds.indexOf('Set :CFBundleShortVersionString 1.2.3'),
    );
    expect(cmds.indexOf('Add :CFBundleVersion string 1002003')).toBeLessThan(
      cmds.indexOf('Set :CFBundleVersion 1002003'),
    );
  });

  it('allows plain-http servers via an ATS exception (issue #397, the #390 iOS mirror)', () => {
    const cmds = buildPlistBuddyCommands({});
    // Delete-then-add keeps re-runs idempotent, same as UIBackgroundModes.
    expect(cmds.indexOf('Delete :NSAppTransportSecurity')).toBeLessThan(
      cmds.indexOf('Add :NSAppTransportSecurity dict'),
    );
    expect(cmds.indexOf('Add :NSAppTransportSecurity dict')).toBeLessThan(
      cmds.indexOf('Add :NSAppTransportSecurity:NSAllowsArbitraryLoads bool true'),
    );
  });

  it('omits version commands when no version is supplied', () => {
    const cmds = buildPlistBuddyCommands({ build: '' });
    expect(cmds.some((c) => c.includes('CFBundleShortVersionString'))).toBe(false);
    expect(cmds.some((c) => c.includes('CFBundleVersion'))).toBe(false);
  });
});
