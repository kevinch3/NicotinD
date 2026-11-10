import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ROLES, type Role } from '../../../../types/core';
import { TranslatePipe } from '../../../pipes/translate.pipe';
import { BottomChromeSafeDirective } from '../../../directives/bottom-chrome-safe.directive';
import { InvitesApiService } from '../../../services/api/invites-api.service';
import { MailApiService } from '../../../services/api/mail-api.service';
import type {
  CreateInviteRequest,
  InviteLinkResponse,
  InviteSummary,
  MailSendResult,
} from '../../../services/api/api-types';
import { ConfirmService } from '../../../services/confirm.service';
import { ToastService } from '../../../services/toast.service';
import { TranslateService } from '../../../services/translate.service';
import { httpErrorMessageI18n } from '../../../lib/http-error';
import { buildInviteLink } from '../../../lib/invite-link';
import { revealSettingsGroup } from '../../../lib/group-state';
import { renderQrDataUrl } from '../../../lib/qr';
import { mailReasonKey } from '../email-delivery/email-delivery-panel.component';

/** Lifetimes the API accepts — the same closed set as `INVITE_EXPIRY_HOURS`. */
export const INVITE_EXPIRY_OPTIONS: ReadonlyArray<CreateInviteRequest['expiresInHours']> = [
  24, 168, 720,
];
export const MAX_INVITE_USES = 25;

/** What the result dialog shows right after a mint or a rotate. */
export interface MintedInviteLink {
  link: string;
  localOnly: boolean;
  expiresAt: number;
  /** An emailed invite's recipient and how the send went; absent for a link invite. */
  email?: string;
  mail?: MailSendResult;
}

/** Loose, like the server's `looksLikeEmail`: one @, a dot after it, no spaces. */
export function looksLikeEmail(value: string): boolean {
  return /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/.test(value.trim());
}

/**
 * Invitations, inside Admin → User Management (docs/email-invitations.md): the
 * "Invite" dialog, the one-time link + QR it produces, and the list of invites
 * with their state. Lives under the users table because "who may become a
 * user" is the question that card already answers — next to the public-signup
 * switch, which invites deliberately bypass.
 *
 * A link is shown once: only its hash is stored, so "copy again" means minting
 * a fresh link for the same invite (the old one stops working).
 *
 * With an email (increment 4) the server also mails the link; the dialog says
 * it was sent, or — when the send failed — says why and still shows the link,
 * because the invite exists either way. The email field is disabled, with a
 * jump to Admin → Email delivery, while mail is off.
 */
@Component({
  selector: 'app-invites-card',
  standalone: true,
  imports: [FormsModule, TranslatePipe, BottomChromeSafeDirective],
  templateUrl: './invites-card.component.html',
})
export class InvitesCardComponent implements OnInit {
  private readonly api = inject(InvitesApiService);
  private readonly mailApi = inject(MailApiService);
  private readonly confirm = inject(ConfirmService);
  private readonly toast = inject(ToastService);
  readonly i18n = inject(TranslateService);

  readonly roles = ROLES;
  readonly expiryOptions = INVITE_EXPIRY_OPTIONS;
  readonly maxUsesCap = MAX_INVITE_USES;

