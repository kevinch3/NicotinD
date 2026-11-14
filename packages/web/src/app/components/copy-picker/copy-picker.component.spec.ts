import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { CopyPickerComponent } from './copy-picker.component';
import { setInputValue } from '../../../testing/signal-input';
import { TranslateService, interpolate } from '../../services/translate.service';
import { folderToCopy, type CopyCandidate } from '../../lib/copy-candidate';
import EN from '../../../../public/i18n/en.json';

const copy = (username: string, free: boolean): CopyCandidate =>
  folderToCopy(
    {
      username,
      directory: `Music\\${username}\\Album`,
      uploadSpeed: 1,
      freeUploadSlots: free ? 1 : 0,
      queueLength: free ? 0 : 4,
      files: [{ filename: `Music\\${username}\\Album\\01.flac`, size: 1_000_000 }],
    },
    12,
  );

function render(
  copies: CopyCandidate[],
  opts: { replaces?: boolean; status?: string; searching?: boolean; notice?: string | null } = {},
) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [CopyPickerComponent],
    providers: [
      {
        provide: TranslateService,
        useValue: {
          lang: signal('en'),
          revision: signal(0),
          t: (key: string, params?: Record<string, string | number>) =>
            interpolate((EN as Record<string, string>)[key] ?? key, params),
        },
      },
    ],
  });
  const fixture = TestBed.createComponent(CopyPickerComponent);
  const c = fixture.componentInstance;
  setInputValue(c.title, 'The Best of Ennio Morricone');
  setInputValue(c.artist, 'Ennio Morricone');
  setInputValue(c.copies, copies);
  setInputValue(c.replaces, opts.replaces ?? false);
  setInputValue(c.status, opts.status ?? '');
  setInputValue(c.searching, opts.searching ?? false);
  setInputValue(c.notice, opts.notice ?? null);
  const picked: CopyCandidate[] = [];
  let closed = 0;
  c.pick.subscribe((x) => picked.push(x));
  c.close.subscribe(() => closed++);
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const q = (id: string) => el.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const rows = () => Array.from(el.querySelectorAll<HTMLElement>('[data-testid="copy-row"]'));
  return { fixture, el, q, rows, picked, closed: () => closed };
}

describe('CopyPickerComponent', () => {
  it('lists every copy with the facts that decide, best first and preselected', () => {
    const { rows, q, picked } = render([copy('alpha', true), copy('beta', false)]);
    expect(rows()).toHaveLength(2);
    expect(rows()[0]!.getAttribute('aria-checked')).toBe('true');
    expect(rows()[0]!.querySelector('[data-testid="copy-completeness"]')!.textContent).toContain(
      '1/12',
    );
    expect(rows()[0]!.querySelector('[data-testid="copy-format"]')!.textContent).toBe('FLAC');
    expect(rows()[0]!.querySelector('[data-testid="copy-readiness"]')!.textContent).toBe('free');
    expect(rows()[1]!.querySelector('[data-testid="copy-readiness"]')!.textContent).toBe('queue 4');
    q('copy-picker-get')!.click();
    expect(picked.map((c) => c.username)).toEqual(['alpha']);
  });

  it('a tapped row is the one the footer gets', () => {
    const { fixture, rows, q, picked } = render([copy('alpha', true), copy('beta', false)]);
    rows()[1]!.click();
    fixture.detectChanges();
    expect(rows()[1]!.getAttribute('aria-checked')).toBe('true');
    q('copy-picker-get')!.click();
    expect(picked.map((c) => c.username)).toEqual(['beta']);
  });

  it('while a Get runs for the work, the footer replaces it and the header says so', () => {
    const { q } = render([copy('alpha', true)], { replaces: true, status: 'Downloading · 3/12' });
    expect(q('copy-picker-get')!.textContent).toContain('Replace with this copy');
    expect(q('copy-picker-status')!.textContent).toBe('Downloading · 3/12');
  });

  it('no copies: says so and offers nothing to get', () => {
    const { q } = render([]);
    expect(q('copy-picker-empty')).not.toBeNull();
    expect(q('copy-picker-get')).toBeNull();
  });

  it('while the hunt scores copies, says so; an empty list reads as still looking', () => {
    const { q } = render([], { searching: true });
    expect(q('copy-picker-scoring')).not.toBeNull();
    expect(q('copy-picker-empty')!.textContent).toContain('Looking for copies');
  });

  it('shows why a list may be incomplete', () => {
    const { q } = render([], { notice: 'The source is busy' });
    expect(q('copy-picker-notice')!.textContent).toContain('The source is busy');
    expect(q('copy-picker-scoring')).toBeNull();
  });

  it('closes from its button', () => {
    const { q, closed } = render([copy('alpha', true)]);
    q('copy-picker-close')!.click();
    expect(closed()).toBe(1);
  });
});
