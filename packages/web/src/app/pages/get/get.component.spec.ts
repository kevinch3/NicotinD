import { TestBed } from '@angular/core/testing';
import { Component, signal } from '@angular/core';
import { ActivatedRoute, Router, provideRouter } from '@angular/router';
import { describe, expect, it, vi } from 'vitest';
import { GetComponent, parseGetTab } from './get.component';
import { SearchComponent } from '../search/search.component';
import { DownloadsComponent } from '../downloads/downloads.component';
import { TransferService } from '../../services/transfer.service';
import { AcquireService } from '../../services/acquire.service';

@Component({ selector: 'app-search', standalone: true, template: '<div id="find-pane"></div>' })
class SearchStub {}

@Component({ selector: 'app-downloads', standalone: true, template: '<div id="dl-pane"></div>' })
class DownloadsStub {}

function setup(tab?: string, opts: { active?: number; jobs?: number } = {}) {
  const navigate = vi.fn().mockResolvedValue(true);

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
        useValue: { activeDownloadCount: signal(opts.active ?? 0) },
      },
      {
        provide: AcquireService,
        useValue: { activeJobs: signal(new Array(opts.jobs ?? 0).fill({})) },
      },
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
    expect(parseGetTab('downloads')).toBe('downloads');
  });

  it('falls back to find for absent or unrecognized values', () => {
    // `?tab=` is user-editable, so anything unknown must not render a blank page.
    expect(parseGetTab(null)).toBe('find');
    expect(parseGetTab('')).toBe('find');
    expect(parseGetTab('nonsense')).toBe('find');
    expect(parseGetTab('DOWNLOADS')).toBe('find');
  });
});

describe('GetComponent', () => {
  it('defaults to the Find tab and mounts only that child', () => {
    const { fixture } = setup();
    expect(fixture.componentInstance.tab()).toBe('find');
    expect(fixture.nativeElement.querySelector('#find-pane')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('#dl-pane')).toBeNull();
  });

  it('opens straight onto Downloads when the URL says so (the /downloads redirect target)', () => {
    const { fixture } = setup('downloads');
    expect(fixture.componentInstance.tab()).toBe('downloads');
    expect(fixture.nativeElement.querySelector('#dl-pane')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('#find-pane')).toBeNull();
  });

  it('destroys the inactive pane rather than hiding it', () => {
    // Load-bearing: the inactive child must unregister its pull-to-refresh
    // handler (that service is a stack spliced on destroy) and tear down its
    // polling. `[hidden]` would leak both.
    const { fixture } = setup();
    fixture.componentInstance.setTab('downloads');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('#find-pane')).toBeNull();
    expect(fixture.nativeElement.querySelector('#dl-pane')).toBeTruthy();
  });

  it('mirrors the tab into the URL so the view is linkable', () => {
    const { fixture, navigate } = setup();
    fixture.componentInstance.setTab('downloads');
    expect(navigate).toHaveBeenCalledWith(
      [],
      expect.objectContaining({ queryParams: { tab: 'downloads' }, queryParamsHandling: 'merge' }),
    );
  });

  it('does not navigate when the active tab is re-selected', () => {
    const { fixture, navigate } = setup();
    fixture.componentInstance.setTab('find');
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
