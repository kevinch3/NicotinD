import { TestBed } from '@angular/core/testing';
import { setInputValue } from '../../../testing/signal-input';
import { IconTabsComponent, type IconTabItem, type IconTabsVariant } from './icon-tabs.component';

const ITEMS: IconTabItem[] = [
  { value: 'songs', icon: 'music', label: 'library.tab.songs' },
  { value: 'albums', icon: 'disc-album', label: 'library.tab.albums', testid: 'tab-albums' },
  { value: 'stats', icon: 'chart', label: 'library.tab.stats', badge: 3 },
];

function make(
  opts: {
    active?: string;
    variant?: IconTabsVariant;
    items?: IconTabItem[];
    label?: string;
  } = {},
) {
  const fixture = TestBed.createComponent(IconTabsComponent);
  const c = fixture.componentInstance;
  setInputValue(c.items, opts.items ?? ITEMS);
  setInputValue(c.active, opts.active ?? 'songs');
  setInputValue(c.variant, opts.variant ?? 'nav');
  setInputValue(c.testid, 'bar');
  if (opts.label) setInputValue(c.label, opts.label);
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const bar = el.querySelector<HTMLElement>('[data-testid="bar"]')!;
  const buttons = Array.from(bar.querySelectorAll<HTMLButtonElement>('button'));
  const label = (b: HTMLElement) => b.querySelector<HTMLElement>('[data-testid="icon-tab-label"]')!;
  return { fixture, bar, buttons, label };
}

