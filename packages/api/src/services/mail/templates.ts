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

/**
 * "Confirm your email" (increment 5): the address only lands on the account
 * once this link is opened, and only a confirmed address can receive a reset link.
 */
export function verifyEmail(opts: {
  serverName: string;
  username: string;
  link: string;
}): RenderedMail {
  const subject = oneLine(`Confirm your email for ${opts.serverName}`);
  const text = [
    `Hi ${opts.username},`,
    '',
    `Confirm this address for your account on the NicotinD server "${opts.serverName}":`,
    opts.link,
    '',
    'The link works once and expires in 24 hours. Once confirmed, password reset links can be sent here.',
    '',
    "If you didn't ask for this, ignore it — nothing changes until the link is opened.",
  ].join('\n');
  const html = layout(
    subject,
    [
      `<p style="margin:0 0 12px;">Hi ${escapeHtml(opts.username)},</p>`,
      `<p style="margin:0 0 12px;">Confirm this address for your account on the NicotinD server <strong>${escapeHtml(opts.serverName)}</strong>.</p>`,
      button(opts.link, 'Confirm my email'),
      '<p style="margin:0 0 4px;">Or open this link:</p>',
      `<p style="margin:0 0 12px;word-break:break-all;"><code>${escapeHtml(opts.link)}</code></p>`,
      '<p style="margin:0 0 12px;">The link works once and expires in 24 hours. Once confirmed, password reset links can be sent here.</p>',
      `<p style="margin:0;color:#71717a;font-size:13px;">If you didn't ask for this, ignore it — nothing changes until the link is opened.</p>`,
    ].join(''),
  );
  return { subject, text, html };
}

/** "Reset your password": the forgot-password flow (30 min) and the admin's *Email reset link* (24 h). */
export function resetEmail(opts: {
  serverName: string;
  username: string;
  link: string;
  /** How long the link lives, already worded: "30 minutes", "24 hours". */
  expiresIn: string;
}): RenderedMail {
  const subject = oneLine(`Reset your password for ${opts.serverName}`);
  const text = [
    `Hi ${opts.username},`,
    '',
    `Someone asked to reset the password of your account on the NicotinD server "${opts.serverName}".`,
    'Open this link to choose a new one:',
    opts.link,
    '',
    `The link works once and expires in ${opts.expiresIn}. Setting a new password signs you out everywhere else.`,
    '',
    "If it wasn't you, ignore this email — your password stays as it is.",
  ].join('\n');
  const html = layout(
    subject,
    [
      `<p style="margin:0 0 12px;">Hi ${escapeHtml(opts.username)},</p>`,
      `<p style="margin:0 0 12px;">Someone asked to reset the password of your account on the NicotinD server <strong>${escapeHtml(opts.serverName)}</strong>.</p>`,
      button(opts.link, 'Choose a new password'),
      '<p style="margin:0 0 4px;">Or open this link:</p>',
      `<p style="margin:0 0 12px;word-break:break-all;"><code>${escapeHtml(opts.link)}</code></p>`,
      `<p style="margin:0 0 12px;">The link works once and expires in ${escapeHtml(opts.expiresIn)}. Setting a new password signs you out everywhere else.</p>`,
      `<p style="margin:0;color:#71717a;font-size:13px;">If it wasn't you, ignore this email — your password stays as it is.</p>`,
    ].join(''),
  );
  return { subject, text, html };
}

/**
 * "Your password was changed" — no link on purpose: a notice that could be
 * phished into "click here to undo" is worse than none.
 */
export function passwordChangedEmail(opts: {
  serverName: string;
  username: string;
  at: number;
}): RenderedMail {
  const when = formatUtc(opts.at);
  const subject = oneLine(`Your password for ${opts.serverName} was changed`);
  const text = [
    `Hi ${opts.username},`,
    '',
    `The password of your account on the NicotinD server "${opts.serverName}" was changed on ${when}.`,
    'Every other device was signed out.',
    '',
    "If this wasn't you, contact your server admin right away.",
  ].join('\n');
  const html = layout(
    subject,
    [
      `<p style="margin:0 0 12px;">Hi ${escapeHtml(opts.username)},</p>`,
      `<p style="margin:0 0 12px;">The password of your account on the NicotinD server <strong>${escapeHtml(opts.serverName)}</strong> was changed on ${escapeHtml(when)}. Every other device was signed out.</p>`,
      `<p style="margin:0;color:#71717a;font-size:13px;">If this wasn't you, contact your server admin right away.</p>`,
    ].join(''),
  );
  return { subject, text, html };
}
