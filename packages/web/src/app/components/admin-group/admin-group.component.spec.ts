import { TestBed } from '@angular/core/testing';
import { AdminGroupComponent } from './admin-group.component';
import { setInputValue } from '../../../testing/signal-input';

const KEY_PREFIX = 'nicotind-admin-group-';

describe('AdminGroupComponent', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  function render(
    overrides: {
      groupId?: string;
      defaultOpen?: boolean;
    } = {},
  ): { fixture: ReturnType<typeof TestBed.createComponent<AdminGroupComponent>>; el: HTMLElement } {
    TestBed.configureTestingModule({ imports: [AdminGroupComponent] });
    const fixture = TestBed.createComponent(AdminGroupComponent);
    setInputValue(fixture.componentInstance.icon, 'wrench');
    setInputValue(fixture.componentInstance.title, 'Library Maintenance');
    setInputValue(
      fixture.componentInstance.description,
      'Find duplicates, orphan rows, and diagnostics',
    );
    setInputValue(fixture.componentInstance.groupId, overrides.groupId ?? 'library-maintenance');
    setInputValue(fixture.componentInstance.defaultOpen, overrides.defaultOpen ?? false);
    fixture.detectChanges();
    return { fixture, el: fixture.nativeElement as HTMLElement };
  }

  it('renders the header via app-settings-group-header', () => {
    const { el } = render();
    expect(el.querySelector('app-settings-group-header')).not.toBeNull();
  });

  it('starts collapsed when defaultOpen is false and nothing is stored', () => {
    const { el } = render({ groupId: 'fresh-group-a', defaultOpen: false });
    expect(el.querySelector('[data-testid="admin-group-body"]')).toBeNull();
  });

  it('starts expanded when defaultOpen is true and nothing is stored', () => {
    const { el } = render({ groupId: 'fresh-group-b', defaultOpen: true });
    expect(el.querySelector('[data-testid="admin-group-body"]')).not.toBeNull();
  });

  it('toggles open/closed on chevron click', () => {
    const { fixture, el } = render({ groupId: 'fresh-group-c', defaultOpen: false });
    const toggle = el.querySelector('[data-testid="admin-group-toggle"]') as HTMLButtonElement;
    expect(toggle).not.toBeNull();
    toggle.click();
    fixture.detectChanges();
    expect(el.querySelector('[data-testid="admin-group-body"]')).not.toBeNull();
    toggle.click();
    fixture.detectChanges();
    expect(el.querySelector('[data-testid="admin-group-body"]')).toBeNull();
  });

  it('persists the toggle to localStorage under the groupId', () => {
    const { el } = render({ groupId: 'persist-test', defaultOpen: false });
    const toggle = el.querySelector('[data-testid="admin-group-toggle"]') as HTMLButtonElement;
    toggle.click();
    expect(localStorage.getItem(`${KEY_PREFIX}persist-test`)).toBe('true');
    toggle.click();
    expect(localStorage.getItem(`${KEY_PREFIX}persist-test`)).toBe('false');
  });

  it('reads a previously-stored value on a fresh render, overriding defaultOpen', () => {
    localStorage.setItem(`${KEY_PREFIX}stored-open`, 'true');
    const { el } = render({ groupId: 'stored-open', defaultOpen: false });
    expect(el.querySelector('[data-testid="admin-group-body"]')).not.toBeNull();
  });

  it('ignores a corrupt stored value and falls back to defaultOpen', () => {
    localStorage.setItem(`${KEY_PREFIX}corrupt`, 'not-a-boolean');
    const { el } = render({ groupId: 'corrupt', defaultOpen: true });
    expect(el.querySelector('[data-testid="admin-group-body"]')).not.toBeNull();
  });
});
