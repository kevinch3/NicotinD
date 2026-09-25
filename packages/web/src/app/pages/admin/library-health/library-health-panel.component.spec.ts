import { describe, expect, it, vi, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { LibraryHealthPanelComponent } from './library-health-panel.component';
import { buildHealthCards } from './library-health-cards.lib';
import { LibraryApiService } from '../../../services/api/library-api.service';
import { ConfirmService } from '../../../services/confirm.service';
import { ServiceReviewService } from '../../../services/service-review.service';
import { TranslateService } from '../../../services/translate.service';
import type { LibraryHealthReport, MaintenanceStatus } from '../../../services/api/api-types';
import EN from '../../../../../public/i18n/en.json';
import ES from '../../../../../public/i18n/es.json';

/** Every dimension populated, so each card has something to render. */
function makeReport(over: Partial<LibraryHealthReport['totals']> = {}): LibraryHealthReport {
  const album = { albumId: 'al1', name: 'Drukqs', artist: 'Aphex Twin' };
  return {
    collectedAt: 1_700_000_000_000,
    totals: { artists: 3, albums: 4, visibleAlbums: 4, songs: 24, ...over },
    dimensions: {
      audit: {
        metric: { high: 1, medium: 2, low: 3 },
        worklist: [{ rule: 'orphan_file', severity: 'high', count: 1 }],
        remediation: 'audit-remediation',
      },
      fragments: {
        metric: { duplicateAlbums: 1, hiddenByClassification: 0, misSplitAlbums: 0 },
        worklist: [
          { displayTitle: 'Selected', members: 2, totalSongs: 9, artistSpellings: ['A', 'a'] },
        ],
        remediation: 'fragments-remediation',
      },
      albumCovers: {
        metric: {
          visible: 4,
          missing: 2,
          missingMultiTrack: 1,
          noEmbeddedArt: 1,
          unrenderable: null,
        },
        worklist: [{ ...album, songCount: 12 }],
        remediation: 'covers-remediation',
      },
      artistPortraits: {
        metric: { visible: 3, withPortrait: 1, missing: 2, manualOverride: 0 },
        remediation: 'portraits-remediation',
      },
      genres: {
        metric: { songs: 24, missing: 1, lowInformation: 3 },
        worklist: [{ songId: 's1', title: 'Avril 14th', artist: 'Aphex Twin' }],
        lowInformationWorklist: [
          { artistId: 'ar1', artist: 'Aphex Twin', genre: 'Electronic', songs: 3 },
        ],
        remediation: 'genres-remediation',
      },
      years: {
        metric: { visibleAlbums: 4, missing: 1, missingMultiTrack: 1 },
        worklist: [{ ...album, songCount: 12 }],
        remediation: 'years-remediation',
      },
      classification: {
        metric: { visibleUnknown: 0, oversized: 0, hidden: 0, hiddenUnjustified: 0 },
        worklist: [],
        remediation: 'classification-remediation',
      },
      formatCohesion: {
        metric: { mixedFormatAlbums: 1, lowBitrateAlbums: 0, losslessSongs: 7 },
        worklist: {
          mixed: [{ ...album, songCount: 12, suffixes: ['flac', 'mp3'] }],
          lowBitrate: [],
        },
        remediation: 'format-remediation',
      },
      completeness: {
        metric: { confirmedIncomplete: 1, suspected: 0, titleMismatch: 0, liveTracklists: null },
        worklist: {
          confirmed: [
            {
              albumId: null,
              artist: 'Boards of Canada',
              album: 'Geogaddi',
              expected: 23,
              owned: 20,
              missing: 3,
              lidarrAlbumId: 5,
              state: 'done',
            },
          ],
          suspected: [],
          titleMismatches: [],
        },
        remediation: 'completeness-remediation',
      },
      disk: { metric: { wronglyOrphaned: 0, measuredAt: null }, remediation: 'disk-remediation' },
      lyrics: {
        metric: {
          songs: 24,
          withLyrics: 2,
          suspectMatches: 0,
          unverified: 0,
          synced: 0,
          syncedBeyondDuration: 0,
        },
        worklist: [],
        remediation: 'lyrics-remediation',
      },
      duplicateSongs: {
        metric: { clusters: 1, redundantFiles: 1 },
        worklist: [
          {
            title: 'Más cerca del cielo',
            artist: 'Los Pericos',
            copies: 2,
            albums: ['Pampas Reggae'],
          },
        ],
        remediation: 'dupes-remediation',
      },
      flags: { metric: { open: 2, oldestAt: 1 }, remediation: 'flags-remediation' },
    },
  };
}

const DIMENSIONS = Object.keys(makeReport().dimensions);

describe('LibraryHealthPanelComponent', () => {
  const getLibraryHealth = vi.fn();
  const startMaintenance = vi.fn();
  const ask = vi.fn();
  const refresh = vi.fn(async () => undefined);
  const maintenance = signal<MaintenanceStatus | null>(null);

  beforeEach(async () => {
    localStorage.clear();
    getLibraryHealth.mockReset().mockReturnValue(of(makeReport()));
    startMaintenance.mockReset().mockReturnValue(of({ ok: true, started: true }));
    ask.mockReset().mockResolvedValue(true);
    maintenance.set(null);

    await TestBed.configureTestingModule({
      imports: [LibraryHealthPanelComponent],
      providers: [
        provideRouter([]),
        { provide: LibraryApiService, useValue: { getLibraryHealth, startMaintenance } },
        { provide: ConfirmService, useValue: { ask } },
        { provide: ServiceReviewService, useValue: { maintenance, refresh } },
        {
          provide: TranslateService,
          useValue: { t: (k: string) => k, lang: () => 'en', revision: () => 0 },
        },
      ],
    }).compileComponents();
  });

  async function settle(fixture: { detectChanges(): void; whenStable(): Promise<unknown> }) {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  /**
   * Expand the group, then fire its `opened` hook by hand: this JIT harness
   * wires neither signal inputs nor signal outputs on a nested component (see
   * src/testing/signal-input.ts), so the `(opened)` binding itself is the e2e
   * spec's to prove (admin-library-health.spec.ts asserts no request before
   * expand, and one after).
   */
  async function renderOpen() {
    const fixture = TestBed.createComponent(LibraryHealthPanelComponent);
    await settle(fixture);
    const el = fixture.nativeElement as HTMLElement;
    el.querySelector<HTMLButtonElement>('[data-testid="settings-group-toggle"]')!.click();
    fixture.componentInstance.onOpened();
    await settle(fixture);
    return { fixture, el, c: fixture.componentInstance };
  }

  it('does not fetch on render — only when opened, and only once', async () => {
    const fixture = TestBed.createComponent(LibraryHealthPanelComponent);
    await settle(fixture);
    expect(getLibraryHealth).not.toHaveBeenCalled();

    fixture.componentInstance.onOpened();
    await settle(fixture);
    expect(getLibraryHealth).toHaveBeenCalledTimes(1);

    // Re-opening keeps the report rather than re-issuing the query.
    fixture.componentInstance.onOpened();
    await settle(fixture);
    expect(getLibraryHealth).toHaveBeenCalledTimes(1);
  });

  it('Refresh re-fetches', async () => {
    const { fixture, el } = await renderOpen();
    el.querySelector<HTMLButtonElement>('[data-testid="library-health-refresh"]')!.click();
    await settle(fixture);
    expect(getLibraryHealth).toHaveBeenCalledTimes(2);
  });

  it('renders one card per report dimension, with metrics, worklist and remediation', async () => {
    const { el } = await renderOpen();
    const dims = makeReport().dimensions as Record<string, { remediation: string }>;
    for (const d of DIMENSIONS) {
      const card = el.querySelector(`[data-testid="health-card-${d}"]`);
      expect(card, d).toBeTruthy();
      expect(card!.textContent).toContain(dims[d]!.remediation);
    }
    const covers = el.querySelector('[data-testid="health-card-albumCovers"]')!;
    expect(covers.textContent).toContain('covers-remediation');
    // #951: the duplicate count and its largest cluster reach the card.
    expect(el.querySelector('[data-testid="health-card-duplicateSongs"]')!.textContent).toContain(
      'Los Pericos',
    );
    expect(covers.textContent).toContain('Drukqs');
    // A null metric is "not measured", never a number.
    expect(covers.textContent).toContain('admin.health.notMeasured');
  });

  it('links worklist rows only where the app has a page for them', async () => {
    const { el } = await renderOpen();
    const coverLink = el.querySelector<HTMLAnchorElement>(
      '[data-testid="health-card-albumCovers"] [data-testid="health-row-link"]',
    )!;
    expect(coverLink.getAttribute('href')).toBe('/library/albums/al1');
    const artistLink = el.querySelector<HTMLAnchorElement>(
      '[data-testid="health-card-genres"] [data-testid="health-row-link"]',
    )!;
    expect(artistLink.getAttribute('href')).toBe('/library/artists/ar1');
    // A confirmed-incomplete row with no local album id has nowhere to go.
    expect(
      el.querySelector('[data-testid="health-card-completeness"] [data-testid="health-row-link"]'),
    ).toBeNull();
    expect(el.querySelector('[data-testid="health-link-flags"]')!.getAttribute('href')).toBe(
      '/library/curate',
    );
  });

  it('offers a maintenance pass only where one acts on a non-zero metric', async () => {
    const { el } = await renderOpen();
    expect(el.querySelector('[data-testid="health-action-albumCovers"]')).toBeTruthy();
    expect(el.querySelector('[data-testid="health-action-years"]')).toBeTruthy();
    expect(el.querySelector('[data-testid="health-action-formatCohesion"]')).toBeTruthy();
    // visibleUnknown is 0 in the fixture.
    expect(el.querySelector('[data-testid="health-action-classification"]')).toBeNull();
    expect(el.querySelector('[data-testid="health-action-genres"]')).toBeNull();
  });

  it('a non-destructive remediation starts its task directly', async () => {
    const { fixture, el } = await renderOpen();
    el.querySelector<HTMLButtonElement>('[data-testid="health-action-albumCovers"]')!.click();
    await settle(fixture);
    expect(ask).not.toHaveBeenCalled();
    expect(startMaintenance).toHaveBeenCalledWith('artwork-backfill');
    expect(refresh).toHaveBeenCalled();

    startMaintenance.mockClear();
    el.querySelector<HTMLButtonElement>('[data-testid="health-action-years"]')!.click();
    await settle(fixture);
    expect(startMaintenance).toHaveBeenCalledWith('metadata-optimize');
  });

  it('the destructive transcode goes through the shared confirm host, and a no stops it', async () => {
    const { fixture, el, c } = await renderOpen();
    ask.mockResolvedValueOnce(false);
    el.querySelector<HTMLButtonElement>('[data-testid="health-action-formatCohesion"]')!.click();
    await settle(fixture);
    expect(ask).toHaveBeenCalledWith('admin.health.confirmTranscode');
    expect(startMaintenance).not.toHaveBeenCalled();

    await c.runAction(c.cards().find((card) => card.dimension === 'formatCohesion')!);
    expect(ask).toHaveBeenCalledTimes(2);
    expect(startMaintenance).toHaveBeenCalledWith('transcode-library');
  });

  it('a running pass disables every remediation button', async () => {
    const { fixture, el } = await renderOpen();
    maintenance.set({ phase: 'running' } as MaintenanceStatus);
    fixture.detectChanges();
    const btn = el.querySelector<HTMLButtonElement>('[data-testid="health-action-albumCovers"]')!;
    expect(btn.disabled).toBe(true);
  });

  it('a busy server is reported, not swallowed', async () => {
    startMaintenance.mockReturnValueOnce(throwError(() => ({ status: 409 })));
    const { fixture, el } = await renderOpen();
    el.querySelector<HTMLButtonElement>('[data-testid="health-action-albumCovers"]')!.click();
    await settle(fixture);
    expect(el.querySelector('[data-testid="library-health-action-msg"]')!.textContent).toContain(
      'admin.maintenanceBusy',
    );
  });

  it('a failed fetch renders the error state and no cards', async () => {
    getLibraryHealth.mockReturnValueOnce(throwError(() => ({ status: 500 })));
    const { el } = await renderOpen();
    expect(el.querySelector('[data-testid="library-health-error"]')!.textContent).toContain(
      'admin.health.loadFailed',
    );
    expect(el.querySelector('[data-testid^="health-card-"]')).toBeNull();
  });

  it('an empty library shows the empty state instead of all-zero cards', async () => {
    getLibraryHealth.mockReturnValueOnce(of(makeReport({ songs: 0 })));
    const { el } = await renderOpen();
    expect(el.querySelector('[data-testid="library-health-empty"]')).toBeTruthy();
    expect(el.querySelector('[data-testid^="health-card-"]')).toBeNull();
  });
});

describe('buildHealthCards', () => {
  it('covers every report dimension, in order', () => {
    const cards = buildHealthCards(makeReport(), (k) => k);
    expect(cards.map((c) => c.dimension)).toEqual(DIMENSIONS);
  });

  it('every key a card can render exists in every catalog', () => {
    // Metric labels are built from dimension + field name, so no grep finds
    // them; a missing one would render as the raw key.
    const cards = buildHealthCards(makeReport(), (k) => k);
    const keys = new Set<string>();
    for (const c of cards) {
      keys.add(c.titleKey);
      c.metrics.forEach((m) => keys.add(m.labelKey));
      c.lists.forEach((l) => keys.add(l.titleKey));
      if (c.action) keys.add(c.action.labelKey);
      if (c.link) keys.add(c.link.labelKey);
    }
    // Sub-lists the fixture leaves empty are filtered out; name them directly.
    for (const k of [
      'admin.health.classification.list',
      'admin.health.formatCohesion.lowBitrateList',
      'admin.health.completeness.titleMismatchList',
      'admin.health.completeness.suspectedList',
      'admin.health.lyrics.list',
      'admin.health.action.transcodeLibrary',
    ])
      keys.add(k);
    for (const [name, catalog] of [
      ['en', EN],
      ['es', ES],
    ] as const) {
      const missing = [...keys].filter((k) => !(k in catalog));
      expect(missing, name).toEqual([]);
    }
  });
});
