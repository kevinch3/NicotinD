import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import BASE_CATALOG from '../../../../../public/i18n/en.json';
import ES_CATALOG from '../../../../../public/i18n/es.json';
import { EmailDeliveryPanelComponent, mailReasonKey } from './email-delivery-panel.component';
import { MailApiService } from '../../../services/api/mail-api.service';
import {
  MAIL_SEND_REASONS,
  type MailAdminView,
  type MailTestResult,
} from '../../../services/api/api-types';
import { expandAllGroups } from '../../../../testing/expand-groups';

const PRESETS = [
  {
    id: 'mailgun',
    label: 'Mailgun',
    host: 'smtp.mailgun.org',
    port: 587,
    secure: false,
    usernameHint: 'postmaster@<your-domain>',
    helpKey: 'admin.email.presetHelp.mailgun',
  },
  {
    id: 'fastmail',
    label: 'Fastmail',
    host: 'smtp.fastmail.com',
    port: 465,
    secure: true,
    usernameHint: 'you@fastmail.com',
    helpKey: 'admin.email.presetHelp.fastmail',
  },
  {
    id: 'custom',
    label: 'Custom SMTP',
    host: '',
    port: 587,
    secure: false,
    usernameHint: '',
    helpKey: 'admin.email.presetHelp.custom',
  },
];

function makeView(over: Partial<MailAdminView> = {}): MailAdminView {
  return {
    settings: {
      transport: 'smtp',
      presetId: 'custom',
      host: 'mail.example.com',
      port: 587,
      secure: false,
      username: 'me',
      fromAddress: 'music@example.com',
      fromName: 'Den',
      publicUrl: '',
      dailyCap: 100,
    },
    effectiveTransport: 'smtp',
    passwordSet: true,
    configurable: true,
    publicUrlConfigurable: true,
    presets: PRESETS,
    usage: { sentToday: 3, cap: 100 },
    linkBase: 'https://den.tail.ts.net',
    ...over,
  };
}

async function mount(view: MailAdminView = makeView(), api: Record<string, unknown> = {}) {
  localStorage.clear();
  TestBed.resetTestingModule();
  const mock = {
    get: vi.fn(() => of(structuredClone(view))),
    save: vi.fn(() => of(structuredClone(view))),
    sendTest: vi.fn(() =>
      of<MailTestResult>({
        ok: true,
        providerId: 'q1',
        usage: { sentToday: 4, cap: 100 },
        linkBase: 'x',
      }),
    ),
    ...api,
  };
  await TestBed.configureTestingModule({
    imports: [EmailDeliveryPanelComponent],
    providers: [{ provide: MailApiService, useValue: mock }],
  }).compileComponents();
  const fixture = TestBed.createComponent(EmailDeliveryPanelComponent);
  fixture.detectChanges();
  expandAllGroups(fixture);
  // The group's `(opened)` is what calls load() in the app; this JIT harness
  // does not deliver a nested component's output (library-health's spec makes
  // the same call by hand), so the spec opens it the same way.
  await fixture.componentInstance.load();
  await fixture.whenStable();
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const q = <T extends HTMLElement = HTMLElement>(id: string) =>
    el.querySelector(`[data-testid="${id}"]`) as T | null;
  const settle = async () => {
    await fixture.whenStable();
    fixture.detectChanges();
  };
  return { fixture, el, q, api: mock, settle, cmp: fixture.componentInstance };
}

