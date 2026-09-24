import type { LibraryHealthReport, MaintenanceStatus } from '../../../services/api/api-types';

export type HealthDimension = keyof LibraryHealthReport['dimensions'];

type Translate = (key: string, params?: Record<string, string | number>) => string;

export interface HealthMetric {
  labelKey: string;
  /** Already formatted for display — `null` metrics become "not measured". */
  value: string;
}

export interface HealthRow {
  label: string;
  detail: string;
  /** Router commands; present only where the app has a page for the row. */
  link: string[] | null;
}

export interface HealthList {
  titleKey: string;
  rows: HealthRow[];
}

export interface HealthAction {
  task: NonNullable<MaintenanceStatus['taskId']>;
  labelKey: string;
  /** Goes through the shared confirm host before it POSTs. */
  destructive: boolean;
}

export interface HealthCard {
  dimension: HealthDimension;
  titleKey: string;
  metrics: HealthMetric[];
  lists: HealthList[];
  remediation: string;
  action: HealthAction | null;
  link: { labelKey: string; commands: string[] } | null;
}

/**
 * Dimension → the maintenance task whose candidate set IS that dimension's
 * metric (the report's "a metric is what its remediation acts on" rule). Only
 * tasks that exist in `MAINTENANCE_TASK_IDS`; everything else is a human or
 * MCP judgement and gets a deep link instead of a button.
 */
export const HEALTH_ACTIONS: Partial<Record<HealthDimension, HealthAction>> = {
  albumCovers: {
    task: 'artwork-backfill',
    labelKey: 'admin.health.action.artworkBackfill',
    destructive: false,
  },
  years: {
    task: 'metadata-optimize',
    labelKey: 'admin.health.action.metadataOptimize',
    destructive: false,
  },
  classification: {
    task: 'metadata-optimize',
    labelKey: 'admin.health.action.metadataOptimize',
    destructive: false,
  },
  formatCohesion: {
    task: 'transcode-library',
    labelKey: 'admin.health.action.transcodeLibrary',
    destructive: true,
  },
};

/** The count each action would act on: a button over an empty set is noise. */
function actionable(r: LibraryHealthReport, d: HealthDimension): boolean {
  const m = r.dimensions;
  switch (d) {
    case 'albumCovers':
      return m.albumCovers.metric.missing > 0;
    case 'years':
      return m.years.metric.missing > 0;
    case 'classification':
      return m.classification.metric.visibleUnknown > 0;
    case 'formatCohesion':
      return m.formatCohesion.metric.losslessSongs > 0;
    default:
      return false;
  }
}

const albumLink = (id: string | null): string[] | null => (id ? ['/library/albums', id] : null);

/**
 * Report → one view-model card per dimension, in the report's own order. Pure
 * so the mapping is tested without a component: the template only iterates.
 */
