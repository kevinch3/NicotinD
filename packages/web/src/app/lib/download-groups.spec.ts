import { describe, it, expect } from 'vitest';
import type { AcquireJob, AcquisitionJobView } from '@nicotind/core';
import {
  acquireJobToDownloadItem,
  acquireJobLabel,
  jobPercent,
  methodForBackend,
  buildDownloadFeed,
  mergeAcquisitionJobs,
  type DownloadItem,
} from './download-groups';

function job(over: Partial<AcquireJob> = {}): AcquireJob {
  return {
    id: 'j1',
    backend: 'ytdlp',
    url: 'https://youtube.com/watch?v=abc',
    label: null,
    state: 'running',
    stage: 'downloading',
    storage_path: null,
    albumId: null,
    albumArtist: null,
    albumTitle: null,
    destinationAlbums: [],
    tracks: [],
    isPlaylist: false,
    playlistId: null,
    progress: { done: 2, total: 5 },
    error: null,
    created_at: 1_000,
    bitRate: null,
    audioFormat: null,
    ...over,
  };
}

describe('methodForBackend', () => {
  it('passes known backends through and maps unknown to "unknown"', () => {
    expect(methodForBackend('ytdlp')).toBe('ytdlp');
    expect(methodForBackend('spotdl')).toBe('spotdl');
    expect(methodForBackend('archive')).toBe('archive');
    expect(methodForBackend('mystery')).toBe('unknown');
  });

  // Regression: URL resolvers became addons with suffixed ids, so an addon-backed
  // download rendered as "Unknown source" until these were mapped to the base method.
  it('maps the addon backend ids to their base method', () => {
    expect(methodForBackend('ytdlp-addon')).toBe('ytdlp');
    expect(methodForBackend('spotdl-addon')).toBe('spotdl');
    expect(methodForBackend('bundled-archive')).toBe('archive');
  });

  // Issue #532: same regression class for the network lane — every album-hunt
  // card since the slskd cutover rendered "?Unknown source" although the
  // Soulseek badge existed all along.
  it('maps the slskd addon ids to the Soulseek method', () => {
    expect(methodForBackend('slskd')).toBe('slskd');
    expect(methodForBackend('slskd-addon')).toBe('slskd');
  });

  // Same regression class again: `import_jobs` has always mirrored a feed row
  // with `method: 'import'`, so the 'Imported' badge was unreachable and every
  // admin import rendered "? Unknown source".
  it('maps the admin folder-import method to its own badge', () => {
    expect(methodForBackend('import')).toBe('import');
  });
});

