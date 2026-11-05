import { describe, expect, it } from 'bun:test';
import { schemaSongColumns } from './check-song-carry-coverage.js';

describe('check:song-carry-coverage denominator', () => {
  it('sees a polymorphic (target_kind, target_id) pair, not just song-named columns (#1475)', () => {
    const found = schemaSongColumns().map((f) => `${f.table}.${f.column}`);
    expect(found).toContain('curation_flags.target_id');
    expect(found).toContain('curation_flag_reports.target_id');
    expect(found).toContain('audit_log.target_id');
  });

  it('still sees the song-named columns', () => {
    const found = schemaSongColumns().map((f) => `${f.table}.${f.column}`);
    expect(found).toContain('playlist_songs.song_id');
    expect(found).toContain('radio_poll_scenarios.seed_song_id');
  });
});