export function buildHealthCards(r: LibraryHealthReport, t: Translate): HealthCard[] {
  const n = (v: number) => v.toLocaleString();
  const opt = (v: number | null) => (v == null ? t('admin.health.notMeasured') : n(v));
  const when = (ms: number | null) => (ms == null ? '—' : new Date(ms).toLocaleString());
  const metric = (dim: string, name: string, value: string): HealthMetric => ({
    labelKey: `admin.health.${dim}.${name}`,
    value,
  });
  const d = r.dimensions;

  const cards: Omit<HealthCard, 'action'>[] = [
    {
      dimension: 'audit',
      titleKey: 'admin.health.audit.title',
      metrics: [
        metric('audit', 'high', n(d.audit.metric.high)),
        metric('audit', 'medium', n(d.audit.metric.medium)),
        metric('audit', 'low', n(d.audit.metric.low)),
      ],
      lists: [
        {
          titleKey: 'admin.health.audit.list',
          rows: d.audit.worklist.map((w) => ({
            label: w.rule,
            detail: t('admin.health.row.auditRule', { severity: w.severity, count: n(w.count) }),
            link: null,
          })),
        },
      ],
      remediation: d.audit.remediation,
      link: null,
    },
    {
      dimension: 'fragments',
      titleKey: 'admin.health.fragments.title',
      metrics: [
        metric('fragments', 'duplicateAlbums', n(d.fragments.metric.duplicateAlbums)),
        metric('fragments', 'hiddenByClassification', n(d.fragments.metric.hiddenByClassification)),
        metric('fragments', 'misSplitAlbums', n(d.fragments.metric.misSplitAlbums)),
      ],
      lists: [
        {
          titleKey: 'admin.health.fragments.list',
          rows: d.fragments.worklist.map((w) => ({
            label: w.displayTitle,
            detail: t('admin.health.row.fragment', {
              members: n(w.members),
              songs: n(w.totalSongs),
              spellings: w.artistSpellings.join(' / '),
            }),
            link: null,
          })),
        },
      ],
      remediation: d.fragments.remediation,
      link: null,
    },
    {
      dimension: 'albumCovers',
      titleKey: 'admin.health.albumCovers.title',
      metrics: [
        metric('albumCovers', 'visible', n(d.albumCovers.metric.visible)),
        metric('albumCovers', 'missing', n(d.albumCovers.metric.missing)),
        metric('albumCovers', 'missingMultiTrack', n(d.albumCovers.metric.missingMultiTrack)),
        metric('albumCovers', 'noEmbeddedArt', n(d.albumCovers.metric.noEmbeddedArt)),
        metric('albumCovers', 'unrenderable', opt(d.albumCovers.metric.unrenderable)),
      ],
      lists: [
        {
          titleKey: 'admin.health.albumCovers.list',
          rows: d.albumCovers.worklist.map((w) => ({
            label: w.name,
            detail: t('admin.health.row.albumSongs', { artist: w.artist, songs: n(w.songCount) }),
            link: albumLink(w.albumId),
          })),
        },
      ],
      remediation: d.albumCovers.remediation,
      link: null,
    },
    {
      dimension: 'artistPortraits',
      titleKey: 'admin.health.artistPortraits.title',
      metrics: [
        metric('artistPortraits', 'visible', n(d.artistPortraits.metric.visible)),
        metric('artistPortraits', 'withPortrait', n(d.artistPortraits.metric.withPortrait)),
        metric('artistPortraits', 'missing', n(d.artistPortraits.metric.missing)),
        metric('artistPortraits', 'manualOverride', n(d.artistPortraits.metric.manualOverride)),
      ],
      lists: [],
      remediation: d.artistPortraits.remediation,
      link: null,
    },
    {
      dimension: 'genres',
      titleKey: 'admin.health.genres.title',
      metrics: [
        metric('genres', 'songs', n(d.genres.metric.songs)),
        metric('genres', 'missing', n(d.genres.metric.missing)),
        metric('genres', 'lowInformation', n(d.genres.metric.lowInformation)),
      ],
      lists: [
        {
          titleKey: 'admin.health.genres.list',
          rows: d.genres.worklist.map((w) => ({ label: w.title, detail: w.artist, link: null })),
        },
        {
          titleKey: 'admin.health.genres.lowInformationList',
          rows: d.genres.lowInformationWorklist.map((w) => ({
            label: w.artist,
            detail: t('admin.health.row.genreArtist', { genre: w.genre, songs: n(w.songs) }),
            link: ['/library/artists', w.artistId],
          })),
        },
      ],
      remediation: d.genres.remediation,
      link: null,
    },
    {
      dimension: 'years',
      titleKey: 'admin.health.years.title',
      metrics: [
        metric('years', 'visibleAlbums', n(d.years.metric.visibleAlbums)),
        metric('years', 'missing', n(d.years.metric.missing)),
        metric('years', 'missingMultiTrack', n(d.years.metric.missingMultiTrack)),
      ],
      lists: [
        {
          titleKey: 'admin.health.years.list',
          rows: d.years.worklist.map((w) => ({
            label: w.name,
            detail: t('admin.health.row.albumSongs', { artist: w.artist, songs: n(w.songCount) }),
            link: albumLink(w.albumId),
          })),
        },
      ],
      remediation: d.years.remediation,
      link: null,
    },
    {
      dimension: 'classification',
      titleKey: 'admin.health.classification.title',
      metrics: [
        metric('classification', 'visibleUnknown', n(d.classification.metric.visibleUnknown)),
        metric('classification', 'oversized', n(d.classification.metric.oversized)),
        metric('classification', 'hidden', n(d.classification.metric.hidden)),
        metric('classification', 'hiddenUnjustified', n(d.classification.metric.hiddenUnjustified)),
      ],
      lists: [
        {
          titleKey: 'admin.health.classification.list',
          rows: d.classification.worklist.map((w) => ({
            label: w.name,
            detail: t('admin.health.row.classification', {
              artist: w.artist,
              songs: n(w.songCount),
              reason: w.reason,
            }),
            link: albumLink(w.albumId),
          })),
        },
      ],
      remediation: d.classification.remediation,
      link: null,
    },
    {
      dimension: 'formatCohesion',
      titleKey: 'admin.health.formatCohesion.title',
      metrics: [
        metric('formatCohesion', 'mixedFormatAlbums', n(d.formatCohesion.metric.mixedFormatAlbums)),
        metric('formatCohesion', 'lowBitrateAlbums', n(d.formatCohesion.metric.lowBitrateAlbums)),
        metric('formatCohesion', 'losslessSongs', n(d.formatCohesion.metric.losslessSongs)),
      ],
      lists: [
        {
          titleKey: 'admin.health.formatCohesion.mixedList',
          rows: d.formatCohesion.worklist.mixed.map((w) => ({
            label: w.name,
            detail: t('admin.health.row.mixedFormat', {
              artist: w.artist,
              suffixes: w.suffixes.join(', '),
            }),
            link: albumLink(w.albumId),
          })),
        },
        {
          titleKey: 'admin.health.formatCohesion.lowBitrateList',
          rows: d.formatCohesion.worklist.lowBitrate.map((w) => ({
            label: w.name,
            detail: t('admin.health.row.lowBitrate', {
              artist: w.artist,
              kbps: Math.round(w.avgKbps),
            }),
            link: albumLink(w.albumId),
          })),
        },
      ],
      remediation: d.formatCohesion.remediation,
      link: null,
    },
    {
      dimension: 'completeness',
      titleKey: 'admin.health.completeness.title',
      metrics: [
        metric('completeness', 'confirmedIncomplete', n(d.completeness.metric.confirmedIncomplete)),
        metric('completeness', 'suspected', n(d.completeness.metric.suspected)),
        metric('completeness', 'titleMismatch', n(d.completeness.metric.titleMismatch)),
        metric('completeness', 'liveTracklists', opt(d.completeness.metric.liveTracklists)),
      ],
      lists: [
        {
          titleKey: 'admin.health.completeness.confirmedList',
          rows: d.completeness.worklist.confirmed.map((w) => ({
            label: w.album,
            detail: t('admin.health.row.confirmed', {
              artist: w.artist,
              owned: n(w.owned),
              expected: n(w.expected),
              state: w.state,
            }),
            link: albumLink(w.albumId),
          })),
        },
        {
          titleKey: 'admin.health.completeness.titleMismatchList',
          rows: d.completeness.worklist.titleMismatches.map((w) => ({
            label: w.album,
            detail: t('admin.health.row.titleMismatch', {
              artist: w.artist,
              unmatched: n(w.unmatched),
            }),
            link: albumLink(w.albumId),
          })),
        },
        {
          titleKey: 'admin.health.completeness.suspectedList',
          rows: d.completeness.worklist.suspected.map((w) => ({
            label: w.name,
            detail: t('admin.health.row.suspected', {
              artist: w.artist,
              disc: w.disc,
              numbered: n(w.numbered),
              maxTrack: n(w.maxTrack),
            }),
            link: albumLink(w.albumId),
          })),
        },
      ],
      remediation: d.completeness.remediation,
      link: null,
    },
    {
      dimension: 'disk',
      titleKey: 'admin.health.disk.title',
      metrics: [
        metric('disk', 'wronglyOrphaned', opt(d.disk.metric.wronglyOrphaned)),
        metric('disk', 'measuredAt', when(d.disk.metric.measuredAt)),
      ],
      lists: [],
      remediation: d.disk.remediation,
      link: null,
    },
    {
      dimension: 'lyrics',
      titleKey: 'admin.health.lyrics.title',
      metrics: [
        metric('lyrics', 'songs', n(d.lyrics.metric.songs)),
        metric('lyrics', 'withLyrics', n(d.lyrics.metric.withLyrics)),
        metric('lyrics', 'suspectMatches', n(d.lyrics.metric.suspectMatches)),
        metric('lyrics', 'unverified', n(d.lyrics.metric.unverified)),
        metric('lyrics', 'synced', n(d.lyrics.metric.synced)),
        metric('lyrics', 'syncedBeyondDuration', n(d.lyrics.metric.syncedBeyondDuration)),
      ],
      lists: [
        {
          titleKey: 'admin.health.lyrics.list',
          rows: d.lyrics.worklist.map((w) => ({
            label: w.title,
            detail: t('admin.health.row.lyrics', {
              artist: w.artist,
              delta: Math.round(w.deltaSec),
              reason: w.reason,
            }),
            link: null,
          })),
        },
      ],
      remediation: d.lyrics.remediation,
      link: null,
    },
    {
      dimension: 'flags',
      titleKey: 'admin.health.flags.title',
      metrics: [
        metric('flags', 'open', n(d.flags.metric.open)),
        metric('flags', 'oldestAt', when(d.flags.metric.oldestAt)),
      ],
      lists: [],
      remediation: d.flags.remediation,
      // The human-judgement queue already has a page: the triage round.
      link:
        d.flags.metric.open > 0
          ? { labelKey: 'admin.health.flags.openTriage', commands: ['/library/curate'] }
          : null,
    },
  ];

  return cards.map((c) => ({
    ...c,
    // An empty sub-list is dropped rather than rendered as a bare heading.
    lists: c.lists.filter((l) => l.rows.length > 0),
    action: actionable(r, c.dimension) ? (HEALTH_ACTIONS[c.dimension] ?? null) : null,
  }));
}