describe('EmailDeliveryPanelComponent', () => {
  beforeEach(() => localStorage.clear());

  it('loads and populates every field', async () => {
    const { q, api, cmp } = await mount();
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(q('email-panel')).not.toBeNull();
    expect(cmp.host()).toBe('mail.example.com');
    expect(q<HTMLInputElement>('email-host-input')).not.toBeNull();
    expect(q<HTMLInputElement>('email-port-input')).not.toBeNull();
    expect(q<HTMLInputElement>('email-user-input')).not.toBeNull();
    expect(q<HTMLInputElement>('email-from-input')).not.toBeNull();
    expect(q<HTMLInputElement>('email-public-url-input')).not.toBeNull();
    expect(q<HTMLInputElement>('email-cap-input')).not.toBeNull();
    expect(q('email-env-locked')).toBeNull();
    expect(q('email-save')).not.toBeNull();
    // The saved password is never shown, only that one exists.
    const pw = q<HTMLInputElement>('email-password-input')!;
    expect(pw.value).toBe('');
    expect(pw.getAttribute('placeholder')).toBe('admin.email.passwordSaved');
  });

  it('shows the effective link base and the quota', async () => {
    const { q } = await mount();
    expect(q('email-link-base')!.getAttribute('data-base')).toBe('https://den.tail.ts.net');
    expect(q('email-link-base')!.textContent).toContain('admin.email.linkBase');
    const quota = q('email-quota')!;
    expect(quota.getAttribute('data-sent')).toBe('3');
    expect(quota.getAttribute('data-cap')).toBe('100');
  });

  it('warns when no link base is known', async () => {
    const { q } = await mount(makeView({ linkBase: null }));
    expect(q('email-link-base')!.textContent).toContain('admin.email.linkBaseNone');
  });

  it('a preset fills host, port and TLS mode and shows its help', async () => {
    const { cmp, q, settle } = await mount();
    cmp.choosePreset('fastmail');
    await settle();
    expect(cmp.host()).toBe('smtp.fastmail.com');
    expect(cmp.port()).toBe(465);
    expect(cmp.secure()).toBe(true);
    expect(q('email-preset-help')!.textContent).toContain('admin.email.presetHelp.fastmail');
    expect(q<HTMLInputElement>('email-user-input')!.getAttribute('placeholder')).toBe(
      'you@fastmail.com',
    );
    // Custom keeps what is there rather than blanking it.
    cmp.choosePreset('custom');
    expect(cmp.host()).toBe('smtp.fastmail.com');
  });

  it('saves without the password when it was not touched', async () => {
    const { cmp, api } = await mount();
    cmp.fromName.set('New name');
    await cmp.save();
    expect(api.save).toHaveBeenCalledTimes(1);
    const body = (api.save.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(body).not.toHaveProperty('password');
    expect(body).toMatchObject({
      transport: 'smtp',
      host: 'mail.example.com',
      port: 587,
      fromName: 'New name',
      fromAddress: 'music@example.com',
      dailyCap: 100,
      publicUrl: '',
    });
    expect(cmp.saved()).toBe(true);
  });

  it('sends a typed password, and Clear sends an empty one', async () => {
    const { cmp, api } = await mount();
    cmp.setPassword('hunter2');
    expect(cmp.payload().password).toBe('hunter2');
    cmp.clearSavedPassword();
    expect(cmp.payload().password).toBe('');
    expect(cmp.passwordSet()).toBe(false);
    await cmp.save();
    expect((api.save.mock.calls[0] as unknown as [Record<string, unknown>])[0]).toMatchObject({
      password: '',
    });
  });

  it('leaves publicUrl out of the save when NICOTIND_PUBLIC_URL pins it', async () => {
    const { cmp, q } = await mount(makeView({ publicUrlConfigurable: false }));
    expect(q<HTMLInputElement>('email-public-url-input')!.disabled).toBe(true);
    expect(cmp.payload()).not.toHaveProperty('publicUrl');
  });

  it('env-locked: renders read-only with a note and no Save, but test send still works', async () => {
    const view = makeView({
      configurable: false,
      publicUrlConfigurable: false,
      effectiveTransport: 'outbox',
      settings: { ...makeView().settings, transport: 'outbox' },
    });
    const { q, cmp, api, settle } = await mount(view);
    expect(q('email-env-locked')).not.toBeNull();
    expect(q('email-panel')!.getAttribute('data-locked')).toBe('true');
    expect(q('email-save')).toBeNull();
    expect(q<HTMLSelectElement>('email-transport-select')!.disabled).toBe(true);
    expect(q<HTMLInputElement>('email-cap-input')!.disabled).toBe(true);
    await cmp.save();
    expect(api.save).not.toHaveBeenCalled();

    cmp.testTo.set('me@example.com');
    await settle();
    expect(q<HTMLButtonElement>('email-test-send')!.disabled).toBe(false);
    await cmp.sendTest();
    expect(api.sendTest).toHaveBeenCalledWith('me@example.com');
  });

  it('test send ok: shows success and updates the quota', async () => {
    const { cmp, q, settle } = await mount();
    cmp.testTo.set(' me@example.com ');
    await cmp.sendTest();
    await settle();
    const line = q('email-test-result')!;
    expect(line.getAttribute('data-ok')).toBe('true');
    expect(line.textContent).toContain('admin.email.testOk');
    expect(q('email-quota')!.getAttribute('data-sent')).toBe('4');
  });

  it('test send failure: renders the translated reason and the server detail', async () => {
    const { cmp, q, settle } = await mount(makeView(), {
      sendTest: vi.fn(() =>
        of<MailTestResult>({
          ok: false,
          reason: 'auth',
          detail: '535 5.7.8 Bad credentials',
          usage: { sentToday: 3, cap: 100 },
          linkBase: 'x',
        }),
      ),
    });
    cmp.testTo.set('me@example.com');
    await cmp.sendTest();
    await settle();
    const line = q('email-test-result')!;
    expect(line.getAttribute('data-ok')).toBe('false');
    expect(line.getAttribute('data-reason')).toBe('auth');
    expect(line.textContent).toContain('admin.email.reason.auth');
    expect(line.textContent).toContain('535 5.7.8 Bad credentials');
  });

  it('cannot test while delivery is off', async () => {
    const { cmp, q, settle } = await mount(
      makeView({
        effectiveTransport: 'off',
        settings: { ...makeView().settings, transport: 'off' },
      }),
    );
    cmp.testTo.set('me@example.com');
    await settle();
    expect(q<HTMLButtonElement>('email-test-send')!.disabled).toBe(true);
    // SMTP fields are hidden while off.
    expect(q('email-host-input')).toBeNull();
  });

  it('every reason, preset help and key the template uses exists in both catalogs', () => {
    const en = BASE_CATALOG as Record<string, string>;
    const es = ES_CATALOG as Record<string, string>;
    const keys = [
      ...MAIL_SEND_REASONS.map(mailReasonKey),
      ...['mailgun', 'brevo', 'gmail', 'fastmail', 'custom'].map(
        (id) => `admin.email.presetHelp.${id}`,
      ),
      'admin.email.groupTitle',
      'admin.email.envLocked',
      'admin.email.passwordSaved',
      'admin.email.linkBase',
      'admin.email.linkBaseNone',
      'admin.email.quota',
      'admin.email.testOk',
    ];
    for (const key of keys) {
      expect(en[key], key).toBeTruthy();
      expect(es[key], key).toBeTruthy();
    }
    // Single-brace placeholders, the pipe's syntax.
    expect(en['admin.email.quota']).toBe('{sent} / {cap} today');
    expect(en['admin.email.linkBase']).toContain('{url}');
  });

  describe('password recovery switch', () => {
    const withRecovery = (enabled: boolean, over: Partial<MailAdminView> = {}) =>
      makeView({ recovery: { enabled, effective: enabled }, ...over });

    it("saves on toggle and shows the server's answer", async () => {
      const setRecovery = vi.fn(() => of(withRecovery(true)));
      const { q, settle, cmp } = await mount(withRecovery(false), { setRecovery });
      const toggle = q<HTMLInputElement>('recovery-toggle')!;
      expect(toggle.checked).toBe(false);
      expect(toggle.disabled).toBe(false);
      toggle.checked = true;
      await cmp.setRecovery(toggle);
      await settle();
      expect(setRecovery).toHaveBeenCalledWith(true);
      expect(cmp.recoveryEnabled()).toBe(true);
      expect(q<HTMLInputElement>('recovery-toggle')!.checked).toBe(true);
      expect(BASE_CATALOG['admin.email.recoveryHint']).toBeTruthy();
      expect(ES_CATALOG['admin.email.recoveryHint']).toBeTruthy();
    });

    it('works while the card is env-locked — it is its own setting', async () => {
      const { q } = await mount(
        withRecovery(false, { configurable: false, effectiveTransport: 'outbox' }),
      );
      expect(q('email-env-locked')).not.toBeNull();
      expect(q<HTMLInputElement>('recovery-toggle')!.disabled).toBe(false);
    });

    it('is disabled with a reason while mail is off', async () => {
      const setRecovery = vi.fn();
      const { q, cmp } = await mount(withRecovery(false, { effectiveTransport: 'off' }), {
        setRecovery,
      });
      expect(q<HTMLInputElement>('recovery-toggle')!.disabled).toBe(true);
      expect(q('recovery-needs-mail')).not.toBeNull();
      const toggle = q<HTMLInputElement>('recovery-toggle')!;
      toggle.checked = true;
      await cmp.setRecovery(toggle);
      expect(setRecovery).not.toHaveBeenCalled();
    });

    it('keeps the old value and says so when the save fails', async () => {
      const setRecovery = vi.fn(() => {
        throw { error: { error: 'nope', code: 'MAIL_NOT_CONFIGURED' } };
      });
      const { q, cmp, settle } = await mount(withRecovery(false), { setRecovery });
      const toggle = q<HTMLInputElement>('recovery-toggle')!;
      toggle.checked = true;
      await cmp.setRecovery(toggle);
      await settle();
      expect(cmp.recoveryEnabled()).toBe(false);
      expect(q('email-error')).not.toBeNull();
    });
  });
});
