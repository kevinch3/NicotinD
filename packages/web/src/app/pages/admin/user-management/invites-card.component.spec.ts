import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import BASE_CATALOG from '../../../../../public/i18n/en.json';
import { InvitesCardComponent } from './invites-card.component';
import { InvitesApiService } from '../../../services/api/invites-api.service';
import { MailApiService } from '../../../services/api/mail-api.service';
import type { InviteLinkResponse, InviteSummary } from '../../../services/api/api-types';
import { ConfirmService } from '../../../services/confirm.service';
import { ToastService } from '../../../services/toast.service';

vi.mock('../../../lib/qr', () => ({
  renderQrDataUrl: vi.fn(async () => 'data:image/png;base64,QR'),
}));

const pending: InviteSummary = {
  id: 'i1',
  role: 'user',
  note: 'For Sam',
  createdBy: 'boss',
  createdAt: 1,
  expiresAt: Date.now() + 1e9,
  maxUses: 1,
  useCount: 0,
  revokedAt: null,
  status: 'pending',
  acceptedBy: [],
  email: null,
};

function link(urls: string[], invite = pending): InviteLinkResponse {
  return { invite, token: 'tok', urls, path: '/invite#t=tok' };
}

async function mount(
  over: {
    invites?: InviteSummary[];
    api?: Partial<Record<string, unknown>>;
    confirm?: boolean;
    /** The mail API's effective transport; 'fail' makes the status read throw. */
    transport?: 'off' | 'smtp' | 'outbox' | 'fail';
  } = {},
) {
  TestBed.resetTestingModule();
  const api = {
    list: vi.fn(() => of({ invites: over.invites ?? [] })),
    create: vi.fn(() => of(link(['https://box.ts.net']))),
    rotateLink: vi.fn(() => of(link(['https://box.ts.net']))),
    revoke: vi.fn(() => of({ invite: { ...pending, status: 'revoked', revokedAt: 2 } })),
    ...over.api,
  };
  const toast = { show: vi.fn() };
  const transport = over.transport ?? 'off';
  const mailApi = {
    get: vi.fn(() =>
      transport === 'fail'
        ? throwError(() => new Error('403'))
        : of({ effectiveTransport: transport }),
    ),
  };
  await TestBed.configureTestingModule({
    imports: [InvitesCardComponent],
    providers: [
      { provide: InvitesApiService, useValue: api },
      { provide: MailApiService, useValue: mailApi },
      { provide: ConfirmService, useValue: { ask: vi.fn(async () => over.confirm ?? true) } },
      { provide: ToastService, useValue: toast },
    ],
  }).compileComponents();
  const fixture = TestBed.createComponent(InvitesCardComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const q = (id: string) => el.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
  const settle = async () => {
    await fixture.whenStable();
    fixture.detectChanges();
  };
  return { fixture, el, q, api, toast, settle, cmp: fixture.componentInstance };
}

describe('InvitesCardComponent', () => {
  beforeEach(() => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => {}) } });
  });

  it('shows the empty state with real keys', async () => {
    const { q } = await mount();
    expect(q('invites-empty')?.textContent?.trim()).toBe('invites.empty');
    expect(BASE_CATALOG['invites.empty']).toBeTruthy();
  });

  it('lists invites with their status as a data attribute', async () => {
    const used: InviteSummary = {
      ...pending,
      id: 'i2',
      status: 'used',
      useCount: 1,
      acceptedBy: ['sam'],
    };
    const { el } = await mount({ invites: [pending, used] });
    const rows = [...el.querySelectorAll('[data-testid="invite-row"]')];
    expect(rows.map((r) => r.getAttribute('data-status'))).toEqual(['pending', 'used']);
    // Only a pending invite offers actions.
    expect(rows[0].querySelector('[data-testid="invite-revoke"]')).toBeTruthy();
    expect(rows[1].querySelector('[data-testid="invite-revoke"]')).toBeNull();
    expect(rows[1].querySelector('[data-testid="invite-accepted-by"]')).toBeTruthy();
  });

  it('creates a link with the chosen settings and shows link + QR', async () => {
    const { q, api, settle, cmp } = await mount();
    q('invite-open')!.click();
    await settle();
    cmp.role.set('listener');
    cmp.expiresInHours.set(24);
    cmp.maxUses.set(3);
    cmp.note.set('  Family  ');
    q('invite-submit')!.click();
    await settle();
    expect(api.create).toHaveBeenCalledWith({
      role: 'listener',
      expiresInHours: 24,
      maxUses: 3,
      note: 'Family',
    });
    expect((q('invite-link') as HTMLInputElement).value).toBe('https://box.ts.net/invite#t=tok');
    expect(q('invite-qr')?.getAttribute('src')).toContain('data:image/png');
    expect(q('invite-local-only')).toBeNull();
    expect(api.list).toHaveBeenCalledTimes(2);
  });

  it('warns when the only address is this machine', async () => {
    const { q, settle } = await mount({ api: { create: vi.fn(() => of(link([]))) } });
    q('invite-open')!.click();
    await settle();
    q('invite-submit')!.click();
    await settle();
    expect(q('invite-local-only')).toBeTruthy();
    expect((q('invite-link') as HTMLInputElement).value).toBe(
      `${window.location.origin}/invite#t=tok`,
    );
  });

  it('refuses an out-of-range use count', async () => {
    const { q, settle, cmp } = await mount();
    q('invite-open')!.click();
    await settle();
    cmp.maxUses.set(26);
    await settle();
    expect((q('invite-submit') as HTMLButtonElement).disabled).toBe(true);
  });

  it('copies the link', async () => {
    const { q, settle, toast } = await mount();
    q('invite-open')!.click();
    await settle();
    q('invite-submit')!.click();
    await settle();
    q('invite-copy')!.click();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('https://box.ts.net/invite#t=tok');
    expect(toast.show).toHaveBeenCalled();
  });

  it('revokes after confirmation and updates the row', async () => {
    const { el, q, api, settle } = await mount({ invites: [pending] });
    q('invite-revoke')!.click();
    await settle();
    expect(api.revoke).toHaveBeenCalledWith('i1');
    expect(el.querySelector('[data-testid="invite-row"]')?.getAttribute('data-status')).toBe(
      'revoked',
    );
  });

  it('does nothing when the revoke is not confirmed', async () => {
    const { q, api, settle } = await mount({ invites: [pending], confirm: false });
    q('invite-revoke')!.click();
    await settle();
    expect(api.revoke).not.toHaveBeenCalled();
  });

  it('opens the result dialog with a rotated link', async () => {
    const { q, api, settle } = await mount({ invites: [pending] });
    q('invite-new-link')!.click();
    await settle();
    expect(api.rotateLink).toHaveBeenCalledWith('i1');
    expect(q('invite-link')).toBeTruthy();
  });

  describe('emailed invites', () => {
    const emailed = (mail: InviteLinkResponse['mail']): InviteLinkResponse => ({
      ...link(['https://box.ts.net'], { ...pending, email: 'sam@example.com' }),
      mail,
    });

    it('disables the email field while mail is off, with a way to set it up', async () => {
      for (const transport of ['off', 'fail'] as const) {
        const { q, settle, cmp } = await mount({ transport });
        q('invite-open')!.click();
        await settle();
        expect((q('invite-email-input') as HTMLInputElement).disabled).toBe(true);
        expect(q('invite-email-off')).toBeTruthy();
        expect(q('invite-email-setup')).toBeTruthy();
        expect(cmp.sendsEmail()).toBe(false);
      }
      expect(BASE_CATALOG['invites.emailOff']).toBeTruthy();
      expect(BASE_CATALOG['invites.emailSetUp']).toBeTruthy();
    });

    it('"Set up email" closes the dialog and opens the Email delivery group', async () => {
      const section = document.createElement('section');
      section.setAttribute('data-group-id', 'email-delivery');
      section.innerHTML =
        '<button data-testid="settings-group-toggle" aria-expanded="false"></button>';
      const toggle = vi.fn();
      section.querySelector('button')!.addEventListener('click', toggle);
      document.body.appendChild(section);
      try {
        const { q, settle } = await mount();
        q('invite-open')!.click();
        await settle();
        q('invite-email-setup')!.click();
        await settle();
        expect(q('invite-dialog')).toBeNull();
        expect(toggle).toHaveBeenCalledTimes(1);
      } finally {
        section.remove();
      }
    });

    it('with an address, the submit says "Send invite" and sends a single-use invite', async () => {
      const create = vi.fn(() => of(emailed({ ok: true })));
      const { q, settle, cmp, api } = await mount({ transport: 'outbox', api: { create } });
      q('invite-open')!.click();
      await settle();
      cmp.maxUses.set(5);
      cmp.email.set(' sam@example.com ');
      await settle();
      expect(q('invite-submit')!.textContent?.trim()).toBe('invites.sendInvite');
      expect((q('invite-uses-input') as HTMLInputElement).disabled).toBe(true);
      q('invite-submit')!.click();
      await settle();
      expect(api.create).toHaveBeenCalledWith({
        role: 'user',
        expiresInHours: 168,
        maxUses: 1,
        email: 'sam@example.com',
      });
      expect(q('invite-sent')?.textContent).toContain('invites.sentTo');
      expect(q('invite-link')).toBeNull();
      expect(q('invite-mail-failed')).toBeNull();
      expect(BASE_CATALOG['invites.sentTo']).toContain('{email}');
    });

    it('without an address the label stays "Create link"', async () => {
      const { q, settle } = await mount({ transport: 'smtp' });
      q('invite-open')!.click();
      await settle();
      expect(q('invite-submit')!.textContent?.trim()).toBe('invites.createLink');
    });

    it('refuses an address that is not one', async () => {
      const { q, settle, cmp } = await mount({ transport: 'smtp' });
      q('invite-open')!.click();
      await settle();
      cmp.email.set('nope');
      await settle();
      expect(q('invite-email-invalid')).toBeTruthy();
      expect((q('invite-submit') as HTMLButtonElement).disabled).toBe(true);
    });

    it('a failed send warns with the reason and still shows the link and QR', async () => {
      const create = vi.fn(() =>
        of(emailed({ ok: false, reason: 'unreachable', detail: 'ECONNREFUSED' })),
      );
      const { q, settle, cmp } = await mount({ transport: 'smtp', api: { create } });
      q('invite-open')!.click();
      await settle();
      cmp.email.set('sam@example.com');
      q('invite-submit')!.click();
      await settle();
      expect(q('invite-mail-failed')?.textContent).toContain('admin.email.reason.unreachable');
      expect((q('invite-link') as HTMLInputElement).value).toBe('https://box.ts.net/invite#t=tok');
      expect(q('invite-qr')).toBeTruthy();
      expect(q('invite-sent')).toBeNull();
      expect(BASE_CATALOG['invites.mailFailed']).toBeTruthy();
    });

    it('shows an emailed invite’s address on its row', async () => {
      const { el } = await mount({ invites: [{ ...pending, email: 'sam@example.com' }] });
      expect(el.querySelector('[data-testid="invite-email"]')?.textContent).toContain(
        'sam@example.com',
      );
    });
  });

  it('surfaces a create failure without leaving the dialog open', async () => {
    const { q, settle } = await mount({
      api: { create: vi.fn(() => throwError(() => ({ error: { error: 'nope' } }))) },
    });
    q('invite-open')!.click();
    await settle();
    q('invite-submit')!.click();
    await settle();
    expect(q('invites-error')?.textContent).toContain('nope');
    expect(q('invite-dialog')).toBeNull();
  });
});
