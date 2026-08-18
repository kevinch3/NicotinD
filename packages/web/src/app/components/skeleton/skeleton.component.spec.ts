import { TestBed } from '@angular/core/testing';
import {
  SkeletonComponent,
  skeletonAria,
  skeletonBarWidth,
  skeletonContainerClass,
  skeletonItemCount,
  skeletonItems,
  type SkeletonVariant,
} from './skeleton.component';
import { setInputValue } from '../../../testing/signal-input';

const ALL_VARIANTS: SkeletonVariant[] = [
  'album-tile',
  'artist-tile',
  'genre-tile',
  'track-row',
  'shelf-tile',
  'detail-header',
  'artist-header',
];

describe('skeletonItemCount', () => {
  it('falls back to the variant default when nothing is requested', () => {
    expect(skeletonItemCount('album-tile')).toBe(10);
    expect(skeletonItemCount('artist-tile')).toBe(10);
    expect(skeletonItemCount('genre-tile')).toBe(8);
    expect(skeletonItemCount('track-row')).toBe(8);
    expect(skeletonItemCount('shelf-tile')).toBe(6);
  });

  it('honours an explicit count', () => {
    expect(skeletonItemCount('album-tile', 3)).toBe(3);
    expect(skeletonItemCount('track-row', 1)).toBe(1);
  });

  it('clamps a nonsensical low count to 1 rather than rendering nothing', () => {
    expect(skeletonItemCount('album-tile', 0)).toBe(1);
    expect(skeletonItemCount('album-tile', -5)).toBe(1);
  });

  it('clamps a runaway count so a typo cannot lock the page up', () => {
    expect(skeletonItemCount('track-row', 999)).toBe(60);
  });

  it('ignores a non-finite count', () => {
    expect(skeletonItemCount('album-tile', Number.NaN)).toBe(10);
  });

  // A page header stands in for one thing; repeating it would be nonsense, so
  // the count input is ignored outright rather than merely defaulted.
  it('always renders exactly one header, whatever the caller asks for', () => {
    for (const v of ['detail-header', 'artist-header'] as SkeletonVariant[]) {
      expect(skeletonItemCount(v)).toBe(1);
      expect(skeletonItemCount(v, 12)).toBe(1);
      expect(skeletonItemCount(v, 0)).toBe(1);
    }
  });
});

describe('skeletonItems', () => {
  it('is a zero-based index list of the resolved length', () => {
    expect(skeletonItems('album-tile', 3)).toEqual([0, 1, 2]);
    expect(skeletonItems('detail-header', 9)).toEqual([0]);
  });
});

describe('skeletonContainerClass', () => {
  it('returns the real list container verbatim per variant', () => {
    expect(skeletonContainerClass('album-tile')).toBe(
      'grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4',
    );
    expect(skeletonContainerClass('genre-tile')).toBe(
      'grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3',
    );
    expect(skeletonContainerClass('track-row')).toBe('block space-y-0.5');
    expect(skeletonContainerClass('shelf-tile')).toBe('flex gap-3 overflow-x-auto pb-2 -mx-1 px-1');
  });

  it('replaces the default wholesale rather than appending to it', () => {
    const override = 'grid grid-cols-3 gap-2';
    expect(skeletonContainerClass('album-tile', override)).toBe(override);
    expect(skeletonContainerClass('album-tile', override)).not.toContain('lg:grid-cols-5');
  });

  it('treats a whitespace-only override as absent', () => {
    expect(skeletonContainerClass('track-row', '   ')).toBe('block space-y-0.5');
  });

  // The host element IS the container, and an unknown element is `inline` by
  // default — a variant whose class string forgets its display mode silently
  // collapses the list's vertical rhythm instead of failing loudly.
  it('every variant declares an explicit display class first', () => {
    for (const v of ALL_VARIANTS) {
      const first = skeletonContainerClass(v).split(' ')[0];
      expect(['grid', 'flex', 'block'], `${v} must start with a display class`).toContain(first);
    }
  });
});

describe('skeletonAria', () => {
  it('makes an unlabelled skeleton decorative', () => {
    expect(skeletonAria('')).toEqual({
      role: null,
      ariaLabel: null,
      ariaBusy: null,
      ariaHidden: 'true',
    });
  });

  it('makes a labelled skeleton an announced live region', () => {
    expect(skeletonAria('Loading albums')).toEqual({
      role: 'status',
      ariaLabel: 'Loading albums',
      ariaBusy: 'true',
      ariaHidden: null,
    });
  });

  it('treats a whitespace-only label as no label', () => {
    expect(skeletonAria('   ').ariaHidden).toBe('true');
    expect(skeletonAria('   ').role).toBeNull();
  });

  // A hidden live region is a contradiction; asserting it here is cheaper than
  // discovering it in the a11y:storybook:strict gate.
  it('never sets both a role and aria-hidden', () => {
    for (const label of ['', '  ', 'Loading songs']) {
      const a = skeletonAria(label);
      expect(a.role !== null && a.ariaHidden !== null).toBe(false);
    }
  });
});

