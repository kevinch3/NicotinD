import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import type { DebugElement } from '@angular/core';
import { expandAllGroups } from '../../../testing/expand-groups';
import { vi, beforeEach, describe, it, expect } from 'vitest';
import { of, throwError } from 'rxjs';
import { AdminComponent } from './admin.component';
import { LibraryMaintenancePanelComponent } from './library-maintenance/library-maintenance-panel.component';
import { DownloadsApiService } from '../../services/api/downloads-api.service';
import { SystemApiService } from '../../services/api/system-api.service';
import { LibraryApiService } from '../../services/api/library-api.service';
import { ServiceReviewService } from '../../services/service-review.service';
import type {
  AdminUser,
  AlbumJob,
  IncompleteAlbumJob,
  LibraryFragmentReport,
  ServiceReview,
  UntrackedDownload,
} from '../../services/api/api-types';
import type { ProcessingSettings, ProcessingStatus } from '../../../types/core';
import { AuthService } from '../../services/auth.service';
import { ConfirmService } from '../../services/confirm.service';
import { ROLES } from '../../../types/core';
import BASE_CATALOG from '../../../../public/i18n/en.json';

/**
 * Task 4 (Admin panel regroup) / Task 1 (settings-cards unification): every
 * panel now lives inside a collapsible `<app-settings-group>` whose body is
 * `@if (open())`-gated, and `open()` reads a `[defaultOpen]` signal `input()`
 * (all 10 groups pass no `[defaultOpen]` at all now — every group is collapsed
 * by default). This JIT vitest harness never registers signal inputs on a
 * *nested imported* component (see `src/testing/signal-input.ts`), so every
 * group's `[defaultOpen]`/`[title]`/etc. binding silently fails to land and
 * the component falls back to its own default (`defaultOpen` defaults to
 * `false`) — harmless here since real production usage is now all-collapsed
 * too. Specs that need to see a moved panel's content must open the groups
 * themselves by clicking each group's toggle button, exactly like a real user
 * would.
 */
/** The extracted maintenance panel's instance, reached through the page fixture:
 *  these assertions seed a signal the panel owns, then assert on what the page
 *  renders, so both halves have to come from the same component instance. */
function maintenancePanel(fixture: { debugElement: DebugElement }) {
  return fixture.debugElement.query(By.directive(LibraryMaintenancePanelComponent))
    .componentInstance as LibraryMaintenancePanelComponent;
}

function makeReview(over: Partial<ServiceReview> = {}): ServiceReview {
  return {
    collectedAt: 1_700_000_000_000,
    version: '0.1.234',
    uptimeMs: 60_000,
    hardware: {
      cpuModel: 'Test CPU',
      cores: 4,
      arch: 'x64',
      platform: 'linux',
      totalMemoryBytes: 8000,
      gpuDetected: null,
    },
    load: {
      cpu: { percent: 25, cores: 4, model: 'Test CPU' },
      memory: {
        totalBytes: 8000,
        usedBytes: 4000,
        freeBytes: 4000,
        processRssBytes: 100,
        processHeapBytes: 50,
      },
      gpu: null,
    },
    services: {
      slskd: { configured: true, healthy: true, connected: true },
      analysis: { configured: false, healthy: false },
    },
    library: { scanning: false, indexedSongCount: 1234 },
    updateCheck: {
      currentVersion: '0.1.234',
      latestVersion: null,
      updateAvailable: false,
      checkedAt: null,
      releaseUrl: null,
      versionHistory: [],
    },
    backups: [],
    backupsSummary: { total: 0, totalBytes: 0, newestAt: null, lastBackupName: null },
    processing: null,
    maintenance: null,
    incompleteJobsCount: 0,
    untrackedCount: 0,
    orphanRows: [],
    playEvents: 0,
    artistImages: { visible: 0, withPortrait: 0, missing: 0, manualOverride: 0 },
    downloadReviews: { pending: 0, oldestCreated: null },
    auditTail: [],
    reviewFlags: [],
    incompleteJobs: [],
    untracked: [],
    errors: [],
    ...over,
  };
}

function makeSvc(over: Partial<ServiceReview> = {}) {
  const r = makeReview(over);
  const svc: Partial<ServiceReviewService> = {
    review: (() => r) as ServiceReviewService['review'],
    start: vi.fn(() => () => {}),
    stop: vi.fn(),
    refresh: vi.fn(async () => undefined),
    cpu: (() => r.load.cpu) as ServiceReviewService['cpu'],
    memory: (() => r.load.memory) as ServiceReviewService['memory'],
    gpu: (() => r.load.gpu) as ServiceReviewService['gpu'],
    services: (() => r.services) as ServiceReviewService['services'],
    analysis: (() => r.services.analysis) as ServiceReviewService['analysis'],
    libraryState: (() => r.library) as ServiceReviewService['libraryState'],
    maintenance: (() => r.maintenance) as ServiceReviewService['maintenance'],
    updateCheck: (() => r.updateCheck) as ServiceReviewService['updateCheck'],
    backups: (() => r.backups) as ServiceReviewService['backups'],
    backupsSummary: (() => r.backupsSummary) as ServiceReviewService['backupsSummary'],
    auditTail: (() => r.auditTail) as ServiceReviewService['auditTail'],
    reviewFlags: (() => r.reviewFlags) as ServiceReviewService['reviewFlags'],
    incompleteJobsCount: (() =>
      r.incompleteJobsCount) as ServiceReviewService['incompleteJobsCount'],
    untrackedCount: (() => r.untrackedCount) as ServiceReviewService['untrackedCount'],
    orphanRows: (() => r.orphanRows) as ServiceReviewService['orphanRows'],
    orphanRowCount: (() =>
      r.orphanRows.reduce(
        (sum, t) => sum + t.orphans,
        0,
      )) as ServiceReviewService['orphanRowCount'],
    playEventCount: (() => r.playEvents) as ServiceReviewService['playEventCount'],
    artistImages: (() => r.artistImages) as ServiceReviewService['artistImages'],
    artistImageCoverageRatio: (() =>
      r.artistImages.visible > 0
        ? r.artistImages.withPortrait / r.artistImages.visible
        : 1) as ServiceReviewService['artistImageCoverageRatio'],
    incompleteJobs: (() => r.incompleteJobs) as ServiceReviewService['incompleteJobs'],
    untracked: (() => r.untracked) as ServiceReviewService['untracked'],
    reviewHeldCount: (() => r.downloadReviews.pending) as ServiceReviewService['reviewHeldCount'],
    reviewHeldOldestDays: (() => {
      const oldest = r.downloadReviews.oldestCreated;
      return oldest === null
        ? null
        : Math.max(0, Math.floor((Date.now() - Date.parse(oldest)) / 86_400_000));
    }) as ServiceReviewService['reviewHeldOldestDays'],
  };
  return svc;
}

