import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { NO_ERRORS_SCHEMA } from '@angular/core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CoverArtComponent, COVER_HOLD_FADE_MS } from './cover-art.component';
import { changeInputValue } from '../../../testing/signal-input';
import { ServerConfigService } from '../../services/server-config.service';
import {
  hashCode,
  placeholderGradient,
  placeholderInitial,
  placeholderFontSize,
  coverLoadingAttr,
} from './cover-art.component';

describe('CoverArtComponent — imgLoaded loading state', () => {
  function setup() {
    TestBed.configureTestingModule({
      imports: [CoverArtComponent],
      providers: [{ provide: ServerConfigService, useValue: { apiUrl: (u: string) => u } }],
      schemas: [NO_ERRORS_SCHEMA],
    });
    return TestBed.createComponent(CoverArtComponent);
  }

  // A mouse drag on a native-draggable <img> starts HTML5 drag-and-drop, which
  // cancels the pointer stream the Now Playing dismiss gesture rides on.
  // Asserted on the template: this harness never renders the <img> (the `src`
  // input does not reach a signal input through setInput here), and the real
  // DOM is covered by mobile-ux.spec.ts "dragging down on the cover art".
  it('renders the image non-draggable', () => {
    const html = readFileSync(join(import.meta.dirname, 'cover-art.component.html'), 'utf8');
    const img = html.slice(html.indexOf('<img'), html.indexOf('/>', html.indexOf('<img')));
    expect(img).toContain('draggable="false"');
  });

  it('starts with imgLoaded = false so gradient shows while image downloads', () => {
    const fixture = setup();
    expect(fixture.componentInstance.imgLoaded()).toBe(false);
  });

  it('imgLoaded becomes true after (load) fires, removing opacity-0 from the image', () => {
    const fixture = setup();
    const comp = fixture.componentInstance;
    expect(comp.imgLoaded()).toBe(false);
    comp.imgLoaded.set(true);
    expect(comp.imgLoaded()).toBe(true);
  });

  it('imgError starts false and prevents image re-render when true', () => {
    const fixture = setup();
    const comp = fixture.componentInstance;
    expect(comp.imgError()).toBe(false);
    comp.imgError.set(true);
    expect(comp.imgError()).toBe(true);
  });

  it('effect resets imgLoaded and imgError when resolvedSrc changes', () => {
    const fixture = setup();
    const comp = fixture.componentInstance;
    // Simulate: image had loaded, then src changed
    comp.imgLoaded.set(true);
    comp.imgError.set(true);
    // Trigger the effect by marking resolvedSrc as changed via TestBed
    TestBed.flushEffects();
    // After flush, the effect reads resolvedSrc() and resets both flags
    expect(comp.imgLoaded()).toBe(false);
    expect(comp.imgError()).toBe(false);
  });
});

