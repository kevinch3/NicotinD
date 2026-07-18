import { describe, expect, it } from 'bun:test';
import { buildPlistBuddyCommands } from './ios-plist.js';

describe('buildPlistBuddyCommands', () => {
  it('always sets UIBackgroundModes to [audio] for background playback', () => {
    const cmds = buildPlistBuddyCommands({});
    expect(cmds).toContain('Delete :UIBackgroundModes');
    expect(cmds).toContain('Add :UIBackgroundModes array');
    expect(cmds).toContain('Add :UIBackgroundModes:0 string audio');
  });

  it('always sets NSCameraUsageDescription for the pairing QR scanner', () => {
    const cmds = buildPlistBuddyCommands({});
    const add = cmds.find((c) => c.startsWith('Add :NSCameraUsageDescription string '));
    const set = cmds.find((c) => c.startsWith('Set :NSCameraUsageDescription '));
    expect(add).toBeDefined();
    expect(set).toBeDefined();
    expect(cmds.indexOf(add!)).toBeLessThan(cmds.indexOf(set!));
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

  it('omits version commands when no version is supplied', () => {
    const cmds = buildPlistBuddyCommands({ build: '' });
    expect(cmds.some((c) => c.includes('CFBundleShortVersionString'))).toBe(false);
    expect(cmds.some((c) => c.includes('CFBundleVersion'))).toBe(false);
  });
});