function makeAdminMocks(review: Partial<ServiceReview> = {}) {
  const getUsers = vi.fn(() => of([] as AdminUser[]));
  const resyncLibrary = vi.fn(() => of({ ok: true }));
  const emptyFragments: LibraryFragmentReport = {
    duplicateAlbums: [],
    hiddenByClassification: [],
    misSplitAlbums: [],
    totals: { duplicateAlbums: 0, hiddenByClassification: 0, misSplitAlbums: 0 },
    ok: true,
  };
  const getFragments = vi.fn(() => of(emptyFragments));
  const getStreaming = vi.fn(() =>
    of({
      transcodeEnabled: true,
      format: 'opus',
      maxBitRate: 192,
      forceTranscode: false,
      ffmpegAvailable: true,
    }),
  );
  const procStatus: ProcessingStatus = {
    phase: 'idle',
    currentTask: null,
    processed: 0,
    failed: 0,
    lastError: null,
    total: 0,
    lastItems: [],
    startedAt: null,
    updatedAt: null,
    taskPending: {
      bpm: 0,
      genre: 0,
      key: 0,
      energy: 0,
      'audio-features': 0,
      descriptors: 0,
      'artist-image': 0,
      'artist-info': 0,
      'artist-identity': 0,
      'genre-audio': 0,
      'genre-discogs': 0,
      popularity: 0,
      'artist-origin': 0,
    },
    availability: {
      bpm: true,
      genre: true,
      key: true,
      energy: true,
      'audio-features': true,
      descriptors: true,
      'artist-image': true,
      'artist-info': true,
      'artist-identity': true,
      'genre-audio': true,
      'genre-discogs': true,
      popularity: true,
      'artist-origin': true,
    },
    skipped: 0,
    quarantined: 0,
  };
  const getProcessing = vi.fn(() =>
    of({
      settings: {
        enabled: true,
        paused: false,
        holdForReview: false,
        tasks: { bpm: true, genre: true, key: false, energy: false, 'audio-features': false },
        gates: {},
      } as ProcessingSettings,
      status: procStatus,
    }),
  );
  return {
    getUsers,
    resyncLibrary,
    getFragments,
    getStreaming,
    getProcessing,
    procStatus,
    reviewService: makeSvc(review),
  };
}

describe('AdminComponent (snapshot-driven via ServiceReview)', () => {
  beforeEach(async () => {
    const mocks = makeAdminMocks();
    await TestBed.configureTestingModule({
      imports: [AdminComponent],
      providers: [
        {
          provide: DownloadsApiService,
          useValue: {
            listAlbumJobs: vi.fn(() => of({ jobs: [] })),
            getUntrackedDownloads: vi.fn(() => of({ total: 0, rows: [] })),
          },
        },
        {
          provide: SystemApiService,
          useValue: {
            getUsers: mocks.getUsers,
            getStreamingSettings: mocks.getStreaming,
            saveStreamingSettings: vi.fn((p: unknown) => of(p as object)),
            getProcessing: mocks.getProcessing,
            getAcquisition: vi.fn(() => of({ enabled: true, configurable: true })),
            setAcquisition: vi.fn((e: boolean) => of({ enabled: e, configurable: true })),
            saveProcessing: vi.fn((p: unknown) => of(p as object)),
          },
        },
        {
          provide: LibraryApiService,
          useValue: { resyncLibrary: mocks.resyncLibrary, getFragments: mocks.getFragments },
        },
        { provide: ServiceReviewService, useValue: mocks.reviewService },
        { provide: AuthService, useValue: { token: () => null } },
      ],
    }).compileComponents();
  });

  function create() {
    return TestBed.createComponent(AdminComponent).componentInstance;
  }

  it('renders the metrics-pills row + every moved admin panel', async () => {
    const f = TestBed.createComponent(AdminComponent);
    f.detectChanges();
    await f.whenStable();
    f.detectChanges();
    expandAllGroups(f);
    const el = f.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="metrics-pills"]')).toBeTruthy();
    expect(el.querySelector('[data-testid="streaming-panel"]')).toBeTruthy();
    expect(el.querySelector('[data-testid="processing-panel"]')).toBeTruthy();
    expect(el.querySelector('[data-testid="duplicates-panel"]')).toBeTruthy();
    // Nothing orphaned in the default fixture — the panel stays out of the way.
    expect(el.querySelector('[data-testid="orphan-rows-panel"]')).toBeFalsy();
    // Nothing held for review in the default fixture — hidden entirely.
    expect(el.querySelector('[data-testid="review-held-panel"]')).toBeFalsy();
    f.destroy();
  });
});

/** Issue #259: orphaned side-table rows are reported so an admin can see the
 *  daily prune keeping up. Hidden entirely at zero (the steady state). */
describe('AdminComponent (orphan side-table rows, #259)', () => {
  it('lists each table with orphans and totals them', async () => {
    const mocks = makeAdminMocks({
      orphanRows: [
        { table: 'library_embeddings', rows: 15456, orphans: 1057 },
        { table: 'library_song_analysis_failures', rows: 19399, orphans: 233 },
        { table: 'library_clean', rows: 10, orphans: 0 },
      ],
    });
    await TestBed.configureTestingModule({
      imports: [AdminComponent],
      providers: [
        { provide: DownloadsApiService, useValue: {} },
        {
          provide: SystemApiService,
          useValue: {
            getUsers: vi.fn(() => of([])),
            getStreamingSettings: mocks.getStreaming,
            saveStreamingSettings: vi.fn((p: unknown) => of(p as object)),
            getProcessing: mocks.getProcessing,
            getAcquisition: vi.fn(() => of({ enabled: true, configurable: true })),
            setAcquisition: vi.fn((e: boolean) => of({ enabled: e, configurable: true })),
            saveProcessing: vi.fn((p: unknown) => of(p as object)),
          },
        },
        {
          provide: LibraryApiService,
          useValue: {
            resyncLibrary: vi.fn(() => of({ ok: true })),
            getFragments: vi.fn(() =>
              of({
                duplicateAlbums: [],
                hiddenByClassification: [],
                misSplitAlbums: [],
                totals: { duplicateAlbums: 0, hiddenByClassification: 0, misSplitAlbums: 0 },
                ok: true,
              } as LibraryFragmentReport),
            ),
          },
        },
        { provide: ServiceReviewService, useValue: mocks.reviewService },
        { provide: AuthService, useValue: { token: () => null } },
      ],
    }).compileComponents();

    const f = TestBed.createComponent(AdminComponent);
    f.detectChanges();
    await f.whenStable();
    f.detectChanges();
    expandAllGroups(f);
    const el = f.nativeElement as HTMLElement;

    // Raw i18n key in this harness (no real catalog loaded) — same convention
    // as settings.component.spec.ts / setup.component.spec.ts. 1290 total
    // orphans (1057 + 233) is plural, so the plural key renders.
    expect(el.querySelector('[data-testid="orphan-rows-panel"]')?.textContent).toContain(
      'admin.orphanRowsPlural',
    );
    expect(BASE_CATALOG).toHaveProperty(['admin.orphanRowsPlural']);
    const list = el.querySelector('[data-testid="orphan-rows-list"]')!;
    expect(list.querySelectorAll('li')).toHaveLength(2); // the zero-orphan table is skipped
    expect(list.textContent).toContain('library_embeddings');
    f.destroy();
  });
});

