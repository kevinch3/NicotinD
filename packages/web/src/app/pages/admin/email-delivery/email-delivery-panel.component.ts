import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { SettingsGroupComponent } from '../../../components/settings-group/settings-group.component';
import { TranslatePipe } from '../../../pipes/translate.pipe';
import { MailApiService } from '../../../services/api/mail-api.service';
import type {
  MailAdminView,
  MailPresetDto,
  MailSendReason,
  MailSettingsUpdate,
  MailTestResult,
} from '../../../services/api/api-types';
import { TranslateService } from '../../../services/translate.service';
import { httpErrorMessageI18n } from '../../../lib/http-error';

/** i18n key of the sentence shown for a failed send. */
export function mailReasonKey(reason: MailSendReason): string {
  return `admin.email.reason.${reason}`;
}

/**
 * Admin → Email delivery (docs/email-invitations.md, increment 3): provider
 * preset, SMTP connection, From, the link base, the daily cap, and a test send
 * that proves both delivery and that the link base opens.
 *
 * The password is write-only. The field starts empty with a "saved"
 * placeholder when one is stored; a save sends `password` only when the admin
 * typed one (replace) or pressed Clear (`''`), so saving any other field never
 * touches it. When `NICOTIND_MAIL_TRANSPORT` pins the config, everything renders
 * read-only with a note — the signup switch's `signupConfigurable` pattern —
 * but the test send still works, which is how e2e proves the outbox.
 *
 * The "Forgot password?" switch (increment 5) lives here too, as its own
 * setting: it works while env pins the transport, saves on toggle, and is
 * disabled while mail is off — recovery without mail would be a dead link.
 *
 * Loaded when the group opens, not on page load: Admin already polls enough.
 */
@Component({
  selector: 'app-email-delivery-panel',
  standalone: true,
  host: { class: 'contents' },
  imports: [SettingsGroupComponent, FormsModule, TranslatePipe],
  templateUrl: './email-delivery-panel.component.html',
})
export class EmailDeliveryPanelComponent {
  private readonly api = inject(MailApiService);
  readonly i18n = inject(TranslateService);

  readonly view = signal<MailAdminView | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  // The editable form — a copy of the view's settings until saved.
  readonly transport = signal<'off' | 'smtp' | 'outbox'>('off');
  readonly presetId = signal('custom');
  readonly host = signal('');
  readonly port = signal(587);
  readonly secure = signal(false);
  readonly username = signal('');
  /** What the admin typed; '' means "leave the stored password alone". */
  readonly password = signal('');
  /** Clear was pressed: the save sends `password: ''`. */
  readonly clearPassword = signal(false);
  readonly fromName = signal('');
  readonly fromAddress = signal('');
  readonly publicUrl = signal('');
  readonly dailyCap = signal(100);

  readonly saving = signal(false);
  readonly saved = signal(false);

  readonly testTo = signal('');
  readonly testing = signal(false);
  readonly testResult = signal<MailTestResult | null>(null);

  readonly recoverySaving = signal(false);
  readonly recoveryEnabled = computed(() => this.view()?.recovery?.enabled === true);
  readonly recoveryAvailable = computed(
    () => !!this.view() && this.view()!.effectiveTransport !== 'off',
  );

  readonly locked = computed(() => this.view()?.configurable === false);
  readonly publicUrlLocked = computed(
    () => this.locked() || this.view()?.publicUrlConfigurable === false,
  );
  readonly presets = computed<MailPresetDto[]>(() => this.view()?.presets ?? []);
  readonly preset = computed(() => this.presets().find((p) => p.id === this.presetId()) ?? null);
  readonly usage = computed(() => this.view()?.usage ?? null);
  readonly passwordSet = computed(() => !!this.view()?.passwordSet && !this.clearPassword());
  readonly canTest = computed(
    () =>
      !!this.view() &&
      this.view()!.effectiveTransport !== 'off' &&
      !this.testing() &&
      this.testTo().trim().length > 0,
  );

  async load(): Promise<void> {
    this.loading.set(true);
    try {
      this.populate(await firstValueFrom(this.api.get()));
      this.error.set(null);
    } catch (err) {
      this.error.set(httpErrorMessageI18n(err, this.i18n, this.i18n.t('admin.email.loadFailed')));
    } finally {
      this.loading.set(false);
    }
  }

