import { describe, it, expect } from 'vitest';
import { autoResourcePick } from './resource-auto-pick';
import type { AlternateSource } from '../services/api/api-types';

const peer = (username: string, covered: string[]): AlternateSource => ({
  candidateRef: `ref-${username}`,
  username,
  directory: `Music\\${username}`,
  coveredTitles: covered,
  format: 'FLAC',
  estimatedSizeMb: 1,
  freeUploadSlots: 1,
  queueLength: 0,
  uploadSpeed: 1,
});

describe('autoResourcePick', () => {
  it('takes the top-ranked peer, even one that covers only part of what is pending', () => {
    const top = peer('top', ['One']);
    expect(
      autoResourcePick({
        wanted: ['One', 'Two'],
        required: [],
        alternates: [top, peer('b', ['One'])],
      }),
    ).toBe(top);
  });

  it('has nothing to pick from an empty search', () => {
    expect(autoResourcePick({ wanted: ['One'], required: [], alternates: [] })).toBeNull();
  });
});
