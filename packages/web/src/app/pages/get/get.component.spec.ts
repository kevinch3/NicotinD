import { TestBed } from '@angular/core/testing';
import { Component, signal } from '@angular/core';
import { ActivatedRoute, Router, provideRouter } from '@angular/router';
import { describe, expect, it, vi } from 'vitest';
import { GetComponent, parseGetTab } from './get.component';
import { SearchComponent } from '../search/search.component';
import { DownloadsComponent } from '../downloads/downloads.component';
import { TransferService } from '../../services/transfer.service';
import { AcquireService } from '../../services/acquire.service';
import { AuthService } from '../../services/auth.service';
import { ImportUploadService } from '../../services/import-upload.service';

@Component({ selector: 'app-search', standalone: true, template: '<div id="find-pane"></div>' })
class SearchStub {}

@Component({ selector: 'app-downloads', standalone: true, template: '<div id="dl-pane"></div>' })
class DownloadsStub {}

interface SetupOpts {
  active?: number;
  jobs?: number;
  canImport?: boolean;
  upload?: ImportUploadService['upload'];
}

function setup(tab?: string, opts: SetupOpts = {}) {
  const navigate = vi.fn().mockResolvedValue(true);
  const extra =
    opts.canImport === undefined
      ? []
      : [
          { provide: AuthService, useValue: { canImport: signal(opts.canImport) } },
          {
            provide: ImportUploadService,
            useValue: { upload: opts.upload ?? vi.fn().mockResolvedValue('job-1') },
          },
        ];

  TestBed.configureTestingModule({
    imports: [GetComponent],
    providers: [
      provideRouter([]),
      {
        provide: ActivatedRoute,
        useValue: {
          snapshot: { queryParamMap: new Map([['tab', tab ?? null]]) as never },
        },
      },
      {
        provide: TransferService,
        useValue: {
          activeDownloadCount: signal(opts.active ?? 0),
          kickPoll: vi.fn().mockResolvedValue(undefined),
        },
      },
      {
        provide: AcquireService,
        useValue: { activeJobs: signal(new Array(opts.jobs ?? 0).fill({})) },
      },
      ...extra,
    ],
  });
  // The shell must not drag the real 1000-line children into a unit test —
  // it only owns the tab bar and the param.
  TestBed.overrideComponent(GetComponent, {
    remove: { imports: [SearchComponent, DownloadsComponent] },
    add: { imports: [SearchStub, DownloadsStub] },
  });

  const fixture = TestBed.createComponent(GetComponent);
  const router = TestBed.inject(Router);
  vi.spyOn(router, 'navigate').mockImplementation(navigate);
  fixture.detectChanges();
  return { fixture, navigate };
}

describe('parseGetTab', () => {
  it('accepts the downloads tab', () => {
    expect(parseGetTab('activity')).toBe('activity');
  });

  it('falls back to find for absent or unrecognized values', () => {
    // `?tab=` is user-editable, so anything unknown must not render a blank page.
    expect(parseGetTab(null)).toBe('add');
    expect(parseGetTab('')).toBe('add');
    expect(parseGetTab('nonsense')).toBe('add');
    expect(parseGetTab('ACTIVITY')).toBe('add');
  });
});