  readonly invites = signal<InviteSummary[]>([]);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);

  readonly dialogOpen = signal(false);
  readonly role = signal<Role>('user');
  readonly expiresInHours = signal<CreateInviteRequest['expiresInHours']>(168);
  readonly maxUses = signal(1);
  readonly note = signal('');
  readonly email = signal('');
  readonly creating = signal(false);
  /** Whether the server can send mail at all; false until known, and on any failure. */
  readonly mailEnabled = signal(false);

  readonly emailGiven = computed(() => this.email().trim().length > 0);
  readonly emailValid = computed(() => !this.emailGiven() || looksLikeEmail(this.email()));

  readonly minted = signal<MintedInviteLink | null>(null);
  readonly qrDataUrl = signal<string | null>(null);

  ngOnInit(): void {
    void this.load();
    void this.loadMailStatus();
  }

  /** Non-fatal: unknown reads as "off", which only disables the email field. */
  private async loadMailStatus(): Promise<void> {
    try {
      const view = await firstValueFrom(this.mailApi.get());
      this.mailEnabled.set(view.effectiveTransport !== 'off');
    } catch {
      this.mailEnabled.set(false);
    }
  }

  /** The disabled email field's way out: close the dialog, open Email delivery. */
  setUpEmail(): void {
    this.closeDialog();
    revealSettingsGroup('email-delivery');
  }

  async load(): Promise<void> {
    this.loading.set(true);
    try {
      const res = await firstValueFrom(this.api.list());
      this.invites.set(res.invites);
      this.error.set(null);
    } catch (err) {
      this.error.set(httpErrorMessageI18n(err, this.i18n, this.i18n.t('invites.loadFailed')));
    } finally {
      this.loading.set(false);
    }
  }

  openDialog(): void {
    this.role.set('user');
    this.expiresInHours.set(168);
    this.maxUses.set(1);
    this.note.set('');
    this.email.set('');
    this.minted.set(null);
    this.qrDataUrl.set(null);
    this.dialogOpen.set(true);
  }

  closeDialog(): void {
    this.dialogOpen.set(false);
    this.minted.set(null);
    this.qrDataUrl.set(null);
  }

  /** `[ngValue]` hands back the option's number; anything else is ignored. */
  setExpiry(value: unknown): void {
    const hours = INVITE_EXPIRY_OPTIONS.find((h) => h === Number(value));
    if (hours !== undefined) this.expiresInHours.set(hours);
  }

  validUses(): boolean {
    // An emailed invite is single-use; the uses field is disabled then.
    if (this.sendsEmail()) return true;
    const n = this.maxUses();
    return Number.isInteger(n) && n >= 1 && n <= MAX_INVITE_USES;
  }

  /** The submit mails the link only with mail on and an address typed. */
  sendsEmail(): boolean {
    return this.mailEnabled() && this.emailGiven();
  }

  canCreate(): boolean {
    return !this.creating() && this.validUses() && (!this.sendsEmail() || this.emailValid());
  }

  async create(): Promise<void> {
    if (!this.canCreate()) return;
    this.creating.set(true);
    try {
      const note = this.note().trim();
      const email = this.sendsEmail() ? this.email().trim() : '';
      const res = await firstValueFrom(
        this.api.create({
          role: this.role(),
          expiresInHours: this.expiresInHours(),
          maxUses: email ? 1 : this.maxUses(),
          ...(note ? { note } : {}),
          ...(email ? { email } : {}),
        }),
      );
      await this.showLink(res);
      await this.load();
    } catch (err) {
      this.error.set(httpErrorMessageI18n(err, this.i18n, this.i18n.t('invites.createFailed')));
      this.dialogOpen.set(false);
    } finally {
      this.creating.set(false);
    }
  }

  /** New link for a pending invite, shown in the same result dialog. */
  async newLink(invite: InviteSummary): Promise<void> {
    const ok = await this.confirm.ask(this.i18n.t('invites.newLinkConfirm'));
    if (!ok) return;
    try {
      const res = await firstValueFrom(this.api.rotateLink(invite.id));
      this.dialogOpen.set(true);
      await this.showLink(res);
    } catch (err) {
      this.error.set(httpErrorMessageI18n(err, this.i18n, this.i18n.t('invites.createFailed')));
    }
  }

  async revoke(invite: InviteSummary): Promise<void> {
    const ok = await this.confirm.ask(this.i18n.t('invites.revokeConfirm'));
    if (!ok) return;
    try {
      const res = await firstValueFrom(this.api.revoke(invite.id));
      this.invites.update((list) => list.map((i) => (i.id === invite.id ? res.invite : i)));
    } catch (err) {
      this.error.set(httpErrorMessageI18n(err, this.i18n, this.i18n.t('invites.revokeFailed')));
    }
  }

  copyLink(): void {
    const minted = this.minted();
    if (!minted) return;
    navigator.clipboard?.writeText(minted.link).catch(() => {});
    this.toast.show({ message: this.i18n.t('invites.linkCopied'), kind: 'success' });
  }

  private async showLink(res: InviteLinkResponse): Promise<void> {
    const { link, localOnly } = buildInviteLink(res.urls, res.path, window.location.origin);
    this.minted.set({
      link,
      localOnly,
      expiresAt: res.invite.expiresAt,
      ...(res.mail && res.invite.email ? { email: res.invite.email, mail: res.mail } : {}),
    });
    this.qrDataUrl.set(await renderQrDataUrl(link));
  }

  /** Mailed and delivered: the dialog says so instead of showing the link. */
  mailSent(link: MintedInviteLink): boolean {
    return link.mail?.ok === true;
  }

  mailFailureKey(link: MintedInviteLink): string | null {
    const mail = link.mail;
    return mail && !mail.ok ? mailReasonKey(mail.reason) : null;
  }

  formatDate(ms: number): string {
    return new Date(ms).toLocaleString();
  }

  statusClass(status: InviteSummary['status']): string {
    return (
      'inline-block px-2 py-0.5 rounded text-xs font-medium border border-theme ' +
      (status === 'pending' ? 'status-done' : 'bg-theme-surface-2 text-theme-muted')
    );
  }
}