/** Issue #250 gap 3: portrait coverage is invisible today — a library can sit
 *  half-placeholder with no in-app way to see it. Hidden entirely once every
 *  visible artist has one (the healthy steady state). */
describe('AdminComponent (artist portrait coverage, #250)', () => {
  async function mount(artistImages: {
    visible: number;
    withPortrait: number;
    missing: number;
    manualOverride: number;
  }) {
    TestBed.resetTestingModule();
    const mocks = makeAdminMocks({ artistImages });
    await TestBed.configureTestingModule({
      imports: [AdminComponent],
      providers: [
        { provide: DownloadsApiService, useValue: {} },
        {
          provide: SystemApiService,
          useValue: {
            getUsers: vi.fn(() => of([])),
            getStreamingSettings: mocks.getStreaming,
            saveStreamingSettings: vi.fn((p: unknown) => of(p as object)),
            getProcessing: mocks.getProcessing,
            getAcquisition: vi.fn(() => of({ enabled: true, configurable: true })),
            setAcquisition: vi.fn((e: boolean) => of({ enabled: e, configurable: true })),
            saveProcessing: vi.fn((p: unknown) => of(p as object)),
          },
        },
        {
          provide: LibraryApiService,
          useValue: {
            resyncLibrary: vi.fn(() => of({ ok: true })),
            getFragments: vi.fn(() =>
              of({
                duplicateAlbums: [],
                hiddenByClassification: [],
                misSplitAlbums: [],
                totals: { duplicateAlbums: 0, hiddenByClassification: 0, misSplitAlbums: 0 },
                ok: true,
              } as LibraryFragmentReport),
            ),
          },
        },
        { provide: ServiceReviewService, useValue: mocks.reviewService },
        { provide: AuthService, useValue: { token: () => null } },
      ],
    }).compileComponents();
    const f = TestBed.createComponent(AdminComponent);
    f.detectChanges();
    await f.whenStable();
    f.detectChanges();
    expandAllGroups(f);
    return f;
  }

  it('reports coverage as "N of M" when portraits are missing', async () => {
    const f = await mount({ visible: 1011, withPortrait: 923, missing: 88, manualOverride: 140 });
    const el = f.nativeElement as HTMLElement;
    const panel = el.querySelector('[data-testid="artist-images-panel"]')!;
    // Raw i18n keys in this harness (no real catalog loaded) — same convention
    // as settings.component.spec.ts / setup.component.spec.ts. missing=88 is
    // plural, so the plural key renders.
    expect(panel.textContent).toContain('admin.artistPortraitCoverage');
    expect(panel.textContent).toContain('admin.artistPortraitMissingPlural');
    expect(BASE_CATALOG).toHaveProperty(['admin.artistPortraitCoverage']);
    expect(BASE_CATALOG).toHaveProperty(['admin.artistPortraitMissingPlural']);
    // Curator uploads are called out, because a fill will never touch them.
    expect(el.querySelector('[data-testid="artist-images-overrides"]')?.textContent).toContain(
      'admin.artistImagesOverrides',
    );
    expect(BASE_CATALOG).toHaveProperty(['admin.artistImagesOverrides']);
    f.destroy();
  });

  it('renders the bar at the coverage ratio', async () => {
    const f = await mount({ visible: 200, withPortrait: 150, missing: 50, manualOverride: 0 });
    const bar = (f.nativeElement as HTMLElement).querySelector(
      '[data-testid="artist-images-bar"]',
    ) as HTMLElement;
    expect(bar.style.width).toBe('75%');
    f.destroy();
  });

  it('stays hidden when every visible artist has a portrait', async () => {
    const f = await mount({ visible: 400, withPortrait: 400, missing: 0, manualOverride: 12 });
    expect(
      (f.nativeElement as HTMLElement).querySelector('[data-testid="artist-images-panel"]'),
    ).toBeFalsy();
    f.destroy();
  });

  it('omits the curator-upload line when there are none', async () => {
    const f = await mount({ visible: 10, withPortrait: 4, missing: 6, manualOverride: 0 });
    expect(
      (f.nativeElement as HTMLElement).querySelector('[data-testid="artist-images-overrides"]'),
    ).toBeFalsy();
    f.destroy();
  });
});

/** Issue #235: the runtime acquisition kill-switch. The env-disabled case is
 *  the one that matters — an operator's decision must not be liftable here. */
describe('AdminComponent (acquisition kill-switch, #235)', () => {
  async function mount(acq: { enabled: boolean; configurable: boolean } | 'unavailable') {
    TestBed.resetTestingModule();
    const mocks = makeAdminMocks();
    const getAcquisition =
      acq === 'unavailable'
        ? vi.fn(() => throwError(() => new Error('503')))
        : vi.fn(() => of(acq));
    const setAcquisition = vi.fn((enabled: boolean) =>
      of({ enabled, configurable: acq === 'unavailable' ? true : acq.configurable }),
    );
    await TestBed.configureTestingModule({
      imports: [AdminComponent],
      providers: [
        { provide: DownloadsApiService, useValue: {} },
        {
          provide: SystemApiService,
          useValue: {
            getUsers: vi.fn(() => of([])),
            getStreamingSettings: mocks.getStreaming,
            saveStreamingSettings: vi.fn((p: unknown) => of(p as object)),
            getProcessing: mocks.getProcessing,
            saveProcessing: vi.fn((p: unknown) => of(p as object)),
            getAcquisition,
            setAcquisition,
          },
        },
        {
          provide: LibraryApiService,
          useValue: {
            resyncLibrary: vi.fn(() => of({ ok: true })),
            getFragments: vi.fn(() =>
              of({
                duplicateAlbums: [],
                hiddenByClassification: [],
                misSplitAlbums: [],
                totals: { duplicateAlbums: 0, hiddenByClassification: 0, misSplitAlbums: 0 },
                ok: true,
              } as LibraryFragmentReport),
            ),
          },
        },
        { provide: ServiceReviewService, useValue: mocks.reviewService },
        { provide: AuthService, useValue: { token: () => null } },
      ],
    }).compileComponents();
    const f = TestBed.createComponent(AdminComponent);
    f.detectChanges();
    await f.whenStable();
    f.detectChanges();
    expandAllGroups(f);
    return { f, setAcquisition };
  }

  const toggle = (f: { nativeElement: unknown }) =>
    (f.nativeElement as HTMLElement).querySelector(
      '[data-testid="acquisition-toggle"]',
    ) as HTMLInputElement | null;

  it('reflects the current state and can turn it off', async () => {
    const { f, setAcquisition } = await mount({ enabled: true, configurable: true });
    const box = toggle(f)!;
    expect(box.checked).toBe(true);
    expect(box.disabled).toBe(false);

    box.checked = false;
    box.dispatchEvent(new Event('change'));
    expect(setAcquisition).toHaveBeenCalledWith(false);
    f.destroy();
  });

  // The asymmetry: an operator disabled it deployment-wide, so the control is
  // read-only and says why rather than silently doing nothing.
  it('renders read-only with an explanation when the environment disabled it', async () => {
    const { f, setAcquisition } = await mount({ enabled: false, configurable: false });
    const box = toggle(f)!;
    expect(box.checked).toBe(false);
    expect(box.disabled).toBe(true);
    // Raw i18n key in this harness (no real catalog loaded) — same convention
    // as settings.component.spec.ts / setup.component.spec.ts.
    expect(
      (f.nativeElement as HTMLElement).querySelector('[data-testid="acquisition-env-locked"]')
        ?.textContent,
    ).toContain('admin.acquisitionEnvLocked');
    expect(BASE_CATALOG).toHaveProperty(['admin.acquisitionEnvLocked']);

    box.dispatchEvent(new Event('change'));
    expect(setAcquisition).not.toHaveBeenCalled();
    f.destroy();
  });

  it('hides the panel entirely when the server does not expose the toggle', async () => {
    const { f } = await mount('unavailable');
    expect(
      (f.nativeElement as HTMLElement).querySelector('[data-testid="acquisition-panel"]'),
    ).toBeFalsy();
    f.destroy();
  });
});

