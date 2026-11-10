/**
 * Provider presets — data, not code (docs/email-invitations.md). A preset only
 * pre-fills host, port and TLS mode and names the help text; every provider is
 * reached through the same SMTP transport. Adding a provider is one entry here,
 * its `helpKey` in both i18n catalogs, and a docs line.
 */

export interface MailPreset {
  id: string;
  label: string;
  host: string;
  port: number;
  secure: boolean;
  /** What the provider expects in the username field, shown as a placeholder. */
  usernameHint: string;
  /** i18n key of the one-paragraph help shown under the preset select. */
  helpKey: string;
}

export const MAIL_PRESETS: readonly MailPreset[] = [
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
    id: 'brevo',
    label: 'Brevo',
    host: 'smtp-relay.brevo.com',
    port: 587,
    secure: false,
    usernameHint: 'the Login shown under SMTP & API → SMTP',
    helpKey: 'admin.email.presetHelp.brevo',
  },
  {
    id: 'gmail',
    label: 'Gmail',
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    usernameHint: 'you@gmail.com',
    helpKey: 'admin.email.presetHelp.gmail',
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

export const MAIL_PRESET_IDS: readonly string[] = MAIL_PRESETS.map((p) => p.id);

export function findMailPreset(id: string): MailPreset | undefined {
  return MAIL_PRESETS.find((p) => p.id === id);
}
