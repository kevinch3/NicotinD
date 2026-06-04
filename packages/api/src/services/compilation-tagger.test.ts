import { describe, expect, it } from 'bun:test';
import { classifyFolder } from './compilation-tagger.js';

type FileSignal = { artist: string | undefined; album: string | undefined; filename: string };

function file(artist: string | undefined, album: string | undefined): FileSignal {
  return { artist, album, filename: '' };
}

function repeat<T>(n: number, fn: () => T): T[] {
  return Array.from({ length: n }, fn);
}

describe('classifyFolder — test matrix', () => {
  it('row 1: Beatport comp with no tags at all → compilation (folder name rule)', () => {
    const files = repeat(100, () => file(undefined, undefined));
    const result = classifyFolder(files, 'Beatport Best of Tech House 2026');
    expect(result.type).toBe('compilation');
    if (result.type === 'compilation') {
      expect(result.album).toBe('Beatport Best of Tech House 2026');
      expect(result.year).toBe(2026);
    }
  });

  it('row 2: comp with scattered original tags → compilation (folder name rule)', () => {
    const files = Array.from({ length: 50 }, (_, i) => file(`Artist ${i}`, `Album ${i}`));
    const result = classifyFolder(files, 'VA - Top 50 EDM 2024');
    expect(result.type).toBe('compilation');
    if (result.type === 'compilation') {
      expect(result.album).toBe('VA - Top 50 EDM 2024');
      expect(result.year).toBe(2024);
    }
  });

  it('row 3: real studio album, well-tagged → leave-alone', () => {
    const files = repeat(14, () => file('Daft Punk', 'Discovery'));
    const result = classifyFolder(files, 'Daft Punk - Discovery');
    expect(result.type).toBe('leave-alone');
  });

  it('row 4: real album with 1 missing album → single-artist (artist consensus wins)', () => {
    const files: FileSignal[] = [
      ...repeat(13, () => file('Daft Punk', 'Discovery')),
      file('Daft Punk', undefined),
    ];
    const result = classifyFolder(files, 'Daft Punk - Discovery');
    expect(result.type).toBe('single-artist');
    if (result.type === 'single-artist') {
      expect(result.artist).toBe('Daft Punk');
      expect(result.album).toBe('Discovery');
    }
  });

  it('row 5: real album with all empty albums → single-artist (filename-recovered artists)', () => {
    const files = repeat(14, () => file('Daft Punk', undefined));
    const result = classifyFolder(files, 'Daft Punk - Discovery');
    expect(result.type).toBe('single-artist');
    if (result.type === 'single-artist') {
      expect(result.artist).toBe('Daft Punk');
      expect(result.album).toBe('Discovery');
    }
  });

  it('row 6: Nomads — single-band untagged singles → single-artist', () => {
    const files = repeat(12, () => file('Nomads', undefined));
    const result = classifyFolder(files, 'Nomads');
    expect(result.type).toBe('single-artist');
    if (result.type === 'single-artist') {
      expect(result.artist).toBe('Nomads');
      expect(result.album).toBe('Nomads');
    }
  });

  it('row 7: 2-track single-artist mini folder → single-artist (no size floor for artist consensus)', () => {
    const files = repeat(2, () => file('O ZONE', undefined));
    const result = classifyFolder(files, 'O ZONE');
    expect(result.type).toBe('single-artist');
    if (result.type === 'single-artist') {
      expect(result.artist).toBe('O ZONE');
      expect(result.album).toBe('O ZONE');
    }
  });

  it('row 8: discography flat-dump → single-artist (consolidates into one album)', () => {
    const files: FileSignal[] = [
      ...repeat(10, () => file('Daft Punk', 'Homework')),
      ...repeat(10, () => file('Daft Punk', 'Discovery')),
      ...repeat(10, () => file('Daft Punk', 'Human After All')),
      ...repeat(10, () => file('Daft Punk', 'Random Access Memories')),
    ];
    const result = classifyFolder(files, 'Daft Punk - Discography');
    expect(result.type).toBe('single-artist');
    if (result.type === 'single-artist') {
      expect(result.artist).toBe('Daft Punk');
      expect(result.album).toBe('Discography');
    }
  });

  it('row 9: NOW-style well-tagged comp → leave-alone', () => {
    const files = Array.from({ length: 20 }, (_, i) => file(`Artist ${i}`, 'NOW 86'));
    const result = classifyFolder(files, 'NOW 86');
    expect(result.type).toBe('leave-alone');
  });

  it('row 10: live bootleg → leave-alone', () => {
    const files = repeat(10, () => file('Phish', 'Phish 1997-11-22'));
    const result = classifyFolder(files, 'Phish - 1997-11-22 Hampton');
    expect(result.type).toBe('leave-alone');
  });

  it('row 11: soundtrack VA, well-tagged → leave-alone', () => {
    const files = Array.from({ length: 15 }, (_, i) => file(`Artist ${i}`, 'Pulp Fiction OST'));
    const result = classifyFolder(files, 'Pulp Fiction OST');
    expect(result.type).toBe('leave-alone');
  });

  it('row 12: pair of unrelated tracks → leave-alone (no rule fires)', () => {
    const files: FileSignal[] = [file('Artist A', 'Album A'), file('Artist B', 'Album B')];
    const result = classifyFolder(files, 'Two Tracks');
    expect(result.type).toBe('leave-alone');
  });

  it('row 13: triple of unrelated tracks, all empty albums → leave-alone (size < 6 and < 5 distinct)', () => {
    const files: FileSignal[] = [
      file('Artist A', undefined),
      file('Artist B', undefined),
      file('Artist C', undefined),
    ];
    const result = classifyFolder(files, 'Three');
    expect(result.type).toBe('leave-alone');
  });

  it('row 14: mid-sized untagged dump with multi-artist → compilation (scattered artists rule)', () => {
    const files = Array.from({ length: 8 }, (_, i) => file(`Artist ${i}`, undefined));
    const result = classifyFolder(files, 'Random Mix');
    expect(result.type).toBe('compilation');
    if (result.type === 'compilation') {
      expect(result.album).toBe('Random Mix');
    }
  });

  it('row 15: untagged sizable folder, ambiguous shape → compilation (untagged-dump rule)', () => {
    const files = repeat(6, () => file(undefined, undefined));
    const result = classifyFolder(files, 'Mystery');
    expect(result.type).toBe('compilation');
    if (result.type === 'compilation') {
      expect(result.album).toBe('Mystery');
    }
  });
});