/** Task 13 (download inbox triage, issue #411): the hold-for-review toggle
 *  gates new downloads in a quarantine state until a curator approves them. */
describe('AdminComponent (hold-for-review toggle, #411)', () => {
  beforeEach(async () => {
    const mocks = makeAdminMocks();
    const saveProcessing = vi.fn((p: unknown) => of(p as object));
    await TestBed.configureTestingModule({
      imports: [AdminComponent],
      providers: [
        { provide: DownloadsApiService, useValue: {} },
        {
          provide: SystemApiService,
          useValue: {
            getUsers: vi.fn(() => of([])),
            getStreamingSettings: mocks.getStreaming,
            saveStreamingSettings: vi.fn((p: unknown) => of(p as object)),
            getProcessing: mocks.getProcessing,
            getAcquisition: vi.fn(() => of({ enabled: true, configurable: true })),
            setAcquisition: vi.fn((e: boolean) => of({ enabled: e, configurable: true })),
            saveProcessing,
          },
        },
        {
          provide: LibraryApiService,
          useValue: {
            resyncLibrary: vi.fn(() => of({ ok: true })),
            getFragments: vi.fn(() =>
              of({
                duplicateAlbums: [],
                hiddenByClassification: [],
                misSplitAlbums: [],
                totals: { duplicateAlbums: 0, hiddenByClassification: 0, misSplitAlbums: 0 },
                ok: true,
              } as LibraryFragmentReport),
            ),
          },
        },
        { provide: ServiceReviewService, useValue: mocks.reviewService },
        { provide: AuthService, useValue: { token: () => null } },
      ],
    }).compileComponents();
  });

  it('renders the holdForReview toggle and verifies i18n keys', async () => {
    const f = TestBed.createComponent(AdminComponent);
    f.detectChanges();
    await f.whenStable();
    f.detectChanges();
    expandAllGroups(f);
    const el = f.nativeElement as HTMLElement;
    const toggle = el.querySelector(
      '[data-testid="processing-hold-for-review"]',
    ) as HTMLInputElement;
    expect(toggle).toBeTruthy();
    expect(toggle.type).toBe('checkbox');
    // Verify i18n keys are present in the catalog
    expect(BASE_CATALOG).toHaveProperty(['admin.holdForReview']);
    expect(BASE_CATALOG).toHaveProperty(['admin.holdForReviewHint']);
    f.destroy();
  });

  it('calls saveProcessing when holdForReview checkbox is toggled', async () => {
    const f = TestBed.createComponent(AdminComponent);
    f.detectChanges();
    await f.whenStable();
    f.detectChanges();
    expandAllGroups(f);
    const el = f.nativeElement as HTMLElement;
    const toggle = el.querySelector(
      '[data-testid="processing-hold-for-review"]',
    ) as HTMLInputElement;
    expect(toggle).toBeTruthy();

    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    expect(TestBed.inject(SystemApiService).saveProcessing).toHaveBeenCalledWith({
      holdForReview: true,
    });
    f.destroy();
  });
});

/** Issue #417: an admin strand warning for downloads held in review — hidden
 *  entirely at zero (off/unarmed/steady-state), rendered with count + oldest
 *  waiting time when nonzero. */
describe('AdminComponent (download-review admin warning, #417)', () => {
  it('renders the held count + oldest-waiting hint immediately after the toggle', async () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000).toISOString();
    const mocks = makeAdminMocks({
      downloadReviews: { pending: 2, oldestCreated: threeDaysAgo },
    });
    await TestBed.configureTestingModule({
      imports: [AdminComponent],
      providers: [
        { provide: DownloadsApiService, useValue: {} },
        {
          provide: SystemApiService,
          useValue: {
            getUsers: vi.fn(() => of([])),
            getStreamingSettings: mocks.getStreaming,
            saveStreamingSettings: vi.fn((p: unknown) => of(p as object)),
            getProcessing: mocks.getProcessing,
            getAcquisition: vi.fn(() => of({ enabled: true, configurable: true })),
            setAcquisition: vi.fn((e: boolean) => of({ enabled: e, configurable: true })),
            saveProcessing: vi.fn((p: unknown) => of(p as object)),
          },
        },
        {
          provide: LibraryApiService,
          useValue: {
            resyncLibrary: vi.fn(() => of({ ok: true })),
            getFragments: vi.fn(() =>
              of({
                duplicateAlbums: [],
                hiddenByClassification: [],
                misSplitAlbums: [],
                totals: { duplicateAlbums: 0, hiddenByClassification: 0, misSplitAlbums: 0 },
                ok: true,
              } as LibraryFragmentReport),
            ),
          },
        },
        { provide: ServiceReviewService, useValue: mocks.reviewService },
        { provide: AuthService, useValue: { token: () => null } },
      ],
    }).compileComponents();

    const f = TestBed.createComponent(AdminComponent);
    f.detectChanges();
    await f.whenStable();
    f.detectChanges();
    expandAllGroups(f);
    const el = f.nativeElement as HTMLElement;

    const panel = el.querySelector('[data-testid="review-held-panel"]');
    expect(panel).toBeTruthy();
    // Raw i18n key in this harness (no real catalog loaded) — same convention
    // as the orphan-rows-panel test above.
    expect(panel?.textContent).toContain('admin.reviewHeldPlural');
    expect(panel?.textContent).toContain('admin.reviewHeldHint');
    expect(BASE_CATALOG).toHaveProperty(['admin.reviewHeldPlural']);
    expect(BASE_CATALOG).toHaveProperty(['admin.reviewHeldSingular']);
    expect(BASE_CATALOG).toHaveProperty(['admin.reviewHeldHint']);
    f.destroy();
  });
});