describe('acquireJobLabel', () => {
  it('prefers the explicit label', () => {
    expect(acquireJobLabel(job({ label: 'My Playlist' }))).toBe('My Playlist');
  });
  // The lane converged onto the shared title chain: a link with a human slug in
  // its path is named from that slug rather than echoed back as a shortened URL.
  it('names an unlabelled job from the human part of its URL', () => {
    expect(acquireJobLabel(job({ url: 'https://archive.org/details/gd1977-05-08' }))).toBe(
      'Gd1977 05 08',
    );
  });

  it('reports the shape of an opaque link instead of humanizing an id', () => {
    expect(
      acquireJobLabel(
        job({ backend: 'spotdl', url: 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M' }),
      ),
    ).toBe('Spotify playlist');
  });
});

describe('acquireJobToDownloadItem', () => {
  it('prefers the job stage and computes percent while downloading', () => {
    const item = acquireJobToDownloadItem(job());
    expect(item.kind).toBe('acquire');
    expect(item.method).toBe('ytdlp');
    expect(item.stage).toBe('downloading');
    expect(item.percent).toBe(40);
    expect(item.startedAt).toBe(1_000_000);
    expect(item.canCancel).toBe(true);
  });

  it('falls back to deriving stage from state when stage is null', () => {
    expect(
      acquireJobToDownloadItem(job({ stage: null, state: 'failed', error: 'boom' })).stage,
    ).toBe('error');
    expect(acquireJobToDownloadItem(job({ stage: null, state: 'done' })).stage).toBe('done');
    expect(acquireJobToDownloadItem(job({ stage: null, state: 'queued' })).stage).toBe('queued');
  });

  it('a failed job can be retried and removed but not cancelled', () => {
    const item = acquireJobToDownloadItem(job({ state: 'failed', stage: 'error' }));
    expect(item.canRetry).toBe(true);
    expect(item.canRemove).toBe(true);
    expect(item.canCancel).toBe(false);
  });

  it('carries the deep-link album id when the job resolved one, else undefined', () => {
    expect(
      acquireJobToDownloadItem(job({ state: 'done', stage: 'done', albumId: 'acq-album-1' }))
        .albumId,
    ).toBe('acq-album-1');
    expect(acquireJobToDownloadItem(job({ albumId: null })).albumId).toBeUndefined();
  });

  it('a done job with a partial-download warning can be retried, not just removed', () => {
    const item = acquireJobToDownloadItem(
      job({
        state: 'done',
        stage: 'done',
        error: 'Downloaded 1 of 16 tracks — the rest failed or were skipped.',
      }),
    );
    expect(item.canRetry).toBe(true);
    expect(item.canRemove).toBe(true);
    expect(item.error).toContain('1 of 16');
  });

  it('a clean done job (no error) cannot be retried', () => {
    const item = acquireJobToDownloadItem(job({ state: 'done', stage: 'done', error: null }));
    expect(item.canRetry).toBe(false);
  });

  it('carries destinationAlbums through unchanged', () => {
    const destinationAlbums = [
      { albumArtist: 'Artist A', albumTitle: 'Album A', albumId: 'alb-a' },
      { albumArtist: 'Artist B', albumTitle: 'Album B', albumId: 'alb-b' },
    ];
    const item = acquireJobToDownloadItem(job({ destinationAlbums }));
    expect(item.destinationAlbums).toEqual(destinationAlbums);
  });

  it('defaults destinationAlbums to an empty array when the job has none', () => {
    const item = acquireJobToDownloadItem(job({ destinationAlbums: [] }));
    expect(item.destinationAlbums).toEqual([]);
  });

  it('carries tracks through from the acquire job onto the unified field', () => {
    const tracks = [
      { title: 'Track One', status: 'done' as const },
      { title: 'Track Two', status: 'downloading' as const },
      { title: 'Track Three', status: 'pending' as const },
    ];
    const item = acquireJobToDownloadItem(job({ tracks }));
    expect(item.tracks).toEqual(tracks);
  });

  it('surfaces bitRate + audioFormat from the acquire job for the quality chip', () => {
    const item = acquireJobToDownloadItem(job({ bitRate: 192, audioFormat: 'opus' }));
    expect(item.bitrateKbps).toBe(192);
    expect(item.audioFormat).toBe('opus');
  });
});

function acqJob(over: Partial<AcquisitionJobView> = {}): AcquisitionJobView {
  return {
    id: 'aj1',
    kind: 'album-hunt',
    method: 'slskd',
    state: 'active',
    stage: 'downloading',
    artistName: 'Artist',
    albumTitle: 'Album',
    displayTitle: null,
    sourceUrl: null,
    playlistId: null,
    lidarrAlbumId: null,
    sourceRef: 'peer',
    error: null,
    createdAt: 1000,
    updatedAt: 1000,
    albumId: 'album-id-1',
    progress: { expected: 2, delivered: 1, unavailable: 0, failed: 0, canonical: null },
    items: [],
    sources: [],
    destinationAlbums: [],
    ...over,
  };
}

describe('mergeAcquisitionJobs', () => {
  it('renders one card per network job, straight from the feed row', () => {
    const merged = mergeAcquisitionJobs([], [acqJob()]);
    expect(merged).toHaveLength(1);
    const card = merged[0]!;
    expect(card.key).toBe('job:aj1');
    expect(card.kind).toBe('network');
    expect(card.title).toBe('Album');
    expect(card.subtitle).toBe('Artist');
    expect(card.stage).toBe('downloading');
    expect(card.albumId).toBe('album-id-1');
    expect(card.progress).toEqual({ done: 1, total: 2 });
    expect(card.canCancel).toBe(true);
  });

  /**
   * #745. `progress.total` is what the *source* itemized, not the album's size.
   * El salmón is a 5-CD/103-track release whose peer offered 100 files: the
   * card read "98 of 100" and the 3 it never had were invisible.
   */
  describe('canonical denominator', () => {
    it('prefers the tracklist length and states what the source never offered', () => {
      const card = mergeAcquisitionJobs(
        [],
        [
          acqJob({
            progress: { expected: 100, delivered: 98, unavailable: 2, failed: 0, canonical: 103 },
          }),
        ],
      )[0]!;
      expect(card.progress).toEqual({ done: 98, total: 100 });
      expect(card.canonicalTotal).toBe(103);
      expect(card.notOffered).toBe(3);
    });

    it('leaves both unset when the source offered the whole tracklist', () => {
      const card = mergeAcquisitionJobs(
        [],
        [
          acqJob({
            progress: { expected: 13, delivered: 13, unavailable: 0, failed: 0, canonical: 13 },
          }),
        ],
      )[0]!;
      expect(card.canonicalTotal).toBeUndefined();
      expect(card.notOffered).toBeUndefined();
    });

    /**
     * A source may itemize *more* than the tracklist (a folder with bonus
     * tracks). That is not a shortfall, and the item count stays the truth.
     */
    it('ignores a tracklist shorter than what the source offered', () => {
      const card = mergeAcquisitionJobs(
        [],
        [
          acqJob({
            progress: { expected: 15, delivered: 15, unavailable: 0, failed: 0, canonical: 12 },
          }),
        ],
      )[0]!;
      expect(card.canonicalTotal).toBeUndefined();
      expect(card.notOffered).toBeUndefined();
    });
  });

  // Issue #587: an addon-run playlist job generates a native playlist server-
  // side and reports it on the feed row — the card's "Open playlist" opener
  // (already built, gated on DownloadItem.playlistId) just needs it mapped.
  it('carries playlistId through so a generated playlist can deep-link', () => {
    expect(mergeAcquisitionJobs([], [acqJob({ playlistId: 'pl-1' })])[0]!.playlistId).toBe('pl-1');
    expect(mergeAcquisitionJobs([], [acqJob()])[0]!.playlistId).toBeUndefined();
  });

  // Regression: an in-flight addon URL job (no resolved metadata yet) rendered
  // with an "Unknown source" chip and the raw `addon:<id>:<uuid>` transfer key
  // as its title. It shows the mapped source chip and — since the title chain —
  // the shape of the link rather than the bare word "download".
  it('renders an addon URL job with a mapped source chip and no raw addon key', () => {
    const merged = mergeAcquisitionJobs(
      [],
      [
        acqJob({
          id: 'u1',
          kind: 'url',
          method: 'spotdl-addon',
          artistName: null,
          albumTitle: null,
          sourceUrl: 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M',
          sourceRef: 'addon:spotdl-addon:767ce23a-e417-47c8-9a5b-f09129ec3443',
        }),
      ],
    );
    expect(merged).toHaveLength(1);
    const card = merged[0]!;
    expect(card.method).toBe('spotdl');
    expect(card.title).toBe('Spotify playlist');
    expect(card.title).not.toContain('addon:');
  });

  // `GET /api/acquire/jobs` now also projects addon-run URL jobs (so the Acquire
  // page's link card can see the job a pasted link started, instead of leaving
  // Get armed and inviting duplicate downloads). That projection shares the job
  // id, so the feed must render exactly one card — and it must be the unified
  // one, which carries the friendly title, the sources list and the job routes.
  it('renders an addon URL job once, from the unified lane, when both lanes carry it', () => {
    const merged = mergeAcquisitionJobs(
      [acquireJobToDownloadItem(job({ id: 'u1', backend: 'spotdl-addon', label: null }))],
      [
        acqJob({
          id: 'u1',
          kind: 'url',
          method: 'spotdl-addon',
          artistName: null,
          albumTitle: null,
          sourceRef: 'addon:spotdl-addon:767ce23a',
        }),
      ],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]!.key).toBe('job:u1');
    expect(merged[0]!.title).toBe('Spotify download');
    expect(merged[0]!.title).not.toContain('addon:');
  });

  /**
   * The user report: "download items titles are too generic". Every rung of
   * `downloadTitleFor` is exercised through the card, because the chain only
   * pays off if the adapter actually consults it.
   */
  describe('card titles', () => {
    it("prefers the addon's own display title over everything else", () => {
      const merged = mergeAcquisitionJobs(
        [],
        [
          acqJob({
            kind: 'url',
            method: 'ytdlp-addon',
            artistName: null,
            albumTitle: null,
            displayTitle: 'Summer Mix 2024',
            sourceUrl: 'https://www.youtube.com/playlist?list=PL123',
          }),
        ],
      );
      expect(merged[0]!.title).toBe('Summer Mix 2024');
    });

    it('names a finished job by the album its files landed in', () => {
      const merged = mergeAcquisitionJobs(
        [],
        [
          acqJob({
            kind: 'url',
            method: 'ytdlp-addon',
            artistName: null,
            albumTitle: null,
            stage: 'done',
            destinationAlbums: [
              { albumId: 'a1', albumArtist: 'Daft Punk', albumTitle: 'Discovery' },
            ],
          }),
        ],
      );
      expect(merged[0]!.title).toBe('Discovery');
      expect(merged[0]!.subtitle).toBe('Daft Punk');
    });

    // The user's own suggestion: the uploader's folder describes the release.
    it("names a peer grab by the uploader's folder when no metadata exists", () => {
      const merged = mergeAcquisitionJobs(
        [],
        [
          acqJob({
            kind: 'direct',
            artistName: null,
            albumTitle: null,
            items: [
              {
                title: 'x',
                status: 'downloading',
                username: 'peer',
                filename: '@@abc\\music\\Los Tekis - (1995) Toque [FLAC]\\01.mp3',
              },
            ],
          }),
        ],
      );
      expect(merged[0]!.title).toBe('Los Tekis - (1995) Toque');
    });

    // The beatport report: yt-dlp claims every unmatched link, so the card used
    // to read "YouTube download" and say nothing about what was asked for.
    it('names an unrecognized link from the human part of its path', () => {
      const merged = mergeAcquisitionJobs(
        [],
        [
          acqJob({
            kind: 'url',
            method: 'ytdlp-addon',
            artistName: null,
            albumTitle: null,
            sourceUrl:
              'https://www.beatport.com/es/release/rodopiado-veneno-feat-sophia-ardessore/7142216',
          }),
        ],
      );
      expect(merged[0]!.title).toBe('Rodopiado Veneno Feat Sophia Ardessore');
      expect(merged[0]!.subtitle).toBe('beatport.com');
    });

    it('names an import by its source folder, never the absolute server path', () => {
      const merged = mergeAcquisitionJobs(
        [],
        [
          acqJob({
            kind: 'import',
            method: 'import',
            artistName: null,
            albumTitle: null,
            displayTitle: 'Bootleg Rips 2019',
            sourceRef: '/mnt/media/incoming/Bootleg Rips 2019',
          }),
        ],
      );
      expect(merged[0]!.method).toBe('import');
      expect(merged[0]!.title).toBe('Bootleg Rips 2019');
      expect(merged[0]!.title).not.toContain('/mnt');
    });

    it('falls back to a bare artist name, and never repeats it in the subtitle', () => {
      const merged = mergeAcquisitionJobs(
        [],
        [acqJob({ albumTitle: null, artistName: 'Lone Artist' })],
      );
      expect(merged[0]!.title).toBe('Lone Artist');
      expect(merged[0]!.subtitle).toBeUndefined();
    });
  });

  it('offers "View N albums" instead of a single link when a job spanned albums', () => {
    const merged = mergeAcquisitionJobs(
      [],
      [
        acqJob({
          stage: 'done',
          destinationAlbums: [
            { albumId: 'a1', albumArtist: 'X', albumTitle: 'One' },
            { albumId: 'a2', albumArtist: 'Y', albumTitle: 'Two' },
          ],
        }),
      ],
    );
    expect(merged[0]!.destinationAlbums).toHaveLength(2);
    // Both controls rendering at once would be the bug; the acquire lane has
    // always nulled the singular id in this case.
    expect(merged[0]!.albumId).toBeUndefined();
  });

  it('keeps the single deep-link when exactly one album received the files', () => {
    const merged = mergeAcquisitionJobs(
      [],
      [
        acqJob({
          stage: 'done',
          destinationAlbums: [{ albumId: 'a1', albumArtist: 'X', albumTitle: 'One' }],
        }),
      ],
    );
    expect(merged[0]!.albumId).toBe('album-id-1');
  });

  /**
   * A stuck card must always have an escape. The addon-URL ghost card (a link
   * yt-dlp cannot download) had `canRetry: false`, `canCancel` gated on
   * 'downloading' and `canRemove` gated on a terminal stage — so a job stuck
   * mid-stage offered nothing at all.
   */
  describe('card controls', () => {
    it('lets a queued job be cancelled — it is mirrored before the addon starts', () => {
      const merged = mergeAcquisitionJobs([], [acqJob({ kind: 'url', stage: 'queued' })]);
      expect(merged[0]!.canCancel).toBe(true);
    });

    it('offers Retry on a failed URL acquire, which the acquire route supports', () => {
      const merged = mergeAcquisitionJobs([], [acqJob({ kind: 'url', stage: 'error' })]);
      expect(merged[0]!.canRetry).toBe(true);
      expect(merged[0]!.jobId).toBe('aj1');
    });

    /**
     * A spotDL playlist that landed 5 of 89 closes `done` carrying the addon's
     * partial warning, so gating Retry on `stage === 'error'` hid it on the one
     * card where retry actually resumes (spotDL is spawned `--overwrite skip`).
     */
    it('offers Retry on a partial URL acquire that closed done with a warning', () => {
      const merged = mergeAcquisitionJobs(
        [],
        [
          acqJob({
            kind: 'url',
            stage: 'done',
            error: 'Downloaded 5 of 89 tracks — the rest failed or were skipped.',
            progress: { expected: 89, delivered: 5, unavailable: 84, failed: 0, canonical: null },
          }),
        ],
      );
      expect(merged[0]!.canRetry).toBe(true);
    });

    /**
     * The addon error mirror is two-way: an active job carries the addon's
     * *current* error (a transient "retrying: 429"), which is not a terminal
     * outcome — offering Retry there would restart a download still running.
     */
    it('never offers Retry on an active URL job carrying a transient error', () => {
      const merged = mergeAcquisitionJobs(
        [],
        [acqJob({ kind: 'url', stage: 'downloading', error: 'retrying: HTTP 429' })],
      );
      expect(merged[0]!.canRetry).toBe(false);
    });

    it('never offers Retry on a clean done URL acquire', () => {
      const merged = mergeAcquisitionJobs([], [acqJob({ kind: 'url', stage: 'done' })]);
      expect(merged[0]!.canRetry).toBe(false);
    });

    it('breaks a partial job down by failure class for the card', () => {
      const merged = mergeAcquisitionJobs(
        [],
        [
          acqJob({
            kind: 'url',
            stage: 'done',
            error: [
              'Downloaded 1 of 3 tracks — the rest failed or were skipped.',
              'https://open.spotify.com/track/a - JSONDecodeError: Expecting value: line 1 column 1 (char 0)',
              'https://open.spotify.com/track/b - LookupError: No results found for song: X',
            ].join('\n'),
          }),
        ],
      );
      expect(merged[0]!.failures).toEqual([
        {
          class: 'transient',
          count: 1,
          example: 'JSONDecodeError: Expecting value: line 1 column 1 (char 0)',
        },
        { class: 'unknown', count: 1, example: 'LookupError: No results found for song: X' },
      ]);
    });

    it('leaves the breakdown off a hard error carrying no per-track detail', () => {
      const merged = mergeAcquisitionJobs(
        [],
        [acqJob({ kind: 'url', stage: 'error', error: 'JSONDecodeError: Expecting value' })],
      );
      expect(merged[0]!.failures).toBeUndefined();
    });

    it('never offers Retry on a network hunt, which has no re-submit endpoint', () => {
      const merged = mergeAcquisitionJobs([], [acqJob({ kind: 'album-hunt', stage: 'error' })]);
      expect(merged[0]!.canRetry).toBe(false);
    });

    it('is always removable — the delete route drops the row at any stage', () => {
      for (const stage of ['queued', 'downloading', 'scanning', 'error', 'done'] as const) {
        expect(mergeAcquisitionJobs([], [acqJob({ stage })])[0]!.canRemove).toBe(true);
      }
    });

    /**
     * An import card is a mirror row with no addon behind it: the job-scoped
     * cancel route always 400s for one, and that failure is now toasted rather
     * than swallowed — so offering the button would be a visible regression.
     */
    it('never offers Cancel on an import card', () => {
      for (const stage of ['queued', 'downloading', 'scanning'] as const) {
        const card = mergeAcquisitionJobs(
          [],
          [acqJob({ kind: 'import', method: 'import', stage })],
        )[0]!;
        expect(card.canCancel).toBe(false);
      }
    });

    it('only lets a finished import be removed — import_jobs owns a live one', () => {
      const running = mergeAcquisitionJobs(
        [],
        [acqJob({ kind: 'import', method: 'import', stage: 'organizing' })],
      )[0]!;
      expect(running.canRemove).toBe(false);
      const finished = mergeAcquisitionJobs(
        [],
        [acqJob({ kind: 'import', method: 'import', stage: 'done' })],
      )[0]!;
      expect(finished.canRemove).toBe(true);
    });
  });

  it('still lets the in-process acquire lane own a non-addon URL job', () => {
    const merged = mergeAcquisitionJobs(
      [acquireJobToDownloadItem(job({ id: 'u2', label: 'My playlist' }))],
      [acqJob({ id: 'u2', kind: 'url', method: 'ytdlp', sourceRef: 'https://youtu.be/x' })],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]!.key).toBe('u2');
    expect(merged[0]!.title).toBe('My playlist');
  });

  /**
   * Issue #261: card identity used to be re-derived from `albumId` at read
   * time, so the same album acquired twice collapsed into one card. Identity
   * is the job the server recorded at enqueue time.
   */
  it('keeps two separate jobs for the SAME album as two cards', () => {
    const merged = mergeAcquisitionJobs([], [acqJob({ id: 'job-1' }), acqJob({ id: 'job-2' })]);
    expect(merged).toHaveLength(2);
    expect(merged.map((m) => m.key).sort()).toEqual(['job:job-1', 'job:job-2']);
  });

  it("exposes the job's peer breakdown on the card", () => {
    const merged = mergeAcquisitionJobs(
      [],
      [
        acqJob({
          sources: [
            { username: 'smuks-aef771', fileCount: 10, state: 'done' },
            { username: 'dolche', fileCount: 1, state: 'failed' },
          ],
        }),
      ],
    );
    expect(merged[0]!.sources).toHaveLength(2);
    expect(merged[0]!.sources?.[0].username).toBe('smuks-aef771');
  });

  it('annotates unavailable tracks so the row reads as an honest partial', () => {
    const merged = mergeAcquisitionJobs(
      [],
      [
        acqJob({
          state: 'done',
          stage: 'done',
          progress: { expected: 13, delivered: 11, unavailable: 2, failed: 0, canonical: null },
        }),
      ],
    );
    expect(merged[0]!.stage).toBe('done');
    expect(merged[0]!.unavailable).toBe(2);
  });

  it("carries the job's per-item statuses through onto the unified tracks field", () => {
    const items = [
      { title: 'Track One', status: 'done' as const },
      { title: 'Track Two', status: 'downloading' as const },
    ];
    const merged = mergeAcquisitionJobs([], [acqJob({ items })]);
    expect(merged[0]!.tracks).toEqual(items);
  });

  it('renders an addon-backed url job (no acquire-lane twin)', () => {
    // An addon url job has only an acquisition_jobs row → it renders through the
    // unified lane like a network job (#509 cause 1).
    const merged = mergeAcquisitionJobs(
      [],
      [acqJob({ id: 'u1', kind: 'url', method: 'bundled-archive' })],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]!.key).toBe('job:u1');
  });

  it('skips a url job already rendered by the in-process acquire lane', () => {
    // The in-process url job shares its id with an acquire-lane card (same UUID)
    // → skip the mirror to avoid a double card.
    const acquireItem = {
      key: 'u2',
      kind: 'acquire',
      title: 't',
      method: 'spotdl',
      stage: 'downloading',
    } as DownloadItem;
    const merged = mergeAcquisitionJobs(
      [acquireItem],
      [acqJob({ id: 'u2', kind: 'url', method: 'spotdl' })],
    );
    expect(merged).toHaveLength(1);
    expect(merged.every((m) => m.kind !== 'network')).toBe(true); // only the acquire card, no mirror
  });

  it('renders finished jobs too — the feed row alone carries a card since phase 3', () => {
    const merged = mergeAcquisitionJobs([], [acqJob({ state: 'done', stage: 'done' })]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.stage).toBe('done');
    expect(merged[0]!.canRemove).toBe(true);
  });

  it('keeps URL-lane items and sorts active stages before terminal ones', () => {
    const merged = mergeAcquisitionJobs(
      buildDownloadFeed([
        job({ id: 'url-running', stage: 'downloading' }),
        job({ id: 'url-done', state: 'done', stage: 'done' }),
      ]),
      [acqJob({ state: 'done', stage: 'done' })],
    );
    expect(merged.map((i) => i.stage)).toEqual(['downloading', 'done', 'done']);
    expect(merged[0]!.key).toBe('url-running');
  });
});

