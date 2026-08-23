import { describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import BASE_CATALOG from '../../../../../public/i18n/en.json';
import { UserManagementPanelComponent } from './user-management-panel.component';
import { AuthService } from '../../../services/auth.service';
import { ConfirmService } from '../../../services/confirm.service';
import { SystemApiService } from '../../../services/api/system-api.service';
import type { AdminUser } from '../../../services/api/api-types';
import { ROLES } from '../../../../types/core';
import { expandAllGroups } from '../../../../testing/expand-groups';

/**
 * Moved out of `admin.component.spec.ts` with the section itself. Mounting the
 * whole Admin page to test this table meant standing up mocks for streaming,
 * processing, acquisition, fragments and downloads purely so the sibling
 * sections would not throw; the panel needs three providers.
 */
describe('UserManagementPanelComponent', () => {
  const testUser: AdminUser = {
    id: 'u1',
    username: 'alice',
    role: 'user',
    status: 'active',
    created_at: '2024-01-02 03:04:05',
    last_seen_at: null,
    isConnected: false,
    amountOfDevices: 0,
    amountOfSessions: 0,
  };

  async function mountWithUsers(
    users: AdminUser[] = [testUser],
    over: {
      token?: string | null;
      confirm?: boolean;
      updateUserRole?: unknown;
      deleteUser?: unknown;
    } = {},
  ) {
    TestBed.resetTestingModule();
    const updateUserRole = over.updateUserRole ?? vi.fn(() => of({ ok: true }));
    const deleteUser = over.deleteUser ?? vi.fn(() => of({ ok: true }));
    const ask = vi.fn(async () => over.confirm ?? true);
    await TestBed.configureTestingModule({
      imports: [UserManagementPanelComponent],
      providers: [
        {
          provide: SystemApiService,
          useValue: {
            getUsers: vi.fn(() => of(users)),
            updateUserRole,
            deleteUser,
            updateUserStatus: vi.fn(() => of({ ok: true })),
          },
        },
        { provide: AuthService, useValue: { token: () => over.token ?? null } },
        { provide: ConfirmService, useValue: { ask } },
      ],
    }).compileComponents();

    const fixture = TestBed.createComponent(UserManagementPanelComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expandAllGroups(fixture);
    return { fixture, el: fixture.nativeElement as HTMLElement, updateUserRole, deleteUser, ask };
  }

  /** A JWT whose only job is to carry `sub` — the component base64-decodes it.
   *  Supplying one also switches on the processing SSE stream, which jsdom has
   *  no EventSource for, so stub it alongside. */
  function tokenFor(sub: string): string {
    (globalThis as { EventSource?: unknown }).EventSource = class {
      close() {}
      addEventListener() {}
    };
    return `h.${btoa(JSON.stringify({ sub }))}.s`;
  }

  it('is five columns with nothing hidden on narrow viewports', async () => {
    const { fixture, el } = await mountWithUsers();
    const table = el.querySelector('[data-testid="users-table"]')!;

    expect(table.querySelectorAll('thead th')).toHaveLength(5);
    // The four `hidden sm:table-cell` columns are gone, not merely restyled:
    // Online/Devices/Sessions folded into Activity, Joined under the username.
    expect(table.querySelectorAll('.hidden')).toHaveLength(0);
    // The old duplicate role control is gone with them.
    expect(el.querySelector('[data-testid="user-role-select"]')).toBeNull();
    fixture.destroy();
  });

  it('puts the role control in the Role column and the rest behind one menu', async () => {
    const { fixture, el } = await mountWithUsers();
    const cells = Array.from(
      el.querySelectorAll('[data-testid="users-table"] tbody tr:first-child td'),
    );

    // Role was rendered twice before: a badge here and a <select> in Actions.
    expect(el.querySelector('[data-testid="user-role-trigger"]')!.closest('td')).toBe(cells[1]);
    expect(el.querySelector('[data-testid="user-actions-toggle"]')!.closest('td')).toBe(
      cells.at(-1),
    );
    fixture.destroy();
  });

  it('offers every role in the picker and persists the pick', async () => {
    const { fixture, el, updateUserRole } = await mountWithUsers();

    (el.querySelector('[data-testid="user-role-trigger"]') as HTMLElement).click();
    fixture.detectChanges();

    expect(el.querySelectorAll('[data-testid^="user-role-option-"]')).toHaveLength(ROLES.length);
    (el.querySelector('[data-testid="user-role-option-listener"]') as HTMLElement).click();
    fixture.detectChanges();

    expect(updateUserRole).toHaveBeenCalledWith('u1', 'listener');
    fixture.destroy();
  });

  it('holds status / reset / delete in the ⋯ menu', async () => {
    const { fixture, el } = await mountWithUsers();

    (el.querySelector('[data-testid="user-actions-toggle"]') as HTMLElement).click();
    fixture.detectChanges();

    expect(el.querySelector('[data-testid="user-action-status"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="user-action-reset-pw"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="user-action-delete"]')).not.toBeNull();
    fixture.destroy();
  });

  it('renders your own row as a plain badge you cannot act on', async () => {
    const { fixture, el } = await mountWithUsers([testUser], { token: tokenFor('u1') });

    // No control at all, rather than a disabled one you can still tab into.
    expect(el.querySelector('[data-testid="user-role-static"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="user-role-trigger"]')).toBeNull();

    (el.querySelector('[data-testid="user-actions-toggle"]') as HTMLElement).click();
    fixture.detectChanges();
    expect(
      (el.querySelector('[data-testid="user-action-status"]') as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (el.querySelector('[data-testid="user-action-delete"]') as HTMLButtonElement).disabled,
    ).toBe(true);
    fixture.destroy();
  });

  it('deletes through the global confirm host, and not at all when declined', async () => {
    for (const confirmed of [true, false]) {
      const { fixture, el, deleteUser, ask } = await mountWithUsers([testUser], {
        confirm: confirmed,
      });
      (el.querySelector('[data-testid="user-actions-toggle"]') as HTMLElement).click();
      fixture.detectChanges();
      (el.querySelector('[data-testid="user-action-delete"]') as HTMLElement).click();
      await fixture.whenStable();

      expect(ask).toHaveBeenCalled();
      if (confirmed) {
        expect(deleteUser).toHaveBeenCalledWith('u1');
        expect(fixture.componentInstance.users()).toHaveLength(0);
      } else {
        expect(deleteUser).not.toHaveBeenCalled();
      }
      fixture.destroy();
    }
  });

  it('shows a relative last-connection, or Never, instead of three presence columns', async () => {
    const { fixture, el } = await mountWithUsers([
      { ...testUser, last_seen_at: null },
      {
        ...testUser,
        id: 'u2',
        username: 'bob',
        isConnected: true,
        amountOfDevices: 2,
        amountOfSessions: 3,
      },
    ]);
    const rows = Array.from(el.querySelectorAll('[data-testid="users-table"] tbody tr'));
    const activityOf = (i: number) =>
      rows[i]!.querySelector('[data-testid="user-activity"]')!.textContent!.trim();

    // The harness ships no catalog, so TranslateService echoes the key —
    // assert the key, which is the precise thing anyway.
    expect(activityOf(0)).toContain('admin.neverConnected');
    // Devices/sessions survived the column removal as the muted second line.
    expect(activityOf(1)).toContain('admin.online');
    expect(activityOf(1)).toContain('admin.activityDetail');
    fixture.destroy();
  });

  it('is one vertical D-pad group, off the table element itself', async () => {
    const { fixture, el } = await mountWithUsers([
      testUser,
      { ...testUser, id: 'u2', username: 'bob' },
    ]);
    const group = el.querySelector('[data-testid="users-table"]')!;

    // TvNavGroupDirective force-sets role="toolbar", which would clobber the
    // table's implicit ARIA roles — hence a wrapper div, not the <table>.
    expect(group.tagName).toBe('DIV');
    const triggers: HTMLElement[] = Array.from(
      group.querySelectorAll(
        '[data-testid="user-role-trigger"], [data-testid="user-actions-toggle"]',
      ),
    );
    expect(triggers.length).toBeGreaterThan(1);
    expect(triggers[0]!.closest('[appTvNavGroup]')).toBe(group);

    triggers[0]!.focus();
    triggers[0]!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
    );
    expect(document.activeElement).toBe(triggers[1]);
    fixture.destroy();
  });

  it('ships every new i18n key it renders', async () => {
    for (const key of [
      'admin.colActivity',
      'admin.joinedOn',
      'admin.neverConnected',
      'admin.activityDetail',
      'admin.userActions',
      'admin.deleteUserConfirm',
      'admin.role.listener',
      'admin.status.active',
      'time.justNow',
      'time.daysAgo',
    ]) {
      expect(BASE_CATALOG).toHaveProperty([key]);
    }
    // The columns they replaced are retired, not left to rot.
    for (const key of [
      'admin.colOnline',
      'admin.colDevices',
      'admin.colSessions',
      'admin.colJoined',
    ]) {
      expect(BASE_CATALOG).not.toHaveProperty([key]);
    }
  });
});
