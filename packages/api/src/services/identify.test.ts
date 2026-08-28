/**
 * Policy tests for buildIdentifyApplyTags: empty/placeholder strings and
 * out-of-range numbers are ignored (never clear an existing tag); MBID fields
 * map onto their tag names; an all-junk body yields null so the route 400s.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { IdentifyOutcome } from '@nicotind/core';
import type { PluginRegistry } from './plugins/registry.js';
import { buildIdentifyApplyTags, identifySongById } from './identify.js';

describe('buildIdentifyApplyTags', () => {
  it('maps every field, renaming the MBID keys onto their tag names', () => {
    expect(
      buildIdentifyApplyTags({
        title: 'T',
        artist: 'A',
        album: 'Al',
        albumArtist: 'AA',
        year: 2001,
        trackNumber: 3,
        acoustId: 'ac',
        recordingId: 'rec',
        releaseId: 'rel',
      }),
    ).toEqual({
      title: 'T',
      artist: 'A',
      album: 'Al',
      albumArtist: 'AA',
      year: 2001,
      trackNumber: 3,
      acoustIdId: 'ac',
      mbRecordingId: 'rec',
      mbReleaseId: 'rel',
    });
  });

  it('ignores empty, whitespace-only, and placeholder strings rather than clearing', () => {
    expect(
      buildIdentifyApplyTags({
        title: '',
        artist: '  ',
        album: 'Unknown Album',
        albumArtist: 'AA',
      }),
    ).toEqual({ albumArtist: 'AA' });
  });

  it('ignores an out-of-range or non-integer year', () => {
    expect(buildIdentifyApplyTags({ title: 'T', year: 123 })).toEqual({ title: 'T' });
    expect(buildIdentifyApplyTags({ title: 'T', year: 2101 })).toEqual({ title: 'T' });
    expect(buildIdentifyApplyTags({ title: 'T', year: 2001.5 })).toEqual({ title: 'T' });
  });

  it('ignores a non-positive or non-integer track number', () => {
    expect(buildIdentifyApplyTags({ title: 'T', trackNumber: 0 })).toEqual({ title: 'T' });
    expect(buildIdentifyApplyTags({ title: 'T', trackNumber: 2.5 })).toEqual({ title: 'T' });
  });

  it('returns null when nothing survives the policy', () => {
    expect(buildIdentifyApplyTags({})).toBeNull();
    expect(buildIdentifyApplyTags({ title: '', year: 123 })).toBeNull();
  });
});

/**
 * `identifySongById` is the shared fingerprint lane behind both
 * `POST /api/library/songs/:id/identify` and the `identify_song` MCP tool
 * (issue #777). Every refusal is a *typed reason*, never a bare null: an agent
 * that cannot tell "no plugin configured" from "the audio does not match
 * anything" writes the wrong conclusion into a curation record.
 */
describe('identifySongById', () => {
  const song = (path: string) => ({
    query: () => ({ get: () => ({ path }) }),
  });
  const noSong = { query: () => ({ get: () => null }) };

  function registry(outcome: IdentifyOutcome, apiKey = 'k'): PluginRegistry {
    const plugin = {
      manifest: { id: 'acoustid' },
      identify: {
        identifyTrack: async () => (outcome.kind === 'match' ? outcome.result : null),
        identifyTrackDetailed: async () => outcome,
      },
    };
    return {
      getEnabledWithCapability: (cap: string) => (cap === 'identify' ? [plugin] : []),
      getConfig: () => ({ apiKey }),
    } as unknown as PluginRegistry;
  }

  const emptyRegistry = {
    getEnabledWithCapability: () => [],
    getConfig: () => ({}),
  } as unknown as PluginRegistry;

  let musicDir: string;
  beforeEach(() => {
    musicDir = mkdtempSync(join(tmpdir(), 'nicotind-identify-'));
    writeFileSync(join(musicDir, 'track.opus'), 'x');
  });
  afterEach(() => rmSync(musicDir, { recursive: true, force: true }));

  it('returns the match with its acoustId and score', async () => {
    const result = {
      acoustId: 'ac-1',
      score: 0.93,
      artist: 'Los Chichos',
      title: 'Quiero Ser Libre',
    };
    const res = await identifySongById(
      song('track.opus') as unknown as Database,
      { plugins: registry({ kind: 'match', result }), musicDir },
      's1',
    );
    expect(res).toMatchObject({ ok: true, outcome: { kind: 'match' }, result });
  });

  it('distinguishes undecodable audio from a fingerprint that matched nothing', async () => {
    const undecodable = await identifySongById(
      song('track.opus') as unknown as Database,
      { plugins: registry({ kind: 'undecodable' }), musicDir },
      's1',
    );
    expect(undecodable).toMatchObject({ ok: true, outcome: { kind: 'undecodable' }, result: null });

    const noMatch = await identifySongById(
      song('track.opus') as unknown as Database,
      { plugins: registry({ kind: 'no-match' }), musicDir },
      's1',
    );
    expect(noMatch).toMatchObject({ ok: true, outcome: { kind: 'no-match' }, result: null });
  });

  it('refuses with a reason when no identify plugin is configured', async () => {
    const res = await identifySongById(
      song('track.opus') as unknown as Database,
      { plugins: emptyRegistry, musicDir },
      's1',
    );
    expect(res).toMatchObject({ ok: false, reason: 'identify-unavailable' });
  });

  it('separates an unknown song from a song whose file is gone', async () => {
    const unknown = await identifySongById(
      noSong as unknown as Database,
      { plugins: registry({ kind: 'no-match' }), musicDir },
      'nope',
    );
    expect(unknown).toMatchObject({ ok: false, reason: 'song-not-found' });

    const gone = await identifySongById(
      song('missing.opus') as unknown as Database,
      { plugins: registry({ kind: 'no-match' }), musicDir },
      's1',
    );
    expect(gone).toMatchObject({ ok: false, reason: 'file-not-found' });
  });

  it('refuses a path that escapes the music directory', async () => {
    const res = await identifySongById(
      song('../outside.opus') as unknown as Database,
      { plugins: registry({ kind: 'no-match' }), musicDir },
      's1',
    );
    expect(res).toMatchObject({ ok: false, reason: 'file-not-found' });
  });

  it('refuses when the music directory is not configured', async () => {
    const res = await identifySongById(
      song('track.opus') as unknown as Database,
      { plugins: registry({ kind: 'no-match' }), musicDir: undefined },
      's1',
    );
    expect(res).toMatchObject({ ok: false, reason: 'music-dir-unset' });
  });
});
