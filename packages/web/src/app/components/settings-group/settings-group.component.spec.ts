import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { SettingsGroupComponent } from './settings-group.component';
import { setInputValue } from '../../../testing/signal-input';
import { GROUP_STATE_PREFIX } from '../../lib/group-state';

describe('SettingsGroupComponent', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  function render(
    overrides: {
      groupId?: string;
      defaultOpen?: boolean;
    } = {},
  ): {
    fixture: ReturnType<typeof TestBed.createComponent<SettingsGroupComponent>>;
    el: HTMLElement;
  } {
    TestBed.configureTestingModule({ imports: [SettingsGroupComponent] });
    const fixture = TestBed.createComponent(SettingsGroupComponent);
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

  it('renders a bordered card shell with the groupId as a data attribute', () => {
    const { el } = render({ groupId: 'system-health' });
    const section = el.querySelector('section');
    expect(section).not.toBeNull();
    expect(section?.className).toContain('border');
    expect(section?.getAttribute('data-group-id')).toBe('system-health');
  });

  it('starts collapsed when defaultOpen is false and nothing is stored', () => {
    const { el } = render({ groupId: 'fresh-group-a', defaultOpen: false });
    expect(el.querySelector('[data-testid="settings-group-body"]')).toBeNull();
  });

  it('starts expanded when defaultOpen is true and nothing is stored', () => {
    const { el } = render({ groupId: 'fresh-group-b', defaultOpen: true });
    expect(el.querySelector('[data-testid="settings-group-body"]')).not.toBeNull();
  });

  it('toggles open/closed on chevron click', () => {
    const { fixture, el } = render({ groupId: 'fresh-group-c', defaultOpen: false });
    const toggle = el.querySelector('[data-testid="settings-group-toggle"]') as HTMLButtonElement;
    expect(toggle).not.toBeNull();
    toggle.click();
    fixture.detectChanges();
    expect(el.querySelector('[data-testid="settings-group-body"]')).not.toBeNull();
    toggle.click();
    fixture.detectChanges();
    expect(el.querySelector('[data-testid="settings-group-body"]')).toBeNull();
  });

  it('persists the toggle to localStorage under the new group-state prefix', () => {
    const { el } = render({ groupId: 'persist-test', defaultOpen: false });
    const toggle = el.querySelector('[data-testid="settings-group-toggle"]') as HTMLButtonElement;
    toggle.click();
    expect(localStorage.getItem(`${GROUP_STATE_PREFIX}persist-test`)).toBe('true');
    toggle.click();
    expect(localStorage.getItem(`${GROUP_STATE_PREFIX}persist-test`)).toBe('false');
  });

  it('reads a previously-stored value on a fresh render, overriding defaultOpen', () => {
    localStorage.setItem(`${GROUP_STATE_PREFIX}stored-open`, 'true');
    const { el } = render({ groupId: 'stored-open', defaultOpen: false });
    expect(el.querySelector('[data-testid="settings-group-body"]')).not.toBeNull();
  });

  it('ignores a corrupt stored value and falls back to defaultOpen', () => {
    localStorage.setItem(`${GROUP_STATE_PREFIX}corrupt`, 'not-a-boolean');
    const { el } = render({ groupId: 'corrupt', defaultOpen: true });
    expect(el.querySelector('[data-testid="settings-group-body"]')).not.toBeNull();
  });

  describe('opened output', () => {
    it('emits once when defaultOpen is true and nothing is stored (restored-open on init)', () => {
      TestBed.configureTestingModule({ imports: [SettingsGroupComponent] });
      const fixture = TestBed.createComponent(SettingsGroupComponent);
      const spy = vi.fn();
      fixture.componentInstance.opened.subscribe(spy);
      setInputValue(fixture.componentInstance.icon, 'wrench');
      setInputValue(fixture.componentInstance.title, 'x');
      setInputValue(fixture.componentInstance.description, 'y');
      setInputValue(fixture.componentInstance.groupId, 'opened-default-true');
      setInputValue(fixture.componentInstance.defaultOpen, true);
      fixture.detectChanges();
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('emits once when a stored value restores the group open, overriding a false default', () => {
      localStorage.setItem(`${GROUP_STATE_PREFIX}opened-restored`, 'true');
      TestBed.configureTestingModule({ imports: [SettingsGroupComponent] });
      const fixture = TestBed.createComponent(SettingsGroupComponent);
      const spy = vi.fn();
      fixture.componentInstance.opened.subscribe(spy);
      setInputValue(fixture.componentInstance.icon, 'wrench');
      setInputValue(fixture.componentInstance.title, 'x');
      setInputValue(fixture.componentInstance.description, 'y');
      setInputValue(fixture.componentInstance.groupId, 'opened-restored');
      setInputValue(fixture.componentInstance.defaultOpen, false);
      fixture.detectChanges();
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('does not emit on init when the group starts collapsed', () => {
      const { fixture } = render({ groupId: 'opened-collapsed', defaultOpen: false });
      const spy = vi.fn();
      fixture.componentInstance.opened.subscribe(spy);
      fixture.detectChanges();
      expect(spy).not.toHaveBeenCalled();
    });

    it('emits when toggled open, and again exactly once per re-open (no double-fire)', () => {
      const { fixture, el } = render({ groupId: 'opened-toggle', defaultOpen: false });
      const spy = vi.fn();
      fixture.componentInstance.opened.subscribe(spy);
      const toggle = el.querySelector('[data-testid="settings-group-toggle"]') as HTMLButtonElement;
      toggle.click();
      fixture.detectChanges();
      expect(spy).toHaveBeenCalledTimes(1);
      // closing then reopening emits again (each open transition is a distinct event)
      toggle.click();
      fixture.detectChanges();
      toggle.click();
      fixture.detectChanges();
      expect(spy).toHaveBeenCalledTimes(2);
    });
  });
});
