import { TestBed } from '@angular/core/testing';
import {
  ImportDropCardComponent,
  albumCountOf,
  formatBytes,
  type ImportDropState,
  type ImportDropSummary,
} from './import-drop-card.component';
import { setInputValue } from '../../../testing/signal-input';

function summary(over: Partial<ImportDropSummary> = {}): ImportDropSummary {
  return { fileCount: 12, albumCount: 1, totalBytes: 1024, skipped: [], ...over };
}

function render(state: ImportDropState, over: Partial<ImportDropSummary> = {}, percent = 0) {
  // Reset per render: a couple of these tests render twice to compare states,
  // and TestBed refuses reconfiguration once instantiated.
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ imports: [ImportDropCardComponent] });
  const fixture = TestBed.createComponent(ImportDropCardComponent);
  setInputValue(fixture.componentInstance.state, state);
  setInputValue(fixture.componentInstance.summary, summary(over));
  setInputValue(fixture.componentInstance.percent, percent);
  fixture.detectChanges();
  return fixture;
}

describe('formatBytes', () => {
  it('scales to a readable unit', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });

  it('drops the decimal once the number is big enough not to need it', () => {
    expect(formatBytes(400 * 1024 * 1024)).toBe('400 MB');
  });
});

describe('albumCountOf', () => {
  // The server groups by directory, so this is what actually lands. Counting
  // files instead would promise a 3-album drop as "37 things".
  it('counts distinct directories, not files', () => {
    expect(albumCountOf(['A/1.flac', 'A/2.flac', 'B/1.flac'])).toBe(2);
  });

  it('treats a bare file as its own group', () => {
    expect(albumCountOf(['1.flac'])).toBe(1);
  });

  it('keeps discs of one release separate, matching how they are staged', () => {
    expect(albumCountOf(['A/CD1/1.flac', 'A/CD2/1.flac'])).toBe(2);
  });
});

describe('ImportDropCardComponent', () => {
  it('offers Add before anything is uploaded, and no progress bar', () => {
    const fixture = render('manifest');
    expect(fixture.nativeElement.querySelector('[data-testid="import-drop-start"]')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="import-drop-bar"]')).toBeNull();
  });

  it('swaps Add for a progress bar while uploading', () => {
    const fixture = render('uploading', {}, 42);
    expect(fixture.nativeElement.querySelector('[data-testid="import-drop-start"]')).toBeNull();
    const bar = fixture.nativeElement.querySelector('[data-testid="import-drop-bar"]');
    expect(bar.style.width).toBe('42%');
  });

  // The upload is done but the server has not taken the job yet; the bar being
  // full while the percentage still said 99 read as a stall.
  it('fills the bar at commit rather than leaving it stuck at 99', () => {
    const fixture = render('committing', {}, 99);
    expect(fixture.nativeElement.querySelector('[data-testid="import-drop-bar"]').style.width).toBe(
      '100%',
    );
  });

  it('offers Retry, not Add, after a failure', () => {
    const fixture = render('error');
    expect(fixture.nativeElement.querySelector('[data-testid="import-drop-retry"]')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="import-drop-start"]')).toBeNull();
  });

  it('mentions dropped files only when some were dropped', () => {
    expect(
      render('manifest').nativeElement.querySelector('[data-testid="import-drop-skipped"]'),
    ).toBeNull();
    expect(
      render('manifest', { skipped: ['a.nfo'] }).nativeElement.querySelector(
        '[data-testid="import-drop-skipped"]',
      ),
    ).not.toBeNull();
  });

  it('always offers a way out, whatever the state', () => {
    for (const state of ['manifest', 'uploading', 'committing', 'error'] as ImportDropState[]) {
      expect(
        render(state).nativeElement.querySelector('[data-testid="import-drop-cancel"]'),
      ).not.toBeNull();
    }
  });
});
