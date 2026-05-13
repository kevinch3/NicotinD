import { describe, expect, it } from 'bun:test';
import { extractAlbumName, inferMetadataFromPath } from './path-inference.js';

describe('inferMetadataFromPath', () => {
  it('parses artist, album, track and title from full pattern', () => {
    const parsed = inferMetadataFromPath(
      'Intoxicados - No es sólo rock n roll - 05 - Reggae para los amigos.mp3',
      'Intoxicados\\No es sólo rock n roll',
    );

    expect(parsed.artist).toBe('Intoxicados');
    expect(parsed.album).toBe('No es sólo rock n roll');
    expect(parsed.trackNumber).toBe('5');
    expect(parsed.title).toBe('Reggae para los amigos');
  });

  it('parses track and title and falls back album from folder', () => {
    const parsed = inferMetadataFromPath('12 - Zona de Promesas.mp3', 'Soda Stereo\\Sueño Stereo');

    expect(parsed.artist).toBeUndefined();
    expect(parsed.album).toBe('Sueño Stereo');
    expect(parsed.trackNumber).toBe('12');
    expect(parsed.title).toBe('Zona de Promesas');
  });

  it('parses artist and title from simple artist-title format', () => {
    const parsed = inferMetadataFromPath('Maddona - Like A Prayer.mp3', 'pop');

    expect(parsed.artist).toBe('Maddona');
    expect(parsed.album).toBe('pop');
    expect(parsed.title).toBe('Like A Prayer');
  });

  it('recovers artist from filename when ID3/Vorbis tags are missing', () => {
    const parsed = inferMetadataFromPath(
      'Nomads - Be Nice (Spotlight 5020) Fort Worth, Tx 1966.mp3',
      'Nomads',
    );

    expect(parsed.artist).toBe('Nomads');
    expect(parsed.title).toContain('Be Nice');
  });
});

describe('extractAlbumName', () => {
  it('strips a leading "<artist> - " prefix from a folder name', () => {
    expect(extractAlbumName('Daft Punk - Discovery', 'Daft Punk')).toBe('Discovery');
  });

  it('leaves the folder name as-is when artist matches the whole name', () => {
    expect(extractAlbumName('Nomads', 'Nomads')).toBe('Nomads');
  });

  it('leaves the folder name as-is when artist does not match', () => {
    expect(extractAlbumName('Some Folder', 'Different Artist')).toBe('Some Folder');
  });

  it('uses the cleaned folder name when no artist is provided', () => {
    expect(extractAlbumName('My Album [FLAC]', undefined)).toBe('My Album');
  });

  it('strips format tags AND artist prefix together', () => {
    expect(extractAlbumName('Daft Punk - Discovery [FLAC 320]', 'Daft Punk')).toBe('Discovery');
  });

  it('case-insensitively matches the artist prefix', () => {
    expect(extractAlbumName('DAFT PUNK - Discovery', 'Daft Punk')).toBe('Discovery');
  });
});
