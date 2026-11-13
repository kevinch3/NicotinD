import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { GetTrackRowComponent, type TrackRowState } from './get-track-row.component';
import { setInputValue } from '../../../testing/signal-input';
import { TranslateService, interpolate } from '../../services/translate.service';
import EN from '../../../../public/i18n/en.json';

interface Inputs {
  state: TrackRowState;
  percent: number;
  cancelJobId: string | null;
  copies: number;
  opensExternally: boolean;
  testid: string;
}

function render(inputs: Partial<Inputs> = {}) {
  // One fresh component per scenario (signal-input.ts landmine 2).
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [GetTrackRowComponent],
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
  const fixture = TestBed.createComponent(GetTrackRowComponent);
  const c = fixture.componentInstance;
  setInputValue(c.title, "L'estasi dell'oro");
  setInputValue(c.subtitle, 'Ennio Morricone');
  setInputValue(c.facts, 'FLAC · 28 MB · 5:12');
  setInputValue(c.state, inputs.state ?? 'idle');
  setInputValue(c.percent, inputs.percent ?? 0);
  setInputValue(c.cancelJobId, inputs.cancelJobId ?? null);
  setInputValue(c.copies, inputs.copies ?? 0);
  setInputValue(c.opensExternally, inputs.opensExternally ?? false);
  setInputValue(c.testid, inputs.testid ?? 'acquire-result');
  const emitted = { get: 0, cancel: [] as string[] };
  c.get.subscribe(() => emitted.get++);
  c.cancel.subscribe((id) => emitted.cancel.push(id));
  fixture.detectChanges();
  const q = (id: string) =>
    (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>(`[data-testid="${id}"]`);
  return { q, emitted };
}

describe('GetTrackRowComponent', () => {
  it('idle: two lines of facts and a Get', () => {
    const { q, emitted } = render({ copies: 14 });
    const row = q('acquire-result')!;
    expect(row.textContent).toContain('Ennio Morricone');
    expect(row.textContent).toContain('FLAC · 28 MB · 5:12');
    expect(q('track-copies')!.textContent).toBe('14 copies');
    q('acquire-result-get')!.click();
    expect(emitted.get).toBe(1);
  });

  it('one copy says nothing about copies', () => {
    expect(render({ copies: 1 }).q('track-copies')).toBeNull();
  });

  it('working: the percent, and Cancel beside it once a job exists', () => {
    const { q, emitted } = render({ state: 'working', percent: 42, cancelJobId: 'job-9' });
    const get = q('acquire-result-get') as HTMLButtonElement;
    expect(get.disabled).toBe(true);
    expect(get.textContent!.trim()).toBe('42%');
    q('acquire-result-cancel')!.click();
    expect(emitted).toEqual({ get: 0, cancel: ['job-9'] });
  });

  it('no Cancel without a job, and none once the file is done', () => {
    expect(render({ state: 'working' }).q('acquire-result-cancel')).toBeNull();
    const done = render({ state: 'done', cancelJobId: 'job-9' });
    expect(done.q('acquire-result-cancel')).toBeNull();
    expect(done.q('acquire-result-get')).toBeNull();
    expect(done.q('acquire-result-status')!.textContent).toBe('Downloaded ✓');
  });

  it('failed: says so and keeps Get, to try again', () => {
    const { q, emitted } = render({ state: 'failed' });
    expect(q('acquire-result-status')!.textContent).toBe('✗ Error');
    q('acquire-result-get')!.click();
    expect(emitted.get).toBe(1);
  });

  it('a link with no resolver opens its source instead of getting it', () => {
    const { q } = render({ opensExternally: true });
    expect(q('acquire-result-get')!.textContent).toContain('Open in Spotify');
  });

  it('the Advanced lane keeps its own ids', () => {
    const { q } = render({ testid: 'song-result' });
    expect(q('song-result')).not.toBeNull();
    expect(q('song-result-get')).not.toBeNull();
  });
});