describe('buildDownloadFeed', () => {
  it('sorts active stages before terminal ones', () => {
    const feed = buildDownloadFeed([
      job({ id: 'done', state: 'done', stage: 'done' }),
      job({ id: 'running', stage: 'downloading' }),
      job({ id: 'failed', state: 'failed', stage: 'error' }),
    ]);
    expect(feed.map((i) => i.stage)).toEqual(['downloading', 'error', 'done']);
  });
});

describe('jobPercent (#805)', () => {
  const progress = (over: Partial<AcquisitionJobView['progress']> = {}) => ({
    expected: 9,
    delivered: 0,
    unavailable: 0,
    failed: 0,
    canonical: null,
    ...over,
  });

  it('is bytes-weighted when the addon reports byte progress', () => {
    expect(jobPercent(progress({ bytesTransferred: 430, bytesTotal: 1000 }))).toBe(43);
  });

  it('caps the byte percentage at 99 — the count chip is what says all landed', () => {
    expect(jobPercent(progress({ bytesTransferred: 999, bytesTotal: 1000 }))).toBe(99);
    expect(jobPercent(progress({ bytesTransferred: 1000, bytesTotal: 1000 }))).toBe(99);
  });

  it('falls back to whole-file counts without byte data', () => {
    expect(jobPercent(progress({ delivered: 3 }))).toBe(33);
    expect(jobPercent(progress({ bytesTransferred: null, bytesTotal: null, delivered: 3 }))).toBe(
      33,
    );
  });

  it('is undefined when nothing is countable', () => {
    expect(jobPercent(progress({ expected: 0 }))).toBeUndefined();
  });
});

