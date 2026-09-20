import { TestBed } from '@angular/core/testing';
import { CaseCardComponent } from './case-card.component';
import { setInputValue } from '../../../testing/signal-input';
import type { CurationCase } from '../../services/api/api-types';

const aCase = (over: Partial<CurationCase> = {}): CurationCase => ({
  id: 'flag:19',
  kind: 'identity',
  target: { kind: 'song', id: 's1', title: 'Chase the Cool', subtitle: 'Rocky' },
  question: 'Which Rocky is this?',
  details: 'Long research: identify_song said 0.98, Lille electro-pop, see flag #24.',
  evidence: [{ label: 'Origin', value: 'France' }],
  options: [
    { id: 'french', label: 'The French band', rationale: 'Lille electro-pop' },
    { id: 'resolve', label: 'Leave as is', rationale: 'No change' },
  ],
  confidence: 1,
  source: 'flag',
  ...over,
});

// componentRef.setInput() is a silent no-op on this JIT harness — see
// testing/signal-input.ts. setInputValue writes the signal node directly and
// must run before the fixture's first detectChanges().
function render(kase: CurationCase | null, busy = false) {
  TestBed.configureTestingModule({ imports: [CaseCardComponent] });
  const fixture = TestBed.createComponent(CaseCardComponent);
  setInputValue(fixture.componentInstance.case, kase);
  setInputValue(fixture.componentInstance.busy, busy);
  fixture.detectChanges();
  return fixture;
}

const el = (f: ReturnType<typeof render>) => f.nativeElement as HTMLElement;
const options = (f: ReturnType<typeof render>) =>
  el(f).querySelectorAll<HTMLButtonElement>('[data-testid="case-option"]');

describe('CaseCardComponent', () => {
  it('renders the question and the target title', () => {
    const f = render(aCase());
    const text = el(f).textContent ?? '';
    expect(text).toContain('Which Rocky is this?');
    expect(text).toContain('Chase the Cool');
  });

  it('renders one button per option, with its rationale', () => {
    const f = render(aCase());
    expect(options(f).length).toBe(2);
    expect(el(f).textContent).toContain('Lille electro-pop');
  });

  it('emits the option id when one is chosen', () => {
    const f = render(aCase());
    let chosen: string | null = null;
    f.componentInstance.choose.subscribe((id: string) => (chosen = id));
    options(f)[0].click();
    expect(chosen).toBe('french');
  });

  // The card is read on a phone between two songs: the research is there for
  // the reviewer who wants it, folded, never in the way of the choice.
  it('folds the details and the evidence behind a closed disclosure', () => {
    const f = render(aCase());
    const details = el(f).querySelector<HTMLDetailsElement>('[data-testid="case-details"]');
    expect(details).not.toBeNull();
    expect(details!.open).toBe(false);
    expect(details!.textContent).toContain('Long research');
    expect(details!.textContent).toContain('France');
    // Nothing of the research sits outside the disclosure.
    const question = el(f).querySelector('[data-testid="case-question"]');
    expect(question?.textContent).not.toContain('Long research');
  });

  it('omits the disclosure entirely when there is nothing to fold', () => {
    const f = render(aCase({ details: null, evidence: [] }));
    expect(el(f).querySelector('[data-testid="case-details"]')).toBeNull();
  });

  // The server-appended "change nothing" choice is copy the web owns, so it
  // reads in the viewer's language and is visibly the secondary choice.
  it('renders the fallback option through i18n and marks it as the fallback', () => {
    const f = render(aCase());
    const fallback = options(f)[1];
    expect(fallback.getAttribute('data-fallback')).toBe('true');
    expect(fallback.textContent).toContain('curate.leaveAsIs');
    expect(fallback.textContent).not.toContain('No change');
    expect(options(f)[0].getAttribute('data-fallback')).toBeNull();
  });

  it('disables the options while a choice is being applied', () => {
    const f = render(aCase(), true);
    expect(options(f)[0].disabled).toBe(true);
  });

  it('marks a destructive option so it cannot be mistaken for a safe one', () => {
    const f = render(
      aCase({
        options: [{ id: 'del', label: 'Delete', rationale: 'redundant', destructive: true }],
      }),
    );
    expect(options(f)[0].getAttribute('data-destructive')).toBe('true');
  });

  it('gives a destructive option a visibly distinct treatment, unlike a safe one', () => {
    const f = render(
      aCase({
        options: [
          { id: 'del', label: 'Delete', rationale: 'redundant', destructive: true },
          { id: 'keep', label: 'Keep', rationale: 'fine as-is' },
        ],
      }),
    );
    expect(options(f)[0].classList.contains('text-red-400')).toBe(true);
    expect(options(f)[1].classList.contains('text-red-400')).toBe(false);
  });

  // A delete fires on the second tap, never the first: the option turns into
  // a confirm row, and cancelling puts the option back with nothing emitted.
  it('asks a destructive option to be confirmed before emitting, and can be cancelled', () => {
    const f = render(
      aCase({
        options: [
          { id: 'del', label: 'Delete this copy', rationale: 'redundant', destructive: true },
          { id: 'keep', label: 'Keep', rationale: 'fine as-is' },
        ],
      }),
    );
    const chosen: string[] = [];
    f.componentInstance.choose.subscribe((id: string) => chosen.push(id));

    options(f)[0].click();
    f.detectChanges();
    expect(chosen).toEqual([]);
    const confirm = el(f).querySelector('[data-testid="case-confirm"]');
    expect(confirm).not.toBeNull();
    expect(confirm!.textContent).toContain('curate.confirmDestructive');
    // The safe option is still there; only the destructive one changed shape.
    expect(options(f).length).toBe(1);

    el(f).querySelector<HTMLButtonElement>('[data-testid="case-confirm-no"]')!.click();
    f.detectChanges();
    expect(chosen).toEqual([]);
    expect(el(f).querySelector('[data-testid="case-confirm"]')).toBeNull();
    expect(options(f).length).toBe(2);

    options(f)[0].click();
    f.detectChanges();
    el(f).querySelector<HTMLButtonElement>('[data-testid="case-confirm-yes"]')!.click();
    expect(chosen).toEqual(['del']);
  });

  it('emits a safe option on the first tap with no confirm step', () => {
    const f = render(aCase());
    const chosen: string[] = [];
    f.componentInstance.choose.subscribe((id: string) => chosen.push(id));
    options(f)[0].click();
    expect(chosen).toEqual(['french']);
    expect(el(f).querySelector('[data-testid="case-confirm"]')).toBeNull();
  });

  // The eyebrow used to print the raw union member (`identity`, `placement`).
  // It goes through the catalog now; with no catalog loaded the pipe returns
  // the key, which is exactly what proves it is translated copy.
  it('renders the kind through an i18n key, not the raw union member', () => {
    const f = render(aCase({ kind: 'placement' }));
    expect(el(f).textContent).toContain('curate.kind.placement');
  });

  it('renders nothing when there is no case', () => {
    const f = render(null);
    expect(el(f).querySelector('[data-testid="case-card"]')).toBeNull();
  });
});
