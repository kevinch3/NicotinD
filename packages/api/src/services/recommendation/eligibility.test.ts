import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../../db.js';
import { MAX_ANALYSIS_ATTEMPTS } from '../enrichment/analysis-failures.js';
import { feedEligibilitySql, feedEligibilityWheres, isFeedEligible } from './eligibility.js';

function db(): Database {
  const d = new Database(':memory:');
  applySchema(d);
  return d;
}

interface Row {
  id: string;
  albumId?: string;
  hidden?: number;
  albumHidden?: number;
  landed?: boolean;
  duration?: number;
  bpm?: number | null;
  energy?: number | null;
}

function seed(d: Database, r: Row): void {
  const albumId = r.albumId ?? `alb-${r.id}`;
  d.run(
    `INSERT OR IGNORE INTO library_albums (id, name, artist, artist_id, song_count, duration, created, synced_at, hidden)
     VALUES (?, ?, 'A', 'A', 1, 0, '2024-01-01', 0, ?)`,
    [albumId, albumId, r.albumHidden ?? 0],
  );
  d.run(
    `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, size, bit_rate, suffix, content_type, created, bpm, energy, landed_at, synced_at, hidden)
     VALUES (?, ?, ?, 'A', 'A', ?, ?, 100, 320, 'mp3', 'audio/mpeg', '2024-01-01', ?, ?, ?, 0, ?)`,
    [
      r.id,
      albumId,
      r.id,
      r.duration ?? 240,
      `/m/${r.id}.mp3`,
      r.bpm === undefined ? 120 : r.bpm,
      r.energy === undefined ? 0.5 : r.energy,
      r.landed === false ? null : 1,
      r.hidden ?? 0,
    ],
  );
}

function ids(d: Database, sql: string): string[] {
  return d
    .query<{ id: string }, []>(`SELECT s.id FROM library_songs s WHERE ${sql} ORDER BY s.id`)
    .all()
    .map((r) => r.id);
}

describe('feedEligibilityWheres — the hard layer', () => {
  it('drops hidden songs, songs of hidden albums, and un-landed songs at every tier', () => {
    const d = db();
    seed(d, { id: 'ok' });
    seed(d, { id: 'hidden-song', hidden: 1 });
    seed(d, { id: 'hidden-album', albumHidden: 1 });
    seed(d, { id: 'unlanded', landed: false });
    for (const tier of [1, 2] as const) {
      expect(ids(d, feedEligibilitySql({ tier }))).toEqual(['ok']);
    }
  });

  it('uses the joined album alias when the caller has one, and a correlated check otherwise', () => {
    const joined = feedEligibilityWheres({ tier: 2, albumAlias: 'a' }).wheres.join(' ');
    expect(joined).toContain('a.hidden = 0');
    expect(joined).not.toContain('NOT EXISTS');
    const bare = feedEligibilityWheres({ tier: 2 }).wheres.join(' ');
    expect(bare).toContain('NOT EXISTS (SELECT 1 FROM library_albums');
  });

  it('applies the duration floor only when asked', () => {
    const d = db();
    seed(d, { id: 'long', duration: 240 });
    seed(d, { id: 'skit', duration: 30 });
    expect(ids(d, feedEligibilitySql({ tier: 2 }))).toEqual(['long', 'skit']);
    expect(ids(d, feedEligibilitySql({ tier: 2, minDurationSec: 60 }))).toEqual(['long']);
  });

  it('produces no bind params today (callers splice it without re-threading params)', () => {
    expect(feedEligibilityWheres({ tier: 1 }).params).toEqual([]);
  });
});

describe('feedEligibilityWheres — readiness tiers', () => {
  it('tier 1 excludes un-analysed songs; tier 2 admits them', () => {
    const d = db();
    seed(d, { id: 'analysed' });
    seed(d, { id: 'no-bpm', bpm: null });
    seed(d, { id: 'no-energy', energy: null });
    expect(ids(d, feedEligibilitySql({ tier: 1 }))).toEqual(['analysed']);
    expect(ids(d, feedEligibilitySql({ tier: 2 }))).toEqual(['analysed', 'no-bpm', 'no-energy']);
  });

  it('a permanently failed analysis counts as ready — the file will never analyse', () => {
    const d = db();
    seed(d, { id: 'broken', bpm: null, energy: null });
    for (const task of ['bpm', 'energy']) {
      d.run(
        `INSERT INTO library_song_analysis_failures (song_id, task, fail_count, file_size, last_attempt)
         VALUES ('broken', ?, ?, 100, 0)`,
        [task, MAX_ANALYSIS_ATTEMPTS],
      );
    }
    expect(ids(d, feedEligibilitySql({ tier: 1 }))).toEqual(['broken']);
  });

  it('a failure ledger that is still retrying does not count as ready', () => {
    const d = db();
    seed(d, { id: 'retrying', bpm: null, energy: null });
    d.run(
      `INSERT INTO library_song_analysis_failures (song_id, task, fail_count, file_size, last_attempt)
       VALUES ('retrying', 'bpm', 1, 100, 0)`,
    );
    expect(ids(d, feedEligibilitySql({ tier: 1 }))).toEqual([]);
  });
});

describe('isFeedEligible — parity with the SQL', () => {
  const cases: Array<[Parameters<typeof isFeedEligible>[0], 1 | 2, boolean]> = [
    [{ hidden: 0, bpm: 120, energy: 0.5 }, 1, true],
    [{ hidden: 1, bpm: 120, energy: 0.5 }, 1, false],
    [{ hidden: 0, albumHidden: 1, bpm: 120, energy: 0.5 }, 2, false],
    [{ hidden: 0, landedAt: null, bpm: 120, energy: 0.5 }, 2, false],
    [{ hidden: 0, bpm: null, energy: 0.5 }, 1, false],
    [{ hidden: 0, bpm: null, energy: 0.5 }, 2, true],
    [{ hidden: 0, bpm: null, energy: null, bpmFailed: true, energyFailed: true }, 1, true],
    [{ hidden: 0, bpm: null, energy: null, bpmFailed: true }, 1, false],
  ];
  it.each(cases)('%j at tier %i → %p', (row, tier, expected) => {
    expect(isFeedEligible(row, { tier })).toBe(expected);
  });

  it('honours the duration floor like the SQL does', () => {
    expect(
      isFeedEligible(
        { hidden: 0, duration: 30, bpm: 1, energy: 1 },
        { tier: 1, minDurationSec: 60 },
      ),
    ).toBe(false);
    expect(isFeedEligible({ hidden: 0, duration: 30, bpm: 1, energy: 1 }, { tier: 1 })).toBe(true);
  });
});
