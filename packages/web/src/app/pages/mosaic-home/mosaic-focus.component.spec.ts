import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { MosaicFocusComponent } from './mosaic-focus.component';
import { NO_PREVIEW, type FocusPreview } from '../../lib/mosaic-focus';
import type { Track } from '../../services/player.service';
import { BackButtonService } from '../../services/native/back-button.service';
import { setInputValue } from '../../../testing/signal-input';

const track = (i: number): Track => ({ id: `t${i}`, title: `Track ${i}`, artist: `Artist ${i}` });
const ready = (n: number): FocusPreview => ({
  status: 'ready',
  tracks: Array.from({ length: n }, (_, i) => track(i + 1)),
});

function setup(over: Record<string, unknown> = {}): ComponentFixture<MosaicFocusComponent> {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ imports: [MosaicFocusComponent] });
  const fixture = TestBed.createComponent(MosaicFocusComponent);
  const inputs: Record<string, unknown> = {
    title: 'Track 1',
    subtitle: 'Artist 1 · Album',
    background: 'linear-gradient(red, blue)',
    preview: NO_PREVIEW,
    side: 234,
    ...over,
  };
  const c = fixture.componentInstance as unknown as Record<string, never>;
  // One fresh component per scenario, written before the first render.
  for (const [k, v] of Object.entries(inputs)) setInputValue(c[k], v as never);
  // Attached before the first render, or the focus it takes has nowhere to land.
  document.body.appendChild(fixture.nativeElement);
  fixture.detectChanges();
  return fixture;
}

const q = (f: ComponentFixture<unknown>, id: string): HTMLElement | null =>
  (f.nativeElement as HTMLElement).querySelector(`[data-testid="${id}"]`);
const qa = (f: ComponentFixture<unknown>, id: string): HTMLElement[] => [
  ...(f.nativeElement as HTMLElement).querySelectorAll<HTMLElement>(`[data-testid="${id}"]`),
];

describe('MosaicFocusComponent', () => {
  afterEach(() => document.body.replaceChildren());

  it('shows the tile, a Play button, and a tag only when it has one', () => {
    const f = setup();
    expect(q(f, 'mosaic-focus-title')?.textContent).toBe('Track 1');
    expect(q(f, 'mosaic-focus-subtitle')?.textContent).toBe('Artist 1 · Album');
    expect(q(f, 'mosaic-focus-play')).not.toBeNull();
    expect(q(f, 'mosaic-focus-tag')).toBeNull();

    const tagged = setup({ tagKey: 'mosaic.tag.recent' });
    expect(q(tagged, 'mosaic-focus-tag')?.textContent).toBe('mosaic.tag.recent');
  });

  it('is sized by its side input', () => {
    const face = (setup().nativeElement as HTMLElement).querySelector<HTMLElement>(
      '.mosaic-focus-face',
    )!;
    expect(face.style.width).toBe('234px');
    expect(face.style.height).toBe('234px');
  });

  it('a song lists nothing', () => {
    expect(q(setup(), 'mosaic-focus-preview')).toBeNull();
  });

  it('a loading preview holds its place with placeholders', () => {
    const f = setup({ preview: { status: 'loading', tracks: [] } });
    expect(q(f, 'mosaic-focus-preview')).not.toBeNull();
    expect(qa(f, 'mosaic-focus-loading')).toHaveLength(3);
    expect(qa(f, 'mosaic-focus-preview-row')).toHaveLength(0);
  });

  it('a ready preview shows the first three tracks, title and artist', () => {
    const rows = qa(setup({ preview: ready(20) }), 'mosaic-focus-preview-row');
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toContain('Track 1');
    expect(rows[0].textContent).toContain('Artist 1');
    expect(rows[2].textContent).toContain('Track 3');
  });

  it('an empty preview says so and Play cannot be pressed', () => {
    const f = setup({ preview: { status: 'empty', tracks: [] } });
    expect(q(f, 'mosaic-focus-empty')).not.toBeNull();
    expect((q(f, 'mosaic-focus-play') as HTMLButtonElement).disabled).toBe(true);
  });

  it('offers Shuffle only when there are other tracks to draw', () => {
    expect(q(setup({ preview: ready(3) }), 'mosaic-focus-shuffle')).toBeNull();
    expect(q(setup({ preview: ready(2) }), 'mosaic-focus-shuffle')).toBeNull();
    expect(qa(setup({ preview: ready(2) }), 'mosaic-focus-preview-row')).toHaveLength(2);
    expect(q(setup({ preview: ready(4) }), 'mosaic-focus-shuffle')).not.toBeNull();
  });

  it('Play, Shuffle and ⋯ each report once, ⋯ with its own button', () => {
    const f = setup({ preview: ready(5) });
    const c = f.componentInstance;
    let plays = 0;
    let shuffles = 0;
    const mores: HTMLElement[] = [];
    c.play.subscribe(() => plays++);
    c.shuffle.subscribe(() => shuffles++);
    c.more.subscribe((el) => mores.push(el));
    q(f, 'mosaic-focus-play')!.click();
    q(f, 'mosaic-focus-shuffle')!.click();
    q(f, 'mosaic-focus-more')!.click();
    expect(plays).toBe(1);
    expect(shuffles).toBe(1);
    expect(mores).toEqual([q(f, 'mosaic-focus-more')]);
  });

  it('Play does nothing while a start is under way', () => {
    const f = setup({ busy: true });
    let plays = 0;
    f.componentInstance.play.subscribe(() => plays++);
    q(f, 'mosaic-focus-play')!.click();
    expect(plays).toBe(0);
  });

  it('a tile with no menu has no ⋯', () => {
    expect(q(setup({ hasMenu: false }), 'mosaic-focus-more')).toBeNull();
  });

  it('Back or Escape asks to be dismissed, and the entry leaves with the component', async () => {
    const f = setup();
    let dismissed = 0;
    f.componentInstance.dismiss.subscribe(() => dismissed++);
    const stack = TestBed.inject(BackButtonService).stack;
    expect(stack.handleBack()).toBe(true);
    expect(dismissed).toBe(1);
    f.destroy();
    expect(stack.handleBack()).toBe(false);
  });

  it('puts keyboard focus on Play when it appears', async () => {
    const f = setup();
    await f.whenStable();
    expect(document.activeElement).toBe(q(f, 'mosaic-focus-play'));
  });
});
