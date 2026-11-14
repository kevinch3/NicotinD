import { describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { HttpErrorResponse } from '@angular/common/http';
import BASE_CATALOG from '../../../../../public/i18n/en.json';
import { UserManagementPanelComponent } from './user-management-panel.component';
import { AuthService } from '../../../services/auth.service';
import { ConfirmService } from '../../../services/confirm.service';
import { SystemApiService } from '../../../services/api/system-api.service';
import { InvitesApiService } from '../../../services/api/invites-api.service';
import { AccountApiService } from '../../../services/api/account-api.service';
import { MailApiService } from '../../../services/api/mail-api.service';
import { ToastService } from '../../../services/toast.service';
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
      registration?: { enabled: boolean; configurable: boolean };
      setRegistration?: unknown;
      issueResetLink?: unknown;
      emailResetLink?: unknown;
      assignUserEmail?: unknown;
      transport?: 'off' | 'smtp' | 'outbox';
    } = {},
  ) {
    TestBed.resetTestingModule();
    const updateUserRole = over.updateUserRole ?? vi.fn(() => of({ ok: true }));
    const deleteUser = over.deleteUser ?? vi.fn(() => of({ ok: true }));
    const registration = over.registration ?? { enabled: false, configurable: true };
    const setRegistration =
      over.setRegistration ?? vi.fn((enabled: boolean) => of({ ...registration, enabled }));
    const ask = vi.fn(async () => over.confirm ?? true);
    const toast = { show: vi.fn() };
    const emailResetLink =
      over.emailResetLink ?? vi.fn(() => of({ mail: { ok: true }, expiresAt: 1 }));
    const assignUserEmail =
      over.assignUserEmail ??
      vi.fn((_id: string, email: string) =>
        of({
          email: null,
          emailVerified: false,
          pendingEmail: email || null,
          ...(email ? { mail: { ok: true } } : {}),
        }),
      );
    const issueResetLink =
      over.issueResetLink ??
      vi.fn(() => of({ path: '/reset-password#t=rt', urls: ['https://box.ts.net'], expiresAt: 1 }));
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
            getRegistration: vi.fn(() => of(registration)),
            setRegistration,
          },
        },
        {
          provide: AuthService,
          useValue: { token: () => over.token ?? null, mediaToken: () => over.token ?? null },
        },
        { provide: ConfirmService, useValue: { ask } },
        // The embedded invites card has its own spec; here it only must not throw.
        { provide: InvitesApiService, useValue: { list: vi.fn(() => of({ invites: [] })) } },
        {
          provide: AccountApiService,
          useValue: { issueResetLink, emailResetLink, assignUserEmail },
        },
        {
          provide: MailApiService,
          useValue: { get: vi.fn(() => of({ effectiveTransport: over.transport ?? 'off' })) },
        },
        { provide: ToastService, useValue: toast },
      ],
    }).compileComponents();

    const fixture = TestBed.createComponent(UserManagementPanelComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expandAllGroups(fixture);
    return {
      fixture,
      el: fixture.nativeElement as HTMLElement,
      updateUserRole,
      deleteUser,
      ask,
      setRegistration,
      issueResetLink,
      emailResetLink,
      assignUserEmail,
      toast,
      cmp: fixture.componentInstance,
    };
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

  it('shows the email under the username, with whether it is verified', async () => {
    const { fixture, el } = await mountWithUsers([
      { ...testUser, email: 'alice@example.com', emailVerified: true },
      { ...testUser, id: 'u2', username: 'bob', email: 'bob@example.com', emailVerified: false },
      { ...testUser, id: 'u3', username: 'carol', email: null },
    ]);
    const emails = Array.from(el.querySelectorAll('[data-testid="user-email"]'));
    expect(emails.map((e) => e.getAttribute('data-verified'))).toEqual(['true', 'false']);
    expect(emails[0]!.textContent).toContain('alice@example.com');
    expect(emails[0]!.textContent).toContain('admin.emailVerified');
    expect(emails[1]!.textContent).toContain('admin.emailUnverified');
    // Wrapped, never truncated (src/overflow-reveal-policy.spec.ts).
    expect(emails[0]!.className).toContain('break-all');
    expect(BASE_CATALOG['admin.emailVerified']).toBeTruthy();
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

  // Public-signup switch (issue #824). It lives on this card because it answers
  // the same question the users table does: who is allowed to become a user.
  describe('public-signup toggle', () => {
    it('reflects the server value and is operable when the env leaves it unset', async () => {
      const { el } = await mountWithUsers([testUser], {
        registration: { enabled: true, configurable: true },
      });
      const toggle = el.querySelector<HTMLInputElement>('[data-testid="signup-toggle"]')!;

      expect(toggle.checked).toBe(true);
      expect(toggle.disabled).toBe(false);
      expect(el.querySelector('[data-testid="signup-env-locked"]')).toBeNull();
    });

    it('renders read-only with an explanation when the env pins the value', async () => {
      const { el } = await mountWithUsers([testUser], {
        registration: { enabled: false, configurable: false },
      });
      const toggle = el.querySelector<HTMLInputElement>('[data-testid="signup-toggle"]')!;

      expect(toggle.disabled).toBe(true);
      expect(el.querySelector('[data-testid="signup-env-locked"]')).not.toBeNull();
    });

    it('persists a flip through the API', async () => {
      const { el, fixture, setRegistration } = await mountWithUsers([testUser], {
        registration: { enabled: false, configurable: true },
      });
      const toggle = el.querySelector<HTMLInputElement>('[data-testid="signup-toggle"]')!;

      toggle.checked = true;
      toggle.dispatchEvent(new Event('change'));
      await fixture.whenStable();
      fixture.detectChanges();

      expect(setRegistration).toHaveBeenCalledWith(true);
      expect(el.querySelector<HTMLInputElement>('[data-testid="signup-toggle"]')!.checked).toBe(
        true,
      );
    });

    it('adopts the server effective value rather than what was asked', async () => {
      // The server is the authority: a pinned env makes the effective value
      // differ from the request, and the UI must not keep showing the request.
      const { el, fixture } = await mountWithUsers([testUser], {
        registration: { enabled: false, configurable: true },
        setRegistration: vi.fn(() => of({ enabled: false, configurable: false })),
      });
      const toggle = el.querySelector<HTMLInputElement>('[data-testid="signup-toggle"]')!;

      toggle.checked = true;
      toggle.dispatchEvent(new Event('change'));
      await fixture.whenStable();
      fixture.detectChanges();

      expect(el.querySelector<HTMLInputElement>('[data-testid="signup-toggle"]')!.checked).toBe(
        false,
      );
    });

    it('leaves the users table usable when the signup lookup fails', async () => {
      TestBed.resetTestingModule();
      await TestBed.configureTestingModule({
        imports: [UserManagementPanelComponent],
        providers: [
          {
            provide: SystemApiService,
            useValue: {
              getUsers: vi.fn(() => of([testUser])),
              updateUserRole: vi.fn(() => of({ ok: true })),
              deleteUser: vi.fn(() => of({ ok: true })),
              updateUserStatus: vi.fn(() => of({ ok: true })),
              getRegistration: vi.fn(() => {
                throw new Error('boom');
              }),
              setRegistration: vi.fn(),
            },
          },
          { provide: AuthService, useValue: { token: () => null, mediaToken: () => null } },
          { provide: ConfirmService, useValue: { ask: vi.fn(async () => true) } },
        ],
      }).compileComponents();
      const fixture = TestBed.createComponent(UserManagementPanelComponent);
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
      expandAllGroups(fixture);
      const el = fixture.nativeElement as HTMLElement;

      expect(el.querySelector('[data-testid="users-table"]')).not.toBeNull();
      expect(el.querySelector<HTMLInputElement>('[data-testid="signup-toggle"]')!.disabled).toBe(
        true,
      );
    });
  });

  // docs/email-invitations.md increment 2: the admin's alternative to typing a
  // password for someone.
  it('issues a reset link from the row menu and shows it once', async () => {
    const { fixture, el, issueResetLink } = await mountWithUsers();
    (el.querySelector('[data-testid="user-actions-toggle"]') as HTMLElement).click();
    fixture.detectChanges();
    (el.querySelector('[data-testid="user-action-copy-reset"]') as HTMLButtonElement).click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(issueResetLink).toHaveBeenCalledWith('u1');
    const input = el.querySelector('[data-testid="reset-link"]') as HTMLInputElement;
    expect(input.value).toBe('https://box.ts.net/reset-password#t=rt');
    expect(el.querySelector('[data-testid="reset-link-local-only"]')).toBeNull();
    expect(BASE_CATALOG['admin.resetLink']).toBeTruthy();
    fixture.destroy();
  });

  describe('Email reset link (increment 5)', () => {
    const verified: AdminUser = { ...testUser, email: 'alice@example.com', emailVerified: true };
    /** Opens the row's ⋯ menu (its items render only while open) and returns the item. */
    function openItem(m: { fixture: { detectChanges(): void }; el: HTMLElement }) {
      (m.el.querySelector('[data-testid="user-actions-toggle"]') as HTMLElement).click();
      m.fixture.detectChanges();
      return m.el.querySelector('[data-testid="user-action-email-reset"]') as HTMLButtonElement;
    }

    it('is disabled with a reason while mail is off', async () => {
      const m = await mountWithUsers([verified]);
      const item = openItem(m);
      expect(item.disabled).toBe(true);
      expect(item.title).toBe('admin.emailResetNeedsMail');
      expect(m.cmp.emailResetBlockedKey(verified)).toBe('admin.emailResetNeedsMail');
      m.fixture.destroy();
    });

    it('is disabled with a reason for a user without a verified email', async () => {
      const unverified = { ...testUser, email: 'a@example.com', emailVerified: false };
      const m = await mountWithUsers([unverified], { transport: 'smtp' });
      const item = openItem(m);
      expect(item.disabled).toBe(true);
      expect(item.title).toBe('admin.emailResetNeedsEmail');
      m.fixture.destroy();
    });

    it('mails the link for a verified user and confirms with a toast', async () => {
      const m = await mountWithUsers([verified], { transport: 'outbox' });
      const item = openItem(m);
      expect(item.disabled).toBe(false);
      item.click();
      await m.fixture.whenStable();
      expect(m.emailResetLink).toHaveBeenCalledWith('u1');
      expect(m.toast.show).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'admin.emailResetSent', kind: 'success' }),
      );
      expect(BASE_CATALOG['admin.emailResetLink']).toBeTruthy();
      m.fixture.destroy();
    });

    it('surfaces a failed send', async () => {
      const emailResetLink = vi.fn(() =>
        of({ mail: { ok: false, reason: 'unreachable', detail: 'x' }, expiresAt: 1 }),
      );
      const m = await mountWithUsers([verified], { transport: 'smtp', emailResetLink });
      openItem(m).click();
      await m.fixture.whenStable();
      expect(m.cmp.error()).toContain('admin.email.reason.unreachable');
      m.fixture.destroy();
    });
  });

  describe('Assign email', () => {
    type Mounted = Awaited<ReturnType<typeof mountWithUsers>>;
    const q = (m: Mounted, id: string) =>
      m.el.querySelector(`[data-testid="${id}"]`) as HTMLElement;

    async function openDialog(m: Mounted) {
      (q(m, 'user-actions-toggle') as HTMLButtonElement).click();
      m.fixture.detectChanges();
      (q(m, 'user-action-assign-email') as HTMLButtonElement).click();
      m.fixture.detectChanges();
      await m.fixture.whenStable();
      m.fixture.detectChanges();
    }
    function type(m: Mounted, value: string) {
      const input = q(m, 'assign-email-input') as HTMLInputElement;
      input.value = value;
      input.dispatchEvent(new Event('input'));
      m.fixture.detectChanges();
    }
    async function submit(m: Mounted) {
      (q(m, 'assign-email-submit') as HTMLButtonElement).click();
      await m.fixture.whenStable();
      m.fixture.detectChanges();
    }

    it('sends a link, shows the address as pending on the row, and closes', async () => {
      const m = await mountWithUsers([testUser], { transport: 'smtp' });
      await openDialog(m);
      expect(q(m, 'assign-email-dialog').textContent).toContain('admin.assignEmailFor');
      type(m, ' alice@example.com ');
      expect(q(m, 'assign-email-submit').textContent).toContain('admin.assignEmailSubmit');
      await submit(m);
      expect(m.assignUserEmail).toHaveBeenCalledWith('u1', 'alice@example.com');
      expect(m.toast.show).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'admin.assignEmailSent', kind: 'success' }),
      );
      expect(q(m, 'assign-email-dialog')).toBeNull();
      expect(q(m, 'user-email-pending').textContent).toContain('admin.emailPending');
      m.fixture.destroy();
    });

    it('opens on the pending address, else the current one', async () => {
      const m = await mountWithUsers([
        {
          ...testUser,
          email: 'old@example.com',
          emailVerified: true,
          pendingEmail: 'new@example.com',
        },
      ]);
      await openDialog(m);
      expect(m.cmp.assignEmail()).toBe('new@example.com');
      m.fixture.destroy();
    });

    it('cannot send while mail is off, but can still remove an address', async () => {
      const m = await mountWithUsers([
        { ...testUser, email: 'a@example.com', emailVerified: true },
      ]);
      await openDialog(m);
      expect(q(m, 'assign-email-needs-mail')).not.toBeNull();
      expect((q(m, 'assign-email-submit') as HTMLButtonElement).disabled).toBe(true);
      type(m, '');
      expect(q(m, 'assign-email-needs-mail')).toBeNull();
      expect(q(m, 'assign-email-submit').textContent).toContain('admin.assignEmailRemove');
      await submit(m);
      expect(m.assignUserEmail).toHaveBeenCalledWith('u1', '');
      expect(m.toast.show).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'admin.assignEmailRemoved' }),
      );
      m.fixture.destroy();
    });

    it('keeps the dialog open with the reason when the send fails', async () => {
      const assignUserEmail = vi.fn(() =>
        of({
          email: null,
          emailVerified: false,
          pendingEmail: 'a@example.com',
          mail: { ok: false, reason: 'auth', detail: '535' },
        }),
      );
      const m = await mountWithUsers([testUser], { transport: 'smtp', assignUserEmail });
      await openDialog(m);
      type(m, 'a@example.com');
      await submit(m);
      expect(q(m, 'assign-email-error').textContent).toContain('admin.email.reason.auth');
      expect(q(m, 'assign-email-dialog')).not.toBeNull();
      m.fixture.destroy();
    });

    it('says when another account has the address', async () => {
      const assignUserEmail = vi.fn(() =>
        throwError(
          () => new HttpErrorResponse({ status: 409, error: { code: 'EMAIL_TAKEN', error: 'x' } }),
        ),
      );
      const m = await mountWithUsers([testUser], { transport: 'smtp', assignUserEmail });
      await openDialog(m);
      type(m, 'taken@example.com');
      await submit(m);
      expect(q(m, 'assign-email-error').textContent).toContain('account.emailTaken');
      m.fixture.destroy();
    });

    it('every key it renders exists in both catalogs', async () => {
      const es = (await import('../../../../../public/i18n/es.json')).default as Record<
        string,
        string
      >;
      const en = BASE_CATALOG as Record<string, string>;
      for (const key of [
        'admin.assignEmail',
        'admin.assignEmailFor',
        'admin.assignEmailHelp',
        'admin.assignEmailPlaceholder',
        'admin.assignEmailSubmit',
        'admin.assignEmailRemove',
        'admin.assignEmailSent',
        'admin.assignEmailRemoved',
        'admin.assignEmailFailed',
        'admin.emailPending',
      ]) {
        expect(en[key], key).toBeTruthy();
        expect(es[key], key).toBeTruthy();
      }
    });
  });
});
