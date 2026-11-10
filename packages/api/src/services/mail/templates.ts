/**
 * Mail templates rendered by core (docs/email-invitations.md): plain text plus a
 * simple inline-styled HTML part. No external assets, no tracking pixels, no
 * remote fonts — a mail client should render it offline, and nothing in it
 * phones home. Every interpolated value goes through `escapeHtml`.
 */
import type { MailMessage } from './transport.js';

export type RenderedMail = Omit<MailMessage, 'to'>;

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** One-column card, the only layout these mails need. */
function layout(title: string, bodyHtml: string): string {
  return [
    '<!doctype html>',
    '<html><body style="margin:0;padding:24px;background:#f4f4f5;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#18181b;">',
    '<div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:12px;padding:24px;">',
    `<h1 style="font-size:18px;margin:0 0 16px;">${escapeHtml(title)}</h1>`,
    bodyHtml,
    '</div></body></html>',
  ].join('');
}

function button(href: string, label: string): string {
  return `<p style="margin:24px 0;"><a href="${escapeHtml(href)}" style="display:inline-block;background:#18181b;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;">${escapeHtml(label)}</a></p>`;
}

/**
 * "Send test email": proves the transport delivers *and* that the link base
 * opens — the link is `<linkBase>/`, so a dead base shows up here, before a
 * friend's invite does.
 */
export function testEmail(opts: { serverName: string; linkBase: string }): RenderedMail {
  const link = `${opts.linkBase.replace(/\/+$/, '')}/`;
  const subject = `Test email from ${opts.serverName}`;
  const text = [
    `This is a test email from your NicotinD server "${opts.serverName}".`,
    '',
    'If you can read this, email delivery works.',
    '',
    'Links in invites and password resets will point to:',
    link,
    '',
    'Open it to check that it reaches your server from where you are.',
  ].join('\n');
  const html = layout(
    subject,
    [
      `<p style="margin:0 0 12px;">This is a test email from your NicotinD server <strong>${escapeHtml(opts.serverName)}</strong>.</p>`,
      '<p style="margin:0 0 12px;">If you can read this, email delivery works.</p>',
      '<p style="margin:0 0 4px;">Links in invites and password resets will point to:</p>',
      `<p style="margin:0;word-break:break-all;"><code>${escapeHtml(link)}</code></p>`,
      button(link, 'Open your server'),
      '<p style="margin:0;color:#71717a;font-size:13px;">Open it to check that it reaches your server from where you are.</p>',
    ].join(''),
  );
  return { subject, text, html };
}

/** Header-safe: a subject is one line, whatever a name in it contains. */
function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

/** "12 Nov 2026, 14:05 UTC" — the mail is read in the recipient's zone, which core cannot know. */
export function formatUtc(ms: number): string {
  const d = new Date(ms);
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/**
 * An emailed invite (increment 4): who invited you, where, at which role, until
 * when — and the one link that creates the account. Accepting it also verifies
 * this address, so the mail says the account will carry it.
 */
export function inviteEmail(opts: {
  serverName: string;
  inviterName: string;
  role: string;
  link: string;
  expiresAt: number;
}): RenderedMail {
  const role = opts.role;
  const expires = formatUtc(opts.expiresAt);
  const subject = oneLine(`${opts.inviterName} invited you to ${opts.serverName}`);
  const text = [
    `${opts.inviterName} invited you to their NicotinD music server "${opts.serverName}" as a ${role}.`,
    '',
    'Open this link to choose a username and password:',
    opts.link,
    '',
    `The link works once and expires on ${expires}.`,
    'Your account will use this email address, so you can reset your password later.',
    '',
    "If you weren't expecting this, you can ignore it.",
  ].join('\n');
  const html = layout(
    subject,
    [
      `<p style="margin:0 0 12px;"><strong>${escapeHtml(opts.inviterName)}</strong> invited you to their NicotinD music server <strong>${escapeHtml(opts.serverName)}</strong> as a ${escapeHtml(role)}.</p>`,
      button(opts.link, 'Accept the invite'),
      '<p style="margin:0 0 4px;">Or open this link:</p>',
      `<p style="margin:0 0 12px;word-break:break-all;"><code>${escapeHtml(opts.link)}</code></p>`,
      `<p style="margin:0 0 12px;">The link works once and expires on ${escapeHtml(expires)}. Your account will use this email address, so you can reset your password later.</p>`,
      `<p style="margin:0;color:#71717a;font-size:13px;">If you weren't expecting this, you can ignore it.</p>`,
    ].join(''),
  );
  return { subject, text, html };
}