describe('GetComponent', () => {
  it('defaults to the Find tab and mounts only that child', () => {
    const { fixture } = setup();
    expect(fixture.componentInstance.tab()).toBe('add');
    expect(fixture.nativeElement.querySelector('#find-pane')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('#dl-pane')).toBeNull();
  });

  it('opens straight onto Downloads when the URL says so (the /downloads redirect target)', () => {
    const { fixture } = setup('activity');
    expect(fixture.componentInstance.tab()).toBe('activity');
    expect(fixture.nativeElement.querySelector('#dl-pane')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('#find-pane')).toBeNull();
  });

  it('destroys the inactive pane rather than hiding it', () => {
    // Load-bearing: the inactive child must unregister its pull-to-refresh
    // handler (that service is a stack spliced on destroy) and tear down its
    // polling. `[hidden]` would leak both.
    const { fixture } = setup();
    fixture.componentInstance.setTab('activity');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('#find-pane')).toBeNull();
    expect(fixture.nativeElement.querySelector('#dl-pane')).toBeTruthy();
  });

  it('mirrors the tab into the URL so the view is linkable', () => {
    const { fixture, navigate } = setup();
    fixture.componentInstance.setTab('activity');
    expect(navigate).toHaveBeenCalledWith(
      [],
      expect.objectContaining({ queryParams: { tab: 'activity' }, queryParamsHandling: 'merge' }),
    );
  });

  it('does not navigate when the active tab is re-selected', () => {
    const { fixture, navigate } = setup();
    fixture.componentInstance.setTab('add');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('badges the Downloads tab with transfers plus in-flight acquire jobs', () => {
    const { fixture } = setup(undefined, { active: 2, jobs: 3 });
    expect(fixture.componentInstance.activeCount()).toBe(5);
    const badge = fixture.nativeElement.querySelector(
      '[data-testid="get-tab-downloads-badge"]',
    ) as HTMLElement;
    expect(badge?.textContent?.trim()).toBe('5');
  });

  it('hides the badge when nothing is in flight', () => {
    const { fixture } = setup();
    expect(
      fixture.nativeElement.querySelector('[data-testid="get-tab-downloads-badge"]'),
    ).toBeNull();
  });
});

// #664. The tabs were renamed (Find → Add, Downloads → Activity) but the old
// `?tab=` values are in bookmarks, in shared links, and in the `/downloads` and
// `/search` redirects. A renamed tab is not a reason to break a URL.
describe('parseGetTab — legacy aliases', () => {
  it('still accepts the pre-rename values', () => {
    expect(parseGetTab('downloads')).toBe('activity');
    expect(parseGetTab('find')).toBe('add');
  });
});

// #1664. Import-from-folder is an Add-tab action. It used to render — and the
// whole page used to accept a drop — on the Activity tab too.
describe('GetComponent — import is an Add-tab action', () => {
  const q = (f: { nativeElement: HTMLElement }, id: string) =>
    f.nativeElement.querySelector(`[data-testid="${id}"]`);

  function fileDrag(): DragEvent {
    const file = new File(['x'], 'a.flac');
    const dataTransfer = {
      types: ['Files'],
      dropEffect: 'none',
      items: [{ kind: 'file', getAsFile: () => file }],
    };
    return { dataTransfer, preventDefault: vi.fn() } as unknown as DragEvent;
  }

  function pick(fixture: { componentInstance: GetComponent }): void {
    const file = new File(['x'], '01.flac');
    Object.defineProperty(file, 'webkitRelativePath', { value: 'Album/01.flac' });
    const target = { files: [file], value: 'x' } as unknown as HTMLInputElement;
    fixture.componentInstance.onFolderPicked({ target } as unknown as Event);
  }

  it('offers the entry and the folder input on the Add tab', () => {
    const { fixture } = setup('add', { canImport: true });
    expect(q(fixture, 'import-browse')).not.toBeNull();
    expect(q(fixture, 'import-folder-input')).not.toBeNull();
  });

  it('renders no import entry on the Activity tab', () => {
    const { fixture } = setup('activity', { canImport: true });
    expect(q(fixture, 'import-browse')).toBeNull();
    expect(q(fixture, 'import-folder-input')).toBeNull();
  });

  it('hides the import entry on both tabs without canImport', () => {
    for (const tab of ['add', 'activity']) {
      TestBed.resetTestingModule();
      const { fixture } = setup(tab, { canImport: false });
      expect(q(fixture, 'import-browse')).toBeNull();
    }
  });

  it('ignores a folder dropped on the Activity tab, but still swallows it', async () => {
    const { fixture } = setup('activity', { canImport: true });
    const c = fixture.componentInstance;
    const enter = fileDrag();
    c.onDragEnter(enter);
    expect(c.dragging()).toBe(false);

    const over = fileDrag();
    c.onDragOver(over);
    // Swallowed, or the browser navigates to the file and discards the SPA.
    expect(over.preventDefault).toHaveBeenCalled();
    expect(over.dataTransfer!.dropEffect).toBe('none');

    const drop = fileDrag();
    await c.onDrop(drop);
    expect(drop.preventDefault).toHaveBeenCalled();
    expect(c.dropped()).toBeNull();
    expect(c.tab()).toBe('activity');
    fixture.detectChanges();
    expect(q(fixture, 'import-drop-overlay')).toBeNull();
  });

  it('accepts a drop on the Add tab', async () => {
    const { fixture } = setup('add', { canImport: true });
    const c = fixture.componentInstance;
    c.onDragEnter(fileDrag());
    expect(c.dragging()).toBe(true);
    await c.onDrop(fileDrag());
    expect(c.dropped()).toHaveLength(1);
  });

  it('keeps an upload running across a switch to Activity, with a progress row and a badge', async () => {
    let progress: ((p: number) => void) | undefined;
    let finish!: (id: string) => void;
    const upload = vi.fn((_files: unknown, opts?: { onProgress?: (p: number) => void }) => {
      progress = opts?.onProgress;
      return new Promise<string>((resolve) => (finish = resolve));
    });
    const { fixture } = setup('add', { canImport: true, upload, active: 1 });
    const c = fixture.componentInstance;
    pick(fixture);
    const done = c.startImport();
    progress?.(42);

    c.setTab('activity');
    fixture.detectChanges();
    expect(q(fixture, 'import-drop-card')).toBeNull();
    const row = q(fixture, 'import-progress-row') as HTMLElement;
    expect(row).not.toBeNull();
    expect(q(fixture, 'import-progress-percent')?.textContent).toContain('42%');
    expect((q(fixture, 'import-progress-bar') as HTMLElement).style.width).toBe('42%');
    // The upload is in-flight work the Activity tab now accounts for.
    expect(c.activeCount()).toBe(2);
    expect(q(fixture, 'get-tab-downloads-badge')?.textContent?.trim()).toBe('2');

    finish('job-1');
    await done;
    fixture.detectChanges();
    expect(q(fixture, 'import-progress-row')).toBeNull();
    expect(c.activeCount()).toBe(1);
  });

  it('surfaces a failed background upload on Activity and leads back to Add', async () => {
    let fail!: (e: unknown) => void;
    const upload = vi.fn(() => new Promise<string>((_r, reject) => (fail = reject)));
    const { fixture } = setup('add', { canImport: true, upload });
    const c = fixture.componentInstance;
    pick(fixture);
    const done = c.startImport();
    c.setTab('activity');
    fail(new Error('boom'));
    await done;
    fixture.detectChanges();
    expect(q(fixture, 'import-progress-error')).not.toBeNull();
    // A failure is not in-flight work, so it does not inflate the badge.
    expect(c.activeCount()).toBe(0);
    (q(fixture, 'import-progress-review') as HTMLButtonElement).click();
    expect(c.tab()).toBe('add');
  });

  it('shows no progress row while a drop only awaits confirmation', () => {
    const { fixture } = setup('add', { canImport: true });
    pick(fixture);
    fixture.componentInstance.setTab('activity');
    fixture.detectChanges();
    expect(q(fixture, 'import-progress-row')).toBeNull();
  });
});