describe('AdminComponent (incompleteJobs / untracked via ServiceReview)', () => {
  beforeEach(async () => {
    const mocks = makeAdminMocks();
    await TestBed.configureTestingModule({
      imports: [AdminComponent],
      providers: [
        { provide: DownloadsApiService, useValue: {} },
        {
          provide: SystemApiService,
          useValue: {
            getUsers: vi.fn(() => of([])),
            getStreamingSettings: mocks.getStreaming,
            saveStreamingSettings: vi.fn((p: unknown) => of(p as object)),
            getProcessing: mocks.getProcessing,
            getAcquisition: vi.fn(() => of({ enabled: true, configurable: true })),
            setAcquisition: vi.fn((e: boolean) => of({ enabled: e, configurable: true })),
            saveProcessing: vi.fn((p: unknown) => of(p as object)),
          },
        },
        {
          provide: LibraryApiService,
          useValue: {
            resyncLibrary: vi.fn(() => of({ ok: true })),
            getFragments: vi.fn(() =>
              of({
                duplicateAlbums: [],
                hiddenByClassification: [],
                misSplitAlbums: [],
                totals: { duplicateAlbums: 0, hiddenByClassification: 0, misSplitAlbums: 0 },
                ok: true,
              } as LibraryFragmentReport),
            ),
          },
        },
        { provide: ServiceReviewService, useValue: mocks.reviewService },
        { provide: AuthService, useValue: { token: () => null } },
      ],
    }).compileComponents();
  });

  it('retryHunt builds a DiscographyAlbum from the incomplete-job and sets the artist', () => {
    const c = TestBed.createComponent(LibraryMaintenancePanelComponent).componentInstance;
    const job: IncompleteAlbumJob = {
      id: 1,
      lidarrAlbumId: 10,
      artistName: 'Soda Stereo',
      albumTitle: 'Canción Animal',
      username: 'peer',
      directory: 'Soda Stereo - Cancion Animal',
      state: 'exhausted',
      fallbackAttempts: 5,
      createdAt: 1_700_000_000_000,
    };
    c.retryHunt(job);
    expect(c.retryArtist()).toBe('Soda Stereo');
    expect(c.retryAlbum()?.lidarrId).toBe(10);
    expect(c.retryAlbum()?.title).toBe('Canción Animal');
  });

  it('retryHunt is a no-op when the job has no Lidarr album id', () => {
    const c = TestBed.createComponent(LibraryMaintenancePanelComponent).componentInstance;
    c.retryHunt({
      id: 1,
      lidarrAlbumId: null,
      artistName: '',
      albumTitle: null,
      username: '',
      directory: '',
      state: 'exhausted',
      fallbackAttempts: 0,
      createdAt: 1,
    });
    expect(c.retryAlbum()).toBeNull();
  });

  it('jobStateClass maps states to colors', () => {
    const c = TestBed.createComponent(LibraryMaintenancePanelComponent).componentInstance;
    expect(c.jobStateClass('exhausted')).toContain('status-error');
    expect(c.jobStateClass('active')).toContain('status-warn');
  });

  it('syncLibrary calls resyncLibrary and reports success', async () => {
    const c = TestBed.createComponent(LibraryMaintenancePanelComponent).componentInstance;
    await c.syncLibrary();
    // Raw i18n key in this harness (no real catalog loaded) — same convention
    // as settings.component.spec.ts / setup.component.spec.ts.
    expect(c.syncMsg()).toBe('admin.syncComplete');
    expect(BASE_CATALOG).toHaveProperty(['admin.syncComplete']);
  });

  it('syncLibrary surfaces an error message on failure', async () => {
    const resyncLibrary = vi.fn(() => throwError(() => new Error('boom')));
    TestBed.resetTestingModule();
    const mocks = makeAdminMocks();
    TestBed.configureTestingModule({
      imports: [AdminComponent],
      providers: [
        { provide: DownloadsApiService, useValue: {} },
        {
          provide: SystemApiService,
          useValue: {
            getUsers: vi.fn(() => of([])),
            getStreamingSettings: mocks.getStreaming,
            saveStreamingSettings: vi.fn((p: unknown) => of(p as object)),
            getProcessing: mocks.getProcessing,
            getAcquisition: vi.fn(() => of({ enabled: true, configurable: true })),
            setAcquisition: vi.fn((e: boolean) => of({ enabled: e, configurable: true })),
            saveProcessing: vi.fn((p: unknown) => of(p as object)),
          },
        },
        {
          provide: LibraryApiService,
          useValue: {
            resyncLibrary,
            getFragments: vi.fn(() =>
              of({
                duplicateAlbums: [],
                hiddenByClassification: [],
                misSplitAlbums: [],
                totals: { duplicateAlbums: 0, hiddenByClassification: 0, misSplitAlbums: 0 },
                ok: true,
              } as LibraryFragmentReport),
            ),
          },
        },
        { provide: ServiceReviewService, useValue: mocks.reviewService },
        { provide: AuthService, useValue: { token: () => null } },
      ],
    }).compileComponents();
    const c = TestBed.createComponent(LibraryMaintenancePanelComponent).componentInstance;
    await c.syncLibrary();
    expect(c.syncMsg()).toBe('boom');
  });
});

/** Phase 4 (Android TV support) task 3: the same D-pad nav directives applied
 *  to Settings/Devices in tasks 1-2 now cover the services grid, the log
 *  service selector buttons, and the processing-task checkboxes. */