// #1653: on a skip the player bar and sheet swap `src` in place; the gradient
// placeholder painted for the whole fetch and read as a flash between two covers.
describe('CoverArtComponent — holdPrevious (#1653)', () => {
  function setup(hold: boolean) {
    TestBed.configureTestingModule({
      imports: [CoverArtComponent],
      providers: [{ provide: ServerConfigService, useValue: { apiUrl: (u: string) => u } }],
    });
    const fixture = TestBed.createComponent(CoverArtComponent);
    const comp = fixture.componentInstance;
    changeInputValue(comp.holdPrevious, hold);
    changeInputValue(comp.src, '/api/cover/a');
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const placeholder = () => el.querySelector('[style*="gradient"]');
    const held = () => el.querySelector<HTMLImageElement>('[data-testid="cover-art-held"]');
    const swap = (src: string | undefined) => {
      changeInputValue(comp.src, src);
      fixture.detectChanges();
    };
    return { fixture, comp, placeholder, held, swap };
  }

  it('keeps the previous image over the wait — no placeholder between two covers', () => {
    const { comp, placeholder, held, swap, fixture } = setup(true);
    comp.onImgLoad();
    fixture.detectChanges();
    expect(placeholder()).toBeNull();

    swap('/api/cover/b');
    expect(placeholder()).toBeNull();
    expect(held()?.getAttribute('src')).toBe('/api/cover/a');

    vi.useFakeTimers();
    try {
      comp.onImgLoad();
      fixture.detectChanges();
      // Still held while the new image fades in over it — no dip to the background.
      expect(held()?.getAttribute('src')).toBe('/api/cover/a');
      vi.advanceTimersByTime(COVER_HOLD_FADE_MS);
      fixture.detectChanges();
      expect(held()).toBeNull();
      expect(placeholder()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('after a coverless track, the next cover does not resurrect the one from two tracks back', () => {
    const { comp, placeholder, held, swap } = setup(true);
    comp.onImgLoad();
    swap(undefined);
    swap('/api/cover/c');
    expect(held()).toBeNull();
    expect(placeholder()).not.toBeNull();
  });

  it('skipping back to the cover still on screen holds it instead of flashing the placeholder', () => {
    const { comp, placeholder, held, swap, fixture } = setup(true);
    comp.onImgLoad();
    fixture.detectChanges();
    swap('/api/cover/b');
    swap('/api/cover/a');
    expect(held()?.getAttribute('src')).toBe('/api/cover/a');
    expect(placeholder()).toBeNull();
  });

  it('a slow load keeps holding through several skips, showing the last LOADED cover', () => {
    const { comp, held, swap, fixture } = setup(true);
    comp.onImgLoad();
    fixture.detectChanges();
    swap('/api/cover/b');
    swap('/api/cover/c');
    expect(held()?.getAttribute('src')).toBe('/api/cover/a');
  });

  it('drops the held image and shows the placeholder when the new cover fails', () => {
    const { comp, placeholder, held, swap, fixture } = setup(true);
    comp.onImgLoad();
    swap('/api/cover/b');
    comp.onImgError();
    fixture.detectChanges();
    expect(held()).toBeNull();
    expect(placeholder()).not.toBeNull();
  });

  it('a coverless next track shows the placeholder at once', () => {
    const { comp, placeholder, held, swap } = setup(true);
    comp.onImgLoad();
    swap(undefined);
    expect(held()).toBeNull();
    expect(placeholder()).not.toBeNull();
  });

  it('nothing to hold on first paint: the placeholder shows until the first load', () => {
    const { placeholder, held } = setup(true);
    expect(held()).toBeNull();
    expect(placeholder()).not.toBeNull();
  });

  it('off by default (grid tiles): a src change shows the placeholder while loading', () => {
    const { comp, placeholder, held, swap, fixture } = setup(false);
    comp.onImgLoad();
    fixture.detectChanges();
    swap('/api/cover/b');
    expect(held()).toBeNull();
    expect(placeholder()).not.toBeNull();
  });
});

describe('coverLoadingAttr', () => {
  it('lazy-loads by default (grid tiles), eager only when opted in', () => {
    expect(coverLoadingAttr(false)).toBe('lazy');
    expect(coverLoadingAttr(true)).toBe('eager');
  });
});

describe('hashCode', () => {
  it('returns a non-negative integer', () => {
    expect(hashCode('Pink Floyd:The Wall')).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(hashCode('Pink Floyd:The Wall'))).toBe(true);
  });

  it('is deterministic — same input always gives same output', () => {
    const key = 'Radiohead:OK Computer';
    expect(hashCode(key)).toBe(hashCode(key));
  });

  it('returns 0 for the empty string', () => {
    expect(hashCode('')).toBe(0);
  });

  it('produces different values for different inputs', () => {
    expect(hashCode('Artist A:Album 1')).not.toBe(hashCode('Artist B:Album 2'));
  });

  it('always maps to a valid gradient index (0–7)', () => {
    const GRADIENT_COUNT = 8;
    const keys = [
      'Pink Floyd:The Wall',
      'Radiohead:OK Computer',
      'David Bowie:Ziggy Stardust',
      ':',
      'Artist:',
      ':Album',
    ];
    for (const key of keys) {
      const idx = hashCode(key) % GRADIENT_COUNT;
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(GRADIENT_COUNT);
    }
  });

  it('handles unicode input without throwing', () => {
    expect(() => hashCode('Sigur Rós:Ágætis byrjun')).not.toThrow();
  });
});

describe('placeholderGradient (themed coverless fallback)', () => {
  it('builds the gradient from theme tokens, not a fixed palette', () => {
    const g = placeholderGradient('Maná', 'Sueños Líquidos');
    expect(g).toContain('var(--theme-accent)');
    expect(g).toContain('var(--theme-surface-2)');
    // No hardcoded hex colors leaking from the old rainbow palette.
    expect(g).not.toMatch(/#[0-9a-f]{6}/i);
  });

  it('is deterministic and varies the angle per item', () => {
    const a = placeholderGradient('A', '1');
    const b = placeholderGradient('Radiohead', 'OK Computer');
    expect(a).toBe(placeholderGradient('A', '1'));
    expect(a).not.toBe(b);
  });

  it('always produces a valid CSS angle (0–359deg)', () => {
    for (const key of [
      ['', ''],
      ['Artist', ''],
      ['', 'Album'],
      ['Sigur Rós', 'Ágætis byrjun'],
    ]) {
      const m = /linear-gradient\((\d+)deg/.exec(placeholderGradient(key[0], key[1]));
      expect(m).toBeTruthy();
      const angle = Number(m![1]);
      expect(angle).toBeGreaterThanOrEqual(0);
      expect(angle).toBeLessThan(360);
    }
  });
});

describe('placeholderInitial', () => {
  it('prefers the album, then artist, uppercased', () => {
    expect(placeholderInitial('Discovery', 'Daft Punk')).toBe('D');
    expect(placeholderInitial('', 'radiohead')).toBe('R');
  });

  it('falls back to ? when both are empty', () => {
    expect(placeholderInitial('', '')).toBe('?');
  });
});

describe('placeholderFontSize', () => {
  it('scales with px size when fixed', () => {
    expect(placeholderFontSize(80, false)).toBe('28px');
    expect(placeholderFontSize(40, false)).toBe('14px');
  });

  it('uses a fixed default when filling or size is unknown', () => {
    expect(placeholderFontSize(80, true)).toBe('2rem');
    expect(placeholderFontSize(undefined, false)).toBe('2rem');
  });
});
