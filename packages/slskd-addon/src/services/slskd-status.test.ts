import { describe, it, expect } from 'bun:test';
import type { SlskdUserTransferGroup } from '@nicotind/core';
import {
  buildSlskdStatus,
  computeCounts,
  extractSlskdLimits,
  sumInProgressSpeed,
} from './slskd-status.js';

function group(
  username: string,
  files: { state: string; averageSpeed: number }[],
): SlskdUserTransferGroup {
  return {
    username,
    directories: [
      {
        directory: 'd',
        fileCount: files.length,
        files: files.map((f, i) => ({
          id: `${username}-${i}`,
          username,
          filename: `f${i}.mp3`,
          size: 100,
          state: f.state as never,
          bytesTransferred: 0,
          averageSpeed: f.averageSpeed,
          percentComplete: 0,
        })),
      },
    ],
  };
}

describe('slskd-status roll-up', () => {
  it('sums only in-progress speeds', () => {
    const g = [
      group('a', [
        { state: 'InProgress', averageSpeed: 100 },
        { state: 'Initializing', averageSpeed: 50 },
        { state: 'Queued, Remotely', averageSpeed: 999 },
        { state: 'Completed, Succeeded', averageSpeed: 999 },
      ]),
    ];
    expect(sumInProgressSpeed(g)).toBe(150);
    expect(sumInProgressSpeed(null)).toBe(0);
  });

  it('counts downloading/uploading/queued', () => {
    const downloads = [
      group('a', [
        { state: 'InProgress', averageSpeed: 10 },
        { state: 'Queued, Locally', averageSpeed: 0 },
      ]),
    ];
    const uploads = [
      group('b', [
        { state: 'InProgress', averageSpeed: 20 },
        { state: 'Requested', averageSpeed: 0 },
      ]),
    ];
    expect(computeCounts(downloads, uploads)).toEqual({
      downloading: 1,
      uploading: 1,
      queued: 2,
    });
  });

  it('extracts limits from the global.* option shape and tolerates absence', () => {
    const opts = {
      global: { upload: { slots: 5, speedLimit: 0 }, download: { slots: 20, speedLimit: 500 } },
    };
    expect(extractSlskdLimits(opts)).toEqual({
      uploadSlots: 5,
      downloadSlots: 20,
      uploadSpeedLimit: 0,
      downloadSpeedLimit: 500,
    });
    expect(extractSlskdLimits(null)).toEqual({});
    expect(extractSlskdLimits({})).toEqual({
      uploadSlots: undefined,
      downloadSlots: undefined,
      uploadSpeedLimit: undefined,
      downloadSpeedLimit: undefined,
    });
  });

  it('extracts limits from the alternate uploads/downloads shape', () => {
    const opts = { uploads: { slots: 3, speedLimit: 128 }, downloads: { slots: 8, speedLimit: 0 } };
    expect(extractSlskdLimits(opts)).toMatchObject({
      uploadSlots: 3,
      downloadSlots: 8,
      uploadSpeedLimit: 128,
    });
  });

  it('prefers appInfo.server over the state probe and rolls everything up', () => {
    const status = buildSlskdStatus({
      enabled: true,
      available: true,
      serverState: { state: 'x', username: 'probe', isConnected: false },
      downloads: [group('a', [{ state: 'InProgress', averageSpeed: 100 }])],
      uploads: [group('b', [{ state: 'InProgress', averageSpeed: 40 }])],
      options: { global: { upload: { slots: 2 } } },
      appInfo: {
        version: '1.2.3',
        uptime: 42,
        server: { state: 'Connected, LoggedIn', username: 'me', isConnected: true },
        shares: { directories: 3, files: 99 },
      },
    });
    expect(status.connection?.username).toBe('me');
    expect(status.speeds).toEqual({ downloadBytesPerSec: 100, uploadBytesPerSec: 40 });
    expect(status.shares).toEqual({ directories: 3, files: 99 });
    expect(status.limits.uploadSlots).toBe(2);
    expect(status.version).toBe('1.2.3');
    expect(status.uptimeSeconds).toBe(42);
  });

  it('degrades to the state probe when appInfo has no server block', () => {
    const status = buildSlskdStatus({
      enabled: true,
      available: true,
      serverState: { state: 'Connected', username: 'probe', isConnected: true },
      downloads: null,
      uploads: null,
      options: null,
      appInfo: { version: '1.0.0', uptime: 1 },
    });
    expect(status.connection?.username).toBe('probe');
    expect(status.speeds).toEqual({ downloadBytesPerSec: 0, uploadBytesPerSec: 0 });
    expect(status.shares).toEqual({});
  });
});