describe('AdminComponent (TV D-pad navigation, Android TV support phase 4)', () => {
  beforeEach(async () => {
    const mocks = makeAdminMocks();
    await TestBed.configureTestingModule({
      imports: [AdminComponent],
      providers: [
        { provide: DownloadsApiService, useValue: {} },
        {
          provide: SystemApiService,
          useValue: {
            getUsers: vi.fn(() => of([])),
            getStreamingSettings: mocks.getStreaming,
            saveStreamingSettings: vi.fn((p: unknown) => of(p as object)),
            getProcessing: mocks.getProcessing,
            getAcquisition: vi.fn(() => of({ enabled: true, configurable: true })),
            setAcquisition: vi.fn((e: boolean) => of({ enabled: e, configurable: true })),
            saveProcessing: vi.fn((p: unknown) => of(p as object)),
          },
        },
        {
          provide: LibraryApiService,
          useValue: {
            resyncLibrary: vi.fn(() => of({ ok: true })),
            getFragments: vi.fn(() =>
              of({
                duplicateAlbums: [],
                hiddenByClassification: [],
                misSplitAlbums: [],
                totals: { duplicateAlbums: 0, hiddenByClassification: 0, misSplitAlbums: 0 },
                ok: true,
              } as LibraryFragmentReport),
            ),
          },
        },
        { provide: ServiceReviewService, useValue: mocks.reviewService },
        { provide: AuthService, useValue: { token: () => null } },
      ],
    }).compileComponents();
  });

  function setup() {
    const fixture = TestBed.createComponent(AdminComponent);
    return { fixture };
  }

  it('renders each log service selector button as an appTvNavItem in a horizontal group', async () => {
    const { fixture } = setup();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expandAllGroups(fixture);
    const el: HTMLElement = fixture.nativeElement;
    const group = el.querySelector('[appTvNavGroup][axis="horizontal"]');
    expect(group).not.toBeNull();
    const buttons = group?.querySelectorAll('button[appTvNavItem]');
    expect(buttons?.length).toBeGreaterThan(0);
    fixture.destroy();
  });

  /**
   * The run + gate checkboxes of one task sit side-by-side in a `flex` row
   * while DOM order is run₁, gate₁, run₂, gate₂, … — so on the `vertical` axis
   * this group used to send ArrowDown from a run box to the SAME row's gate box
   * (visually to its right) and do nothing at all on Left/Right. The `grid`
   * axis matches the real layout: `inferColumnsPerRow` sees the two
   * same-`offsetTop` checkboxes as 2 columns.
   */
  it('renders each processing task row as two appTvNavItem checkboxes inside one grid group', async () => {
    const { fixture } = setup();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expandAllGroups(fixture);
    const el: HTMLElement = fixture.nativeElement;
    const runCheckbox = el.querySelector('[data-testid^="processing-task-"]');
    expect(runCheckbox?.hasAttribute('appTvNavItem')).toBe(true);
    const gateCheckbox = el.querySelector('[data-testid^="processing-gate-"]');
    expect(gateCheckbox?.hasAttribute('appTvNavItem')).toBe(true);

    // Both checkboxes for every row live inside ONE shared group, not a nested
    // per-row group.
    const gridGroup = runCheckbox?.closest('[appTvNavGroup][axis="grid"]');
    expect(gridGroup).not.toBeNull();
    expect(gateCheckbox?.closest('[appTvNavGroup][axis="grid"]')).toBe(gridGroup);
    const groupsInside = gridGroup?.querySelectorAll('[appTvNavGroup]');
    expect(groupsInside?.length ?? 0).toBe(0);
    fixture.destroy();
  });

  /**
   * Behavioural proof of the grid axis above (and that the group registers its
   * items at all). jsdom computes no layout, so `offsetTop` is stubbed to put
   * each task's two checkboxes on their own row — the shape
   * `inferColumnsPerRow` reads as 2 columns in the browser.
   */
  it('ArrowRight crosses a processing row (run → gate) and ArrowDown jumps to the next task', async () => {
    const { fixture } = setup();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expandAllGroups(fixture);
    const el: HTMLElement = fixture.nativeElement;
    const group = el
      .querySelector('[data-testid^="processing-task-"]')!
      .closest('[appTvNavGroup]')!;
    const boxes: HTMLInputElement[] = Array.from(group.querySelectorAll('input[appTvNavItem]'));
    // At least two task rows are needed for the ArrowDown half of this test.
    expect(boxes.length).toBeGreaterThanOrEqual(4);
    boxes.forEach((box, i) => {
      Object.defineProperty(box, 'offsetTop', {
        value: Math.floor(i / 2) * 100,
        configurable: true,
      });
      // A gate box is disabled while its task is off, and a disabled input
      // cannot take focus — irrelevant to what this test measures (the group's
      // nav geometry), so un-disable them rather than depend on which tasks the
      // fixture happens to enable.
      box.disabled = false;
    });

    boxes[0]!.focus();
    boxes[0]!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }),
    );
    expect(document.activeElement).toBe(boxes[1]); // same row's gate box

    boxes[0]!.focus();
    boxes[0]!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
    );
    expect(document.activeElement).toBe(boxes[2]); // next task's run box
    fixture.destroy();
  });

  it('duplicates rows are label nav items in one vertical group (issue #396)', async () => {
    const { fixture } = setup();
    fixture.detectChanges();
    await fixture.whenStable();
    maintenancePanel(fixture).duplicates.set([
      [
        { id: 's1', title: 'A', artist: 'X', album: 'Al', suffix: 'flac', duration: 60 },
        { id: 's2', title: 'A', artist: 'X', album: 'Al', suffix: 'mp3', duration: 60 },
      ],
    ] as never);
    fixture.detectChanges();
    expandAllGroups(fixture);
    const el: HTMLElement = fixture.nativeElement;
    const panel = el.querySelector('[data-testid="duplicates-panel"]')!;
    // One vertical group spans the whole panel: the find button, every song
    // row (a <label> — activated via the item directive's Enter passthrough,
    // since a label has no native key activation) and the delete button all
    // share one D-pad sweep.
    expect(panel.hasAttribute('appTvNavGroup')).toBe(true);
    const findButton = panel.querySelector('[data-testid="find-duplicates"]')!;
    expect(findButton.hasAttribute('appTvNavItem')).toBe(true);
    const rows = Array.from(panel.querySelectorAll('label'));
    expect(rows.length).toBe(2);
    for (const row of rows) expect(row.hasAttribute('appTvNavItem')).toBe(true);
    fixture.destroy();
  });
});

/**
 * Task 5 (Admin panel regroup): coverage for the 8-group structure Task 4
 * built. Shares the same TestBed setup shape as the other describe blocks in
 * this file (`makeAdminMocks` + `TestBed.createComponent(AdminComponent)` +
 * `expandAllGroups`) rather than inventing a new render helper — this file
 * has no plain `render()` function, so "use this file's existing render
 * helper" from the task brief means this pattern.
 */