describe('network-lane percent + cancelRequested (#805/#806)', () => {
  it('a downloading slskd job renders the bar from bytes', () => {
    const merged = mergeAcquisitionJobs(
      [],
      [
        acqJob({
          progress: {
            expected: 9,
            delivered: 0,
            unavailable: 0,
            failed: 0,
            canonical: null,
            bytesTransferred: 430,
            bytesTotal: 1000,
          },
        }),
      ],
    );
    expect(merged[0]!.percent).toBe(43);
  });

  it('the bar disappears once the job leaves the downloading stage', () => {
    const merged = mergeAcquisitionJobs(
      [],
      [
        acqJob({
          stage: 'organizing',
          progress: {
            expected: 9,
            delivered: 9,
            unavailable: 0,
            failed: 0,
            canonical: null,
            bytesTransferred: 1000,
            bytesTotal: 1000,
          },
        }),
      ],
    );
    expect(merged[0]!.percent).toBeUndefined();
  });

  it('carries the durable cancelRequested marker onto the card', () => {
    const merged = mergeAcquisitionJobs([], [acqJob({ cancelRequested: true })]);
    expect(merged[0]!.cancelRequested).toBe(true);
    expect(mergeAcquisitionJobs([], [acqJob()])[0]!.cancelRequested).toBeUndefined();
  });
});
