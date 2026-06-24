import { describe, it, expect } from 'vitest';
import type { AlbumCoverCandidate, CoverCandidatesResponse } from '../../types/core';
import {
  flattenCoverCandidates,
  coverThumbUrl,
  coverCandidateToRequest,
  customCoverToRequest,
} from './cover-candidates';

const current: AlbumCoverCandidate = { source: 'current', url: '/api/cover/album-1', label: 'Current' };
const lidarr: AlbumCoverCandidate = { source: 'lidarr', url: 'https://img/x.jpg', label: 'X' };
const file: AlbumCoverCandidate = {
  source: 'file',
  url: '/api/cover/song-1?embedded=1',
  label: 'From files',
  songId: 'song-1',
};

describe('flattenCoverCandidates', () => {
  it('orders current → lidarr → files and drops a null current', () => {
    const res: CoverCandidatesResponse = { current, lidarr: [lidarr], files: [file] };
    expect(flattenCoverCandidates(res)).toEqual([current, lidarr, file]);
    expect(flattenCoverCandidates({ current: null, lidarr: [], files: [file] })).toEqual([file]);
  });
});

describe('coverThumbUrl', () => {
  it('passes external URLs through untouched', () => {
    expect(coverThumbUrl(lidarr, 'tok')).toBe('https://img/x.jpg');
  });
  it('appends size + token to our own relative URLs (correct separator)', () => {
    expect(coverThumbUrl(current, 'tok')).toBe('/api/cover/album-1?size=160&token=tok');
    expect(coverThumbUrl(file, 'tok')).toBe('/api/cover/song-1?embedded=1&size=160&token=tok');
  });
  it('url-encodes the token', () => {
    expect(coverThumbUrl(current, 'a b')).toContain('token=a%20b');
  });
});

describe('coverCandidateToRequest', () => {
  it('maps lidarr → coverUrl, file → songId, current → null', () => {
    expect(coverCandidateToRequest(lidarr)).toEqual({ coverUrl: 'https://img/x.jpg' });
    expect(coverCandidateToRequest(file)).toEqual({ songId: 'song-1' });
    expect(coverCandidateToRequest(current)).toBeNull();
  });
  it('returns null for a file candidate missing its songId', () => {
    expect(coverCandidateToRequest({ ...file, songId: undefined })).toBeNull();
  });
});

describe('customCoverToRequest', () => {
  it('trims and rejects blank', () => {
    expect(customCoverToRequest('  https://a/b.jpg ')).toEqual({ coverUrl: 'https://a/b.jpg' });
    expect(customCoverToRequest('   ')).toBeNull();
  });
});