describe('classifyFolder — folder-name signal variants', () => {
  it('recognizes "VA - " prefix (folder name rule)', () => {
    const files: FileSignal[] = [file('A', 'X'), file('B', 'Y')];
    const result = classifyFolder(files, 'VA - Disco Hits');
    expect(result.type).toBe('compilation');
  });

  it('recognizes "Vol. N" pattern (folder name rule)', () => {
    const files: FileSignal[] = repeat(5, () => file(undefined, undefined));
    const result = classifyFolder(files, 'Acid House Vol. 3');
    expect(result.type).toBe('compilation');
  });

  it('recognizes "Compilation" keyword', () => {
    const files: FileSignal[] = repeat(4, () => file(undefined, undefined));
    const result = classifyFolder(files, 'Indie Compilation 2020');
    expect(result.type).toBe('compilation');
  });

  it('recognizes "Mixtape" keyword', () => {
    const files: FileSignal[] = repeat(4, () => file(undefined, undefined));
    const result = classifyFolder(files, 'Summer Mixtape');
    expect(result.type).toBe('compilation');
  });
});

describe('classifyFolder — protection against false positives', () => {
  it('does not trigger on a 5-file all-empty folder (below mostly-empty size floor)', () => {
    const files = repeat(5, () => file(undefined, undefined));
    const result = classifyFolder(files, 'Mystery 5');
    expect(result.type).toBe('leave-alone');
  });

  it('does not trigger on real album with half albums missing (50% < 75% threshold)', () => {
    const files: FileSignal[] = [
      ...repeat(7, () => file('Artist X', 'Album X')),
      ...repeat(7, () => file('Artist X', undefined)),
    ];
    const result = classifyFolder(files, 'Artist X - Album X');
    // Artist consensus → single-artist (not compilation, not leave-alone since albums not coherent)
    expect(result.type).toBe('single-artist');
    if (result.type === 'single-artist') {
      expect(result.artist).toBe('Artist X');
    }
  });

  it('does not trigger compilation on 4-distinct-album discography (< 5 distinct floor)', () => {
    const files: FileSignal[] = [
      ...repeat(5, () => file('Band', 'A')),
      ...repeat(5, () => file('Band', 'B')),
      ...repeat(5, () => file('Band', 'C')),
      ...repeat(5, () => file('Band', 'D')),
    ];
    const result = classifyFolder(files, 'Band Box Set');
    expect(result.type).toBe('single-artist');
    if (result.type === 'single-artist') {
      expect(result.artist).toBe('Band');
    }
  });
});