describe('AdminComponent — group structure (Task 4 regroup)', () => {
  async function createAndSettle(review: Partial<ServiceReview> = {}) {
    const mocks = makeAdminMocks(review);
    await TestBed.configureTestingModule({
      imports: [AdminComponent],
      providers: [
        {
          provide: DownloadsApiService,
          useValue: {
            listAlbumJobs: vi.fn(() => of({ jobs: [] })),
            getUntrackedDownloads: vi.fn(() => of({ total: 0, rows: [] })),
          },
        },
        {
          provide: SystemApiService,
          useValue: {
            getUsers: mocks.getUsers,
            getStreamingSettings: mocks.getStreaming,
            saveStreamingSettings: vi.fn((p: unknown) => of(p as object)),
            getProcessing: mocks.getProcessing,
            getAcquisition: vi.fn(() => of({ enabled: true, configurable: true })),
            setAcquisition: vi.fn((e: boolean) => of({ enabled: e, configurable: true })),
            saveProcessing: vi.fn((p: unknown) => of(p as object)),
            // The auto-playlists panel (`auto-playlists-panel`) only renders
            // once `autoPlaylists()` resolves — mock it so that panel testid
            // is actually present for the "every pre-existing panel testid"
            // assertion below.
            getAutoPlaylists: vi.fn(() => of({ cadence: 'off', lastRefreshedAt: null })),
          },
        },
        {
          provide: LibraryApiService,
          useValue: { resyncLibrary: mocks.resyncLibrary, getFragments: mocks.getFragments },
        },
        { provide: ServiceReviewService, useValue: mocks.reviewService },
        { provide: AuthService, useValue: { token: () => null } },
      ],
    }).compileComponents();

    const fixture = TestBed.createComponent(AdminComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  }

  it('renders every group', async () => {
    const fixture = await createAndSettle();
    const el: HTMLElement = fixture.nativeElement;
    const headers = Array.from(el.querySelectorAll('app-settings-group-header'));
    // 10: the settings-cards unification's set, plus the radio evaluation polls
    // card (docs/radio-eval-polls.md) and the curation review queue (#682),
    // minus "Import music" — which went with the admin import card, import
    // being internal/API-only now (docs/import.md) — and minus the
    // generation-feedback queue, removed with that feature.
    expect(headers.length).toBe(10);
    fixture.destroy();
  });

  /**
   * The real ordering guard. Its predecessor was titled "renders all 10 groups
   * in the correct order" and asserted `headers.length` twice, order never —
   * there was nothing to assert on, because every group was an identical
   * `<app-settings-group>` whose distinguishing `[title]`/`groupId` inputs the
   * JIT harness does not land (see the note above `expandAllGroups`).
   *
   * Now each section is its own element, so sequence is observable from the DOM
   * without any input binding having to work. That is exactly the property that
   * makes "reordering is a one-line move" safe to rely on: change the order in
   * the template and this test tells you.
   */
  it('renders the panels in the intended order', async () => {
    const fixture = await createAndSettle();
    const shell = (fixture.nativeElement as HTMLElement).querySelector('.page-shell')!;
    const order = Array.from(shell.children)
      .map((e) => e.tagName.toLowerCase())
      .filter((t) => t.startsWith('app-'));
    expect(order).toEqual([
      'app-user-management-panel',
      'app-library-processing-panel',
      'app-system-health-panel',
      'app-library-maintenance-panel',
      'app-streaming-media-panel',
      'app-backups-data-panel',
      'app-acquisition-automation-panel',
      'app-review-flags-panel',
      'app-audit-log-panel',
      'app-settings-group', // radio polls — the last section still inline
    ]);
    fixture.destroy();
  });

  it('renders every group collapsed on a fresh render (all groups default-collapsed)', async () => {
    localStorage.clear();
    const fixture = await createAndSettle();
    const el: HTMLElement = fixture.nativeElement;
    const bodies = el.querySelectorAll('[data-testid="settings-group-body"]');
    expect(bodies.length).toBe(0);
    fixture.destroy();
  });

  it('every pre-existing panel testid still resolves inside its group', async () => {
    // `orphan-rows-panel`, `artist-images-panel`, and `review-held-panel` are
    // all conditionally hidden at the healthy-steady-state zero (issues #259 /
    // #250 gap 3 / #417), so the default fixture used elsewhere in this file
    // wouldn't render them — supply non-zero values so every testid in this
    // list is actually present to find, matching the other describe blocks'
    // own overrides for these panels.
    const fixture = await createAndSettle({
      orphanRows: [{ table: 'library_embeddings', rows: 100, orphans: 5 }],
      artistImages: { visible: 10, withPortrait: 7, missing: 3, manualOverride: 0 },
      downloadReviews: { pending: 2, oldestCreated: '2026-08-01T00:00:00.000Z' },
    });
    expandAllGroups(fixture);
    const el: HTMLElement = fixture.nativeElement;
    for (const testid of [
      'metrics-pills',
      'update-check',
      'processing-panel',
      'duplicates-panel',
      'streaming-panel',
      'backups-panel',
      'config-panel',
      'acquisition-panel',
      'auto-playlists-panel',
      'orphan-rows-panel',
      'artist-images-panel',
      'review-held-panel',
      'library-fragments',
    ]) {
      expect(
        el.querySelector(`[data-testid="${testid}"]`),
        `missing testid: ${testid}`,
      ).not.toBeNull();
    }
    fixture.destroy();
  });
});

/** Issue #314: the fragmentation report is actionable — every defect class
 *  carries its remediation instead of a read-only listing. */
describe('AdminComponent (actionable fragments, #314)', () => {
  const report: LibraryFragmentReport = {
    duplicateAlbums: [
      {
        normalizedTitle: 'el mismo aire',
        displayTitle: 'El mismo aire',
        memberIds: ['a', 'b'],
        artistSpellings: [
          { name: 'La Konga', occurrences: 1 },
          { name: "La K'onga", occurrences: 4 },
        ],
        totalSongs: 17,
      },
    ],
    hiddenByClassification: [
      {
        albumId: 'hid1',
        name: 'Coolio.com',
        artist: 'Coolio',
        classification: 'unknown',
        hidden: false,
        songCount: 14,
        reason: 'unknown',
      },
    ],
    misSplitAlbums: [
      {
        rule: 'missplit_album',
        severity: 'high',
        subject: 'latin only',
        message: '"Latin Only" is split into 3 one-track singles (mis-tagged album)',
      },
    ],
    totals: { duplicateAlbums: 1, hiddenByClassification: 1, misSplitAlbums: 1 },
    ok: false,
  };

  function makeLibraryApi() {
    return {
      resyncLibrary: vi.fn(() => of({ ok: true })),
      getFragments: vi.fn(() => of(report)),
      fixArtistIdentity: vi.fn(() => of({ ok: true })),
      reclassifyAlbum: vi.fn(() => of({ ok: true })),
      unhideAlbum: vi.fn(() => of({ ok: true })),
      deleteAlbum: vi.fn(() => of({ ok: true })),
      missplitPreview: vi.fn(() =>
        of({
          members: [
            {
              albumId: 'g1',
              name: 'Latin Only',
              artist: 'Gilda',
              classification: 'single',
              songCount: 1,
              flagged: true,
              paths: ['Gilda/Latin Only/99.mp3'],
            },
            {
              albumId: 'g2',
              name: 'Latin Only',
              artist: 'Onda Sabanera',
              classification: 'single',
              songCount: 1,
              flagged: true,
              paths: ['Onda/Latin Only/97.mp3'],
            },
          ],
          suggestedAlbumArtist: 'Various Artists',
        }),
      ),
      missplitMerge: vi.fn(() => of({ tagged: 2, failed: 0, resynced: true })),
    };
  }

  async function mount(libraryApi: ReturnType<typeof makeLibraryApi>) {
    const mocks = makeAdminMocks();
    await TestBed.configureTestingModule({
      imports: [AdminComponent],
      providers: [
        {
          provide: DownloadsApiService,
          useValue: {
            listAlbumJobs: vi.fn(() => of({ jobs: [] })),
            getUntrackedDownloads: vi.fn(() => of({ total: 0, rows: [] })),
          },
        },
        {
          provide: SystemApiService,
          useValue: {
            getUsers: mocks.getUsers,
            getStreamingSettings: mocks.getStreaming,
            saveStreamingSettings: vi.fn((p: unknown) => of(p as object)),
            getProcessing: mocks.getProcessing,
            getAcquisition: vi.fn(() => of({ enabled: true, configurable: true })),
            setAcquisition: vi.fn((e: boolean) => of({ enabled: e, configurable: true })),
            saveProcessing: vi.fn((p: unknown) => of(p as object)),
          },
        },
        { provide: LibraryApiService, useValue: libraryApi },
        { provide: ServiceReviewService, useValue: mocks.reviewService },
        { provide: AuthService, useValue: { token: () => null } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(AdminComponent);
    maintenancePanel(fixture).fragments.set(report);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expandAllGroups(fixture);
    return fixture;
  }

  it('a duplicate cluster merges the other spellings into the clicked one', async () => {
    const api = makeLibraryApi();
    const fixture = await mount(api);
    const btns = fixture.nativeElement.querySelectorAll('[data-testid="fragments-merge-spelling"]');
    expect(btns.length).toBe(2); // one per spelling: "make this one canonical"
    (btns[1] as HTMLButtonElement).click(); // canonical = La K'onga
    await fixture.whenStable();
    expect(api.fixArtistIdentity).toHaveBeenCalledTimes(1);
    expect(api.fixArtistIdentity).toHaveBeenCalledWith({
      rawName: 'La Konga',
      mergeInto: "La K'onga",
    });
    expect(api.getFragments).toHaveBeenCalled(); // report refreshed
    fixture.destroy();
  });

  it('a hidden row reclassifies as album in place', async () => {
    const api = makeLibraryApi();
    const fixture = await mount(api);
    const btn = fixture.nativeElement.querySelector(
      '[data-testid="fragments-reclassify"]',
    ) as HTMLButtonElement;
    btn.click();
    await fixture.whenStable();
    expect(api.reclassifyAlbum).toHaveBeenCalledWith('hid1', 'album');
    fixture.destroy();
  });

  it('a hidden row delete needs a second confirming click', async () => {
    const api = makeLibraryApi();
    const fixture = await mount(api);
    const btn = fixture.nativeElement.querySelector(
      '[data-testid="fragments-delete"]',
    ) as HTMLButtonElement;
    btn.click();
    await fixture.whenStable();
    expect(api.deleteAlbum).not.toHaveBeenCalled(); // first click arms only
    btn.click();
    await fixture.whenStable();
    expect(api.deleteAlbum).toHaveBeenCalledWith('hid1');
    fixture.destroy();
  });

  it('a mis-split cluster previews members then merges the selected ones', async () => {
    const api = makeLibraryApi();
    const fixture = await mount(api);
    (
      fixture.nativeElement.querySelector(
        '[data-testid="fragments-missplit-open"]',
      ) as HTMLButtonElement
    ).click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(api.missplitPreview).toHaveBeenCalledWith('latin only');
    // Both members render selected (their artist differs from the target).
    const checks = fixture.nativeElement.querySelectorAll(
      '[data-testid="fragments-missplit-member"]',
    );
    expect(checks.length).toBe(2);
    (
      fixture.nativeElement.querySelector(
        '[data-testid="fragments-missplit-apply"]',
      ) as HTMLButtonElement
    ).click();
    await fixture.whenStable();
    expect(api.missplitMerge).toHaveBeenCalledWith(['g1', 'g2'], 'Various Artists');
    fixture.destroy();
  });
});

describe('AdminComponent — maintenance passes (issue #622)', () => {
  const start = vi.fn();
  const cancel = vi.fn();

  async function setup(review: Partial<ServiceReview> = {}, startImpl?: () => unknown) {
    start.mockReset();
    cancel.mockReset();
    start.mockImplementation(startImpl ?? (() => of({ ok: true, started: true, status: null })));
    cancel.mockImplementation(() => of({ ok: true }));
    const mocks = makeAdminMocks(review);
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [LibraryMaintenancePanelComponent],
      providers: [
        {
          provide: SystemApiService,
          useValue: {
            getUsers: mocks.getUsers,
            getProcessing: mocks.getProcessing,
          },
        },
        {
          provide: LibraryApiService,
          useValue: {
            resyncLibrary: mocks.resyncLibrary,
            getFragments: mocks.getFragments,
            startMaintenance: start,
            cancelMaintenance: cancel,
          },
        },
        { provide: ServiceReviewService, useValue: mocks.reviewService },
        { provide: AuthService, useValue: { token: () => null } },
      ],
    }).compileComponents();
    // The maintenance passes moved to their own panel; mount that directly
    // rather than the whole page it renders inside.
    return TestBed.createComponent(LibraryMaintenancePanelComponent).componentInstance;
  }

  /** A review snapshot with one pass in flight. */
  function running(taskId: string): Partial<ServiceReview> {
    return {
      maintenance: {
        phase: 'running',
        taskId,
        label: 'Optimize metadata',
        total: 10,
        visited: 4,
        lastItems: ['Artist — Album'],
        detail: {},
        dryRun: false,
        params: 'apply',
        startedAt: null,
        finishedAt: null,
        lastOutcome: null,
        lastError: null,
        startedBy: null,
      },
    } as unknown as Partial<ServiceReview>;
  }

  it('starts the pass and reports it as backgrounded', async () => {
    const c = await setup();
    await c.optimizeAllMetadata();
    expect(start).toHaveBeenCalledWith('metadata-optimize');
    expect(c.optimizeMetadataMsg()).toBe('admin.maintenanceStarted');
    expect(BASE_CATALOG).toHaveProperty(['admin.maintenanceStarted']);
  });

  it('disables the button while any pass runs, not just its own', async () => {
    const c = await setup(running('library-sync'));
    expect(c.optimizeMetadataDisabled()).toBe(true);
    // …but only its own pass shows the "Optimizing…" label.
    expect(c.optimizeRunning()).toBe(false);
  });

  it('enables Stop only while something is running', async () => {
    expect((await setup()).cancelMaintenanceDisabled()).toBe(true);
    expect((await setup(running('metadata-optimize'))).cancelMaintenanceDisabled()).toBe(false);
  });

  it('reports progress off the shared review slice', async () => {
    const c = await setup(running('metadata-optimize'));
    expect(c.optimizeRunning()).toBe(true);
    expect(c.maintenanceProgressPercent()).toBe(40);
  });

  it('blames Lidarr only on a 503, never on a busy pass', async () => {
    const busy = await setup({}, () => throwError(() => ({ status: 409 })));
    await busy.optimizeAllMetadata();
    expect(busy.optimizeMetadataMsg()).toBe('admin.maintenanceBusy');
    expect(BASE_CATALOG).toHaveProperty(['admin.maintenanceBusy']);

    const noLidarr = await setup({}, () => throwError(() => ({ status: 503 })));
    await noLidarr.optimizeAllMetadata();
    expect(noLidarr.optimizeMetadataMsg()).toBe('admin.metadataOptimizeUnavailable');
    expect(BASE_CATALOG).toHaveProperty(['admin.metadataOptimizeUnavailable']);

    const other = await setup({}, () => throwError(() => ({ status: 500 })));
    await other.optimizeAllMetadata();
    expect(other.optimizeMetadataMsg()).toBe('admin.metadataOptimizeFailed');
  });

  it('cancels the running pass', async () => {
    const c = await setup(running('metadata-optimize'));
    await c.cancelMaintenance();
    expect(cancel).toHaveBeenCalled();
  });
});
