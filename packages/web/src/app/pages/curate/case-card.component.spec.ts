import { TestBed } from '@angular/core/testing';
import { CaseCardComponent } from './case-card.component';
import { setInputValue } from '../../../testing/signal-input';
import type { CurationCase } from '../../services/api/api-types';

const aCase = (over: Partial<CurationCase> = {}): CurationCase => ({
  id: 'flag:19',
  kind: 'identity',
  target: { kind: 'song', id: 's1', title: 'Chase the Cool', subtitle: 'Rocky' },
  question: 'Which Rocky is this?',
  evidence: [{ label: 'Origin', value: 'France' }],
  options: [
    { id: 'french', label: 'The French band', rationale: 'Lille electro-pop' },
    { id: 'resolve', label: 'Mark handled', rationale: 'No change' },
  ],
  confidence: 1,
  source: 'flag',
  ...over,
});

// componentRef.setInput() is a silent no-op on this JIT harness — see
// testing/signal-input.ts. setInputValue writes the signal node directly and
// must run before the fixture's first detectChanges().
function render(kase: CurationCase, busy = false) {
  TestBed.configureTestingModule({ imports: [CaseCardComponent] });
  const fixture = TestBed.createComponent(CaseCardComponent);
  setInputValue(fixture.componentInstance.case, kase);
  setInputValue(fixture.componentInstance.busy, busy);
  fixture.detectChanges();
  return fixture;
}

describe('CaseCardComponent', () => {
  it('renders the question and the target title', () => {
    const f = render(aCase());
    const text = (f.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Which Rocky is this?');
    expect(text).toContain('Chase the Cool');
  });

  it('renders one button per option, with its rationale', () => {
    const f = render(aCase());
    const buttons = (f.nativeElement as HTMLElement).querySelectorAll(
      '[data-testid="case-option"]',
    );
    expect(buttons.length).toBe(2);
    expect((f.nativeElement as HTMLElement).textContent).toContain('Lille electro-pop');
  });

  it('emits the option id when one is chosen', () => {
    const f = render(aCase());
    let chosen: string | null = null;
    f.componentInstance.choose.subscribe((id: string) => (chosen = id));
    const first = (f.nativeElement as HTMLElement).querySelector(
      '[data-testid="case-option"]',
    ) as HTMLButtonElement;
    first.click();
    expect(chosen).toBe('french');
  });

  it('renders every evidence row', () => {
    const f = render(aCase());
    expect((f.nativeElement as HTMLElement).textContent).toContain('France');
  });

  it('disables the options while a choice is being applied', () => {
    const f = render(aCase(), true);
    const first = (f.nativeElement as HTMLElement).querySelector(
      '[data-testid="case-option"]',
    ) as HTMLButtonElement;
    expect(first.disabled).toBe(true);
  });

  it('marks a destructive option so it cannot be mistaken for a safe one', () => {
    const f = render(
      aCase({
        options: [{ id: 'del', label: 'Delete', rationale: 'redundant', destructive: true }],
      }),
    );
    const btn = (f.nativeElement as HTMLElement).querySelector(
      '[data-testid="case-option"]',
    ) as HTMLButtonElement;
    expect(btn.getAttribute('data-destructive')).toBe('true');
  });
});
