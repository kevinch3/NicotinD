import { TestBed } from '@angular/core/testing';
import { SearchFieldComponent } from './search-field.component';
import { setInputValue } from '../../../testing/signal-input';

function setup(seed: { value?: string; hint?: string } = {}) {
  TestBed.configureTestingModule({ imports: [SearchFieldComponent] });
  const fixture = TestBed.createComponent(SearchFieldComponent);
  const cmp = fixture.componentInstance;
  setInputValue(cmp.value, seed.value ?? '');
  setInputValue(cmp.placeholder, 'library.search.songsPlaceholder');
  setInputValue(cmp.label, 'library.search.songsLabel');
  setInputValue(cmp.testId, 'library-songs-search');
  setInputValue(cmp.hint, seed.hint ?? '');
  setInputValue(cmp.hintTestId, 'library-album-count');
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const input = el.querySelector<HTMLInputElement>('[data-testid="library-songs-search"]')!;
  return { fixture, cmp, el, input };
}

describe('SearchFieldComponent', () => {
  it('takes the row width the icon controls leave, never a fixed minimum', () => {
    const { fixture, input } = setup();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.classList).toContain('flex-1');
    expect(host.classList).toContain('min-w-0');
    expect(input.className).not.toMatch(/min-w-\[/);
  });

  it('is a named search input with a translated placeholder', () => {
    const { input } = setup({ value: 'tangana' });
    expect(input.type).toBe('search');
    expect(input.getAttribute('aria-label')).toBe('library.search.songsLabel');
    expect(input.placeholder).toBe('library.search.songsPlaceholder');
    expect(input.value).toBe('tangana');
  });

  it('emits every keystroke', () => {
    const { cmp, input } = setup();
    const typed: string[] = [];
    cmp.valueChange.subscribe((v) => typed.push(v));
    input.value = 'ta';
    input.dispatchEvent(new Event('input'));
    expect(typed).toEqual(['ta']);
  });

  it('shows a trailing hint inside the field only when there is one', () => {
    expect(setup().el.querySelector('[data-testid="library-album-count"]')).toBeNull();
    TestBed.resetTestingModule();
    const { el } = setup({ hint: '3 albums' });
    const hint = el.querySelector('[data-testid="library-album-count"]');
    expect(hint?.textContent?.trim()).toBe('3 albums');
    // Inside the field's label, so the row never needs a second line for it.
    expect(hint?.closest('label')).not.toBeNull();
  });
});
