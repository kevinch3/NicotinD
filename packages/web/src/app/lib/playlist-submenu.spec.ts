import { PLAYLIST_FILTER_FROM, playlistSubmenu } from './track-utils';
import type { PlaylistSummary } from '../services/api/api-types';

const pl = (id: string, over: Partial<PlaylistSummary> = {}): PlaylistSummary => ({
  id,
  name: `List ${id}`,
  description: null,
  songCount: 1,
  coverArt: null,
  kind: 'user',
  createdAt: 1,
  modifiedAt: 1,
  ...over,
});

describe('playlistSubmenu (#2009)', () => {
  it("offers New playlist first, then the user's own playlists, most recently changed first", () => {
    const rows = playlistSubmenu(
      [pl('old', { modifiedAt: 10 }), pl('new', { modifiedAt: 30 }), pl('mid', { modifiedAt: 20 })],
      { add: () => {}, create: () => {} },
    );
    expect(rows.map((r) => r.label)).toEqual(['New playlist', 'List new', 'List mid', 'List old']);
    expect(rows[0]!.field).toMatchObject({
      kind: 'submit',
      placeholderKey: 'song.playlistNewName',
    });
  });

  it('leaves out curated playlists and Liked Songs', () => {
    const rows = playlistSubmenu(
      [pl('c', { kind: 'curated' }), pl('l', { kind: 'liked' }), pl('mine')],
      { add: () => {}, create: () => {} },
    );
    expect(rows.map((r) => r.label)).toEqual(['New playlist', 'List mine']);
  });

  it('adds a filter field only once there are more playlists than fit at a glance', () => {
    const many = Array.from({ length: PLAYLIST_FILTER_FROM + 1 }, (_, i) => pl(String(i)));
    const ops = { add: () => {}, create: () => {} };
    expect(playlistSubmenu(many, ops)[0]).toMatchObject({
      label: 'Find a playlist',
      field: { kind: 'filter' },
    });
    expect(playlistSubmenu(many.slice(0, PLAYLIST_FILTER_FROM), ops)[0]!.label).toBe(
      'New playlist',
    );
  });

  it('adds to the playlist picked and creates from the typed name', () => {
    const added: string[] = [];
    const created: string[] = [];
    const rows = playlistSubmenu([pl('a')], {
      add: (id) => added.push(id),
      create: (name) => created.push(name),
    });
    rows[1]!.action();
    rows[0]!.field!.submit!('Sunday');
    expect(added).toEqual(['a']);
    expect(created).toEqual(['Sunday']);
  });

  it('keeps two playlists with one name apart, since a label is also a key', () => {
    const rows = playlistSubmenu([pl('a', { name: 'Mix' }), pl('b', { name: 'Mix' })], {
      add: () => {},
      create: () => {},
    });
    expect(rows.slice(1).map((r) => r.label)).toEqual(['Mix', 'Mix (2)']);
  });
});