describe('skeletonBarWidth', () => {
  it('is deterministic — the same index always yields the same width', () => {
    expect(skeletonBarWidth(3)).toBe(skeletonBarWidth(3));
    expect(skeletonBarWidth(0)).toBe(skeletonBarWidth(5));
  });

  it('varies across adjacent indices so a grid is not a wall of identical bars', () => {
    const widths = [0, 1, 2, 3, 4].map(skeletonBarWidth);
    expect(new Set(widths).size).toBe(5);
  });

  it('always returns a width utility, including for odd indices', () => {
    for (const i of [0, 7, 41, -3]) {
      expect(skeletonBarWidth(i)).toMatch(/^w-\d\/\d$/);
    }
  });
});

describe('SkeletonComponent rendering', () => {
  // Fresh fixture per scenario, inputs set before the first detectChanges —
  // see src/testing/signal-input.ts landmine #2.
  function render(setup: (c: SkeletonComponent) => void) {
    // Reset first: several cases render more than one fixture, and TestBed
    // refuses to be reconfigured once instantiated.
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ imports: [SkeletonComponent] });
    const fixture = TestBed.createComponent(SkeletonComponent);
    setup(fixture.componentInstance);
    fixture.detectChanges();
    return fixture;
  }

  it('renders exactly the requested number of tiles', () => {
    const fixture = render((c) => {
      setInputValue(c.variant, 'album-tile');
      setInputValue(c.count, 4);
    });
    const tiles = fixture.nativeElement.querySelectorAll('.aspect-square');
    expect(tiles.length).toBe(4);
  });

  it('puts the container classes on the host, not a wrapper', () => {
    const fixture = render((c) => setInputValue(c.variant, 'album-tile'));
    expect(fixture.nativeElement.className).toContain('lg:grid-cols-5');
  });

  it('animates every placeholder through the shared .skeleton-block class', () => {
    const fixture = render((c) => {
      setInputValue(c.variant, 'track-row');
      setInputValue(c.count, 3);
    });
    const blocks = fixture.nativeElement.querySelectorAll('.skeleton-block');
    expect(blocks.length).toBeGreaterThan(0);
  });

  // The decorative path sets aria-hidden, which axe flags as a violation if
  // anything inside it can take focus.
  it('renders nothing focusable, so aria-hidden is always safe', () => {
    for (const v of ALL_VARIANTS) {
      const fixture = render((c) => setInputValue(c.variant, v));
      const focusable = fixture.nativeElement.querySelectorAll(
        'a,button,input,select,textarea,[tabindex]',
      );
      expect(focusable.length, `${v} must not render focusable nodes`).toBe(0);
    }
  });

  it('is hidden from assistive tech when unlabelled', () => {
    const fixture = render((c) => setInputValue(c.variant, 'album-tile'));
    const host = fixture.nativeElement as HTMLElement;
    expect(host.getAttribute('aria-hidden')).toBe('true');
    expect(host.getAttribute('role')).toBeNull();
  });

  it('announces itself when labelled', () => {
    const fixture = render((c) => {
      setInputValue(c.variant, 'album-tile');
      setInputValue(c.label, 'Loading albums');
    });
    const host = fixture.nativeElement as HTMLElement;
    expect(host.getAttribute('role')).toBe('status');
    expect(host.getAttribute('aria-label')).toBe('Loading albums');
    expect(host.getAttribute('aria-busy')).toBe('true');
    expect(host.getAttribute('aria-hidden')).toBeNull();
  });

  // album-detail passes [showCover]="false" to its real rows; without the
  // matching toggle the skeleton would be one 36px cover too wide per row.
  it('drops the cover block when trackCover is off', () => {
    const withCover = render((c) => {
      setInputValue(c.variant, 'track-row');
      setInputValue(c.count, 1);
    }).nativeElement.querySelectorAll('.skeleton-block').length;

    const without = render((c) => {
      setInputValue(c.variant, 'track-row');
      setInputValue(c.count, 1);
      setInputValue(c.trackCover, false);
    }).nativeElement.querySelectorAll('.skeleton-block').length;

    expect(without).toBe(withCover - 1);
  });

  it('honours a container override on the host', () => {
    const fixture = render((c) => {
      setInputValue(c.variant, 'album-tile');
      setInputValue(c.containerClass, 'grid grid-cols-3 gap-2');
    });
    // Angular's [class] binding normalises order, so compare as a set.
    const classes = (fixture.nativeElement as HTMLElement).className.split(/\s+/).sort();
    expect(classes).toEqual(['gap-2', 'grid', 'grid-cols-3']);
  });
});
