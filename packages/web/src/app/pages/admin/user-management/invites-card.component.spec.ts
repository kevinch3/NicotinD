import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import BASE_CATALOG from '../../../../../public/i18n/en.json';
import { InvitesCardComponent } from './invites-card.component';
import { InvitesApiService } from '../../../services/api/invites-api.service';
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
};

function link(urls: string[], invite = pending): InviteLinkResponse {
  return { invite, token: 'tok', urls, path: '/invite#t=tok' };
}

async function mount(
  over: {
    invites?: InviteSummary[];
    api?: Partial<Record<string, unknown>>;
    confirm?: boolean;
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
  await TestBed.configureTestingModule({
    imports: [InvitesCardComponent],
    providers: [
      { provide: InvitesApiService, useValue: api },
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