  private populate(view: MailAdminView): void {
    const s = view.settings;
    this.view.set(view);
    this.transport.set(view.configurable ? s.transport : view.effectiveTransport);
    this.presetId.set(s.presetId);
    this.host.set(s.host);
    this.port.set(s.port);
    this.secure.set(s.secure);
    this.username.set(s.username);
    this.password.set('');
    this.clearPassword.set(false);
    this.fromName.set(s.fromName);
    this.fromAddress.set(s.fromAddress);
    this.publicUrl.set(s.publicUrl);
    this.dailyCap.set(s.dailyCap);
  }

  /** A preset fills host, port and TLS mode; Custom keeps what is there. */
  /**
   * Fill a provider's host, port and TLS mode. Switching to another provider
   * also replaces the username, which belonged to the old one (#1904): with
   * the new provider's fixed username when it has one, else cleared so its
   * hint shows. *Custom* keeps every field, as it always has.
   */
  choosePreset(id: string): void {
    const changed = id !== this.presetId();
    this.presetId.set(id);
    const p = this.presets().find((x) => x.id === id);
    if (!p || !p.host) return;
    this.host.set(p.host);
    this.port.set(p.port);
    this.secure.set(p.secure);
    if (changed) this.username.set(p.username ?? '');
  }

  setPassword(value: string): void {
    this.password.set(value);
    if (value) this.clearPassword.set(false);
  }

  clearSavedPassword(): void {
    this.password.set('');
    this.clearPassword.set(true);
  }

  /** The PUT body. The password rides along only when the admin changed it. */
  payload(): MailSettingsUpdate {
    const body: MailSettingsUpdate = {
      transport: this.transport() === 'smtp' ? 'smtp' : 'off',
      presetId: this.presetId(),
      host: this.host().trim(),
      port: Number(this.port()),
      secure: this.secure(),
      username: this.username().trim(),
      fromName: this.fromName().trim(),
      fromAddress: this.fromAddress().trim(),
      dailyCap: Number(this.dailyCap()),
    };
    if (!this.publicUrlLocked()) body.publicUrl = this.publicUrl().trim();
    if (this.password()) body.password = this.password();
    else if (this.clearPassword()) body.password = '';
    return body;
  }

  async save(): Promise<void> {
    if (this.locked() || this.saving()) return;
    this.saving.set(true);
    this.saved.set(false);
    try {
      this.populate(await firstValueFrom(this.api.save(this.payload())));
      this.error.set(null);
      this.saved.set(true);
    } catch (err) {
      this.error.set(httpErrorMessageI18n(err, this.i18n, this.i18n.t('admin.email.saveFailed')));
    } finally {
      this.saving.set(false);
    }
  }

  async sendTest(): Promise<void> {
    if (!this.canTest()) return;
    this.testing.set(true);
    this.testResult.set(null);
    try {
      const result = await firstValueFrom(this.api.sendTest(this.testTo().trim()));
      this.testResult.set(result);
      this.view.update((v) => (v ? { ...v, usage: result.usage } : v));
    } catch (err) {
      this.error.set(httpErrorMessageI18n(err, this.i18n, this.i18n.t('admin.email.testFailed')));
    } finally {
      this.testing.set(false);
    }
  }

  /**
   * Saved on toggle. The checkbox is handed back to the model first (the
   * signup switch's pattern): a native checkbox flips itself on click, and the
   * binding only re-applies when the bound value changes.
   */
  async setRecovery(target: HTMLInputElement): Promise<void> {
    const enabled = target.checked;
    target.checked = this.recoveryEnabled();
    if (this.recoverySaving() || (enabled && !this.recoveryAvailable())) return;
    this.recoverySaving.set(true);
    try {
      const view = await firstValueFrom(this.api.setRecovery(enabled));
      this.view.update((v) => (v ? { ...v, recovery: view.recovery } : view));
      this.error.set(null);
    } catch (err) {
      this.error.set(
        httpErrorMessageI18n(err, this.i18n, this.i18n.t('admin.email.recoveryFailed')),
      );
    } finally {
      this.recoverySaving.set(false);
    }
  }

  reasonKey(reason: MailSendReason): string {
    return mailReasonKey(reason);
  }
}
