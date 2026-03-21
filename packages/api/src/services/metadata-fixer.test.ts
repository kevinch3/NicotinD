import { describe, expect, it } from 'bun:test';
import { inferMetadataFromPath } from './metadata-fixer.js';

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
});
