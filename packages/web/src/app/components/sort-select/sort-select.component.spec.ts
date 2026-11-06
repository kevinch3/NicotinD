import { TestBed } from '@angular/core/testing';
import { SortSelectComponent, toSortChoices, type SortChoice } from './sort-select.component';
import { setInputValue } from '../../../testing/signal-input';

const OPTIONS: SortChoice[] = [
  { value: 'newest', label: 'library.sortBy.recentlyAdded' },
  { value: 'title', label: 'library.sortBy.title' },
  { value: 'album', label: 'library.sortBy.album' },
];

function setup(seed: { value?: string; direction?: 'asc' | 'desc' | null } = {}) {
  TestBed.configureTestingModule({ imports: [SortSelectComponent] });
  const fixture = TestBed.createComponent(SortSelectComponent);
  const cmp = fixture.componentInstance;
  setInputValue(cmp.options, OPTIONS);
  setInputValue(cmp.value, seed.value ?? 'newest');
  setInputValue(cmp.label, 'library.sortLabel.songs');
  setInputValue(cmp.testId, 'library-songs-sort');
  setInputValue(cmp.direction, seed.direction ?? null);
  setInputValue(cmp.directionTestId, 'library-songs-sort-direction');
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const select = el.querySelector<HTMLSelectElement>('[data-testid="library-songs-sort"]')!;
  return { fixture, cmp, el, select };
}

describe('SortSelectComponent', () => {
  it('is a native select over the sort icon, named by its label', () => {
    const { el, select } = setup();
    expect(select.tagName).toBe('SELECT');
    // Invisible but present and full-size: the native picker still opens on tap.
    expect(select.classList).toContain('opacity-0');
    expect(select.classList).toContain('inset-0');
    expect(select.getAttribute('aria-label')).toBe('library.sortLabel.songs');
    expect(select.closest('span')?.querySelector('app-icon')?.getAttribute('name')).toBe('sort');
    expect(el.querySelectorAll('option')).toHaveLength(3);
  });

  it('selects the current value and names it in the tooltip', () => {
    const { select } = setup({ value: 'title' });
    expect(select.value).toBe('title');
    expect(select.getAttribute('title')).toBe('library.sortLabel.songs: library.sortBy.title');
  });

  it('emits the picked value, so the icon still drives the sort', () => {
    const { cmp, select } = setup();
    const picked: string[] = [];
    cmp.valueChange.subscribe((v) => picked.push(v));
    select.value = 'album';
    select.dispatchEvent(new Event('change'));
    expect(picked).toEqual(['album']);
  });

  it('renders no direction toggle for a server-ordered list', () => {
    const { el } = setup({ direction: null });
    expect(el.querySelector('[data-testid="library-songs-sort-direction"]')).toBeNull();
  });

  it('offers a named direction toggle that points down when descending', () => {
    const { cmp, el } = setup({ direction: 'desc' });
    const btn = el.querySelector<HTMLButtonElement>(
      '[data-testid="library-songs-sort-direction"]',
    )!;
    expect(btn.getAttribute('aria-label')).toBe('library.sortDirection.desc');
    expect(btn.querySelector('app-icon')?.classList).toContain('rotate-180');
    let toggled = 0;
    cmp.directionToggle.subscribe(() => toggled++);
    btn.click();
    expect(toggled).toBe(1);
  });
});

describe('toSortChoices', () => {
  it('maps a ListControls sort field onto the control value', () => {
    expect(toSortChoices([{ field: 'name', label: 'library.sortBy.name' }])).toEqual([
      { value: 'name', label: 'library.sortBy.name' },
    ]);
  });
});