describe('IconTabsComponent (#1668)', () => {
  it('shows an icon on every tab and a label only on the active one', () => {
    const { buttons, label } = make({ active: 'albums' });
    expect(buttons.map((b) => b.dataset['mode'])).toEqual(['songs', 'albums', 'stats']);
    for (const b of buttons) {
      const active = b.dataset['mode'] === 'albums';
      expect(b.querySelector('app-icon')).not.toBeNull();
      expect(label(b).classList.contains('sr-only')).toBe(!active);
      expect(label(b).classList.contains('truncate')).toBe(active);
    }
  });

  it('keeps every name accessible: the label text stays in the DOM and every tab has a title', () => {
    const { buttons, label } = make();
    for (const [i, b] of buttons.entries()) {
      expect(label(b).textContent?.trim()).toBe(ITEMS[i]!.label);
      expect(b.getAttribute('title')).toBe(ITEMS[i]!.label);
    }
  });

  it('lets inactive tabs share the row and the active one take the room its label needs', () => {
    const { bar, buttons } = make();
    const [songs, albums] = buttons;
    expect(albums!.classList).toContain('flex-1');
    expect(albums!.classList).toContain('min-w-8');
    expect(songs!.classList).toContain('flex-initial');
    expect(songs!.classList).toContain('min-w-0');
    expect(bar.classList).not.toContain('overflow-x-auto');
  });

  it('fills the row on a phone by default, and stays as wide as its tabs when told not to', () => {
    expect(make().bar.classList).toContain('w-full');
    const fixture = TestBed.createComponent(IconTabsComponent);
    setInputValue(fixture.componentInstance.items, ITEMS);
    setInputValue(fixture.componentInstance.active, 'songs');
    setInputValue(fixture.componentInstance.testid, 'bar');
    setInputValue(fixture.componentInstance.fill, false);
    fixture.detectChanges();
    const bar = (fixture.nativeElement as HTMLElement).querySelector('[data-testid="bar"]')!;
    expect(bar.classList).toContain('w-fit');
    expect(bar.classList).not.toContain('w-full');
  });

  it("extends each tab's hit area over the bar's padding, to 44px tall (#1668)", () => {
    // h-9 is 36px; the pseudo-element adds the bar's 4px of padding above and below.
    for (const b of make().buttons) {
      expect(b.classList).toContain('h-9');
      expect(b.classList).toContain('relative');
      expect(b.classList).toContain('after:absolute');
      expect(b.classList).toContain('after:-inset-y-1');
    }
  });

  it('emits the value of the tab that was pressed', () => {
    const { fixture, buttons } = make();
    const seen: string[] = [];
    fixture.componentInstance.selected.subscribe((v) => seen.push(v));
    buttons[2]!.click();
    buttons[0]!.click();
    expect(seen).toEqual(['stats', 'songs']);
  });

  it('carries a per-tab testid and a per-bar label testid', () => {
    const fixture = TestBed.createComponent(IconTabsComponent);
    setInputValue(fixture.componentInstance.items, ITEMS);
    setInputValue(fixture.componentInstance.active, 'songs');
    setInputValue(fixture.componentInstance.labelTestid, 'library-tab-label');
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="tab-albums"]')?.getAttribute('data-mode')).toBe(
      'albums',
    );
    expect(el.querySelectorAll('[data-testid="library-tab-label"]')).toHaveLength(3);
  });

  describe('roles per variant', () => {
    it('nav: a toolbar of plain buttons with aria-current on the active one', () => {
      const { bar, buttons } = make({ variant: 'nav' });
      expect(bar.getAttribute('role')).toBe('toolbar');
      expect(buttons.map((b) => b.getAttribute('role'))).toEqual([null, null, null]);
      expect(buttons.map((b) => b.getAttribute('aria-current'))).toEqual(['true', null, null]);
      expect(buttons.every((b) => !b.hasAttribute('aria-selected'))).toBe(true);
    });

    it('tabs: tablist / tab / aria-selected, and a name for the list', () => {
      const { bar, buttons } = make({ variant: 'tabs', label: 'artist.tabs' });
      expect(bar.getAttribute('role')).toBe('tablist');
      expect(bar.getAttribute('aria-label')).toBe('artist.tabs');
      expect(buttons.map((b) => b.getAttribute('role'))).toEqual(['tab', 'tab', 'tab']);
      expect(buttons.map((b) => b.getAttribute('aria-selected'))).toEqual([
        'true',
        'false',
        'false',
      ]);
      expect(buttons.every((b) => !b.hasAttribute('aria-current'))).toBe(true);
    });

    it('radio: radiogroup / radio / aria-checked', () => {
      const { bar, buttons } = make({ variant: 'radio', active: 'stats' });
      expect(bar.getAttribute('role')).toBe('radiogroup');
      expect(buttons.map((b) => b.getAttribute('role'))).toEqual(['radio', 'radio', 'radio']);
      expect(buttons.map((b) => b.getAttribute('aria-checked'))).toEqual([
        'false',
        'false',
        'true',
      ]);
    });
  });

  it('says aria-current="page" when each tab is a URL', () => {
    const fixture = TestBed.createComponent(IconTabsComponent);
    setInputValue(fixture.componentInstance.items, ITEMS);
    setInputValue(fixture.componentInstance.active, 'albums');
    setInputValue(fixture.componentInstance.current, 'page');
    fixture.detectChanges();
    const current = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('button'),
    ).map((b) => b.getAttribute('aria-current'));
    expect(current).toEqual([null, 'page', null]);
  });

  it('lets a tab name its badge for a spec that reads the count', () => {
    const items: IconTabItem[] = [
      { value: 'a', icon: 'add', label: 'a' },
      { value: 'b', icon: 'download', label: 'b', badge: 4, badgeTestid: 'b-count' },
    ];
    for (const active of ['a', 'b']) {
      const fixture = TestBed.createComponent(IconTabsComponent);
      setInputValue(fixture.componentInstance.items, items);
      setInputValue(fixture.componentInstance.active, active);
      fixture.detectChanges();
      const el = fixture.nativeElement as HTMLElement;
      expect(el.querySelector('[data-testid="b-count"]')?.textContent?.trim()).toBe('4');
      expect(el.querySelector('[data-testid="icon-tab-badge"]')).toBeNull();
    }
  });

  describe('badges', () => {
    const badge = (b: HTMLElement) =>
      b.querySelector<HTMLElement>('[data-testid="icon-tab-badge"]');

    it('rides the icon on an inactive tab, where the label is hidden', () => {
      const stats = make({ active: 'songs' }).buttons[2]!;
      expect(badge(stats)?.textContent?.trim()).toBe('3');
      expect(badge(stats)!.classList).toContain('absolute');
      expect(badge(stats)!.parentElement!.querySelector('app-icon')).not.toBeNull();
    });

    it('sits inline after the label on the active tab', () => {
      const stats = make({ active: 'stats' }).buttons[2]!;
      expect(stats.querySelectorAll('[data-testid="icon-tab-badge"]')).toHaveLength(1);
      expect(badge(stats)!.classList).not.toContain('absolute');
      expect(badge(stats)!.previousElementSibling?.getAttribute('data-testid')).toBe(
        'icon-tab-label',
      );
    });

    it('draws a dot as a small circle with no text, not as an empty pill', () => {
      const items: IconTabItem[] = [
        { value: 'a', icon: 'music', label: 'a' },
        { value: 'd', icon: 'music', label: 'd', badge: '' },
      ];
      const dot = badge(make({ items, active: 'a' }).buttons[1]!)!;
      expect(dot.textContent?.trim()).toBe('');
      expect(dot.classList).toContain('w-2');
      expect(dot.classList).not.toContain('min-w-3.5');
    });

    it('is absent for no badge, null and zero, and present for a dot', () => {
      const items: IconTabItem[] = [
        { value: 'a', icon: 'music', label: 'a' },
        { value: 'b', icon: 'music', label: 'b', badge: null },
        { value: 'c', icon: 'music', label: 'c', badge: 0 },
        { value: 'd', icon: 'music', label: 'd', badge: '' },
      ];
      const { buttons } = make({ items, active: 'a' });
      expect(buttons.map((b) => badge(b) !== null)).toEqual([false, false, false, true]);
    });
  });
});
