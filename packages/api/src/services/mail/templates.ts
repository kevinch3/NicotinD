/**
 * Mail templates rendered by core (docs/email-invitations.md): plain text plus an
 * inline-styled HTML part in the app's brand, in the recipient's language
 * (`strings.ts`, chosen by `mailLangOf`). No external assets, no tracking pixels,
 * no remote fonts — a mail client should render it offline, and nothing in it
 * phones home; the brand mark is drawn with a table cell and a glyph, not an
 * image. Every interpolated value goes through `escapeHtml`.
 */
import type { PreferenceLang } from '@nicotind/core';
import type { MailMessage } from './transport.js';
import { MAIL_STRINGS, type MailStrings } from './strings.js';

export type RenderedMail = Omit<MailMessage, 'to'>;

/** The app icon's colours (packages/web/public/icons/icon.svg) and the theme's second accent. */
const BRAND = {
  ink: '#09090b',
  accent: '#6366f1',
  accent2: '#f0806a',
  onInk: '#f4f4f5',
  text: '#18181b',
  muted: '#71717a',
  page: '#f4f4f5',
  rule: '#e4e4e7',
};
const FONT = "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const strong = (value: string) => `<strong>${escapeHtml(value)}</strong>`;
const p = (html: string, style = 'margin:0 0 14px;') => `<p style="${style}">${html}</p>`;
const note = (html: string) => p(html, `margin:0;color:${BRAND.muted};font-size:13px;`);

/** Header-safe: a subject is one line, whatever a name in it contains. */
function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

function stringsFor(lang: PreferenceLang | undefined): MailStrings {
  return MAIL_STRINGS[lang ?? 'en'] ?? MAIL_STRINGS.en;
}

/**
 * The branded card: a dark header with the play mark and the wordmark, a two-tone
 * accent rule, the body, and a footer naming the server. Tables, because the
 * mail clients that ignore `max-width` on a div still honour it on a table.
 */
function layout(opts: {
  lang: PreferenceLang;
  title: string;
  preheader: string;
  serverName: string;
  footer: string;
  bodyHtml: string;
}): string {
  const table = 'role="presentation" cellpadding="0" cellspacing="0" border="0"';
  return [
    '<!doctype html>',
    `<html lang="${opts.lang}"><head><meta charset="utf-8">`,
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="color-scheme" content="light only">',
    `<title>${escapeHtml(opts.title)}</title></head>`,
    `<body style="margin:0;padding:0;background:${BRAND.page};">`,
    // The inbox preview line, hidden in the opened mail.
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(opts.preheader)}</div>`,
    `<table ${table} width="100%" style="background:${BRAND.page};"><tr><td align="center" style="padding:24px 12px;">`,
    `<table ${table} width="100%" style="max-width:520px;background:#ffffff;border-radius:16px;overflow:hidden;font-family:${FONT};color:${BRAND.text};font-size:15px;line-height:1.5;">`,
    `<tr><td style="background:${BRAND.ink};padding:18px 24px;">`,
    `<table ${table} width="100%"><tr>`,
    `<td width="32" style="width:32px;height:32px;background:${BRAND.accent};border-radius:16px;text-align:center;vertical-align:middle;color:${BRAND.onInk};font-size:12px;line-height:32px;">&#9654;&#xFE0E;</td>`,
    `<td style="padding-left:10px;color:${BRAND.onInk};font-size:17px;font-weight:700;letter-spacing:0.2px;">NicotinD</td>`,
    `<td align="right" style="color:#a1a1aa;font-size:13px;">${escapeHtml(opts.serverName)}</td>`,
    '</tr></table></td></tr>',
    `<tr><td style="padding:0;font-size:0;line-height:0;"><table ${table} width="100%"><tr>`,
    `<td width="70%" style="height:3px;background:${BRAND.accent};"></td><td style="height:3px;background:${BRAND.accent2};"></td>`,
    '</tr></table></td></tr>',
    `<tr><td style="padding:28px 24px 12px;">`,
    `<h1 style="font-size:20px;line-height:1.3;margin:0 0 16px;">${escapeHtml(opts.title)}</h1>`,
    opts.bodyHtml,
    '</td></tr>',
    `<tr><td style="padding:16px 24px 22px;border-top:1px solid ${BRAND.rule};color:${BRAND.muted};font-size:12px;">${escapeHtml(opts.footer)}</td></tr>`,
    '</table></td></tr></table></body></html>',
  ].join('');
}

function button(href: string, label: string): string {
  return `<p style="margin:24px 0;"><a href="${escapeHtml(href)}" style="display:inline-block;background:${BRAND.accent};color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600;">${escapeHtml(label)}</a></p>`;
}

/** The link spelled out under the button, for a client that strips buttons. */
function linkBlock(t: MailStrings, href: string): string {
  return [
    p(escapeHtml(t.orOpen), 'margin:0 0 4px;'),
    p(
      `<code style="font-size:13px;background:${BRAND.page};padding:2px 4px;border-radius:4px;">${escapeHtml(href)}</code>`,
      'margin:0 0 14px;word-break:break-all;',
    ),
  ].join('');
}

/** The text part: paragraphs, then the footer under a rule. */
function textBody(t: MailStrings, serverName: string, lines: string[]): string {
  return [...lines, '', '—', t.footer(serverName)].join('\n');
}

/** "12 Nov 2026, 14:05 UTC" — the mail is read in the recipient's zone, which core cannot know. */
export function formatUtc(ms: number, lang?: PreferenceLang): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  const month = stringsFor(lang).months[d.getUTCMonth()];
  return `${d.getUTCDate()} ${month} ${d.getUTCFullYear()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/** A link lifetime in words: whole hours when it is a whole number of hours, else minutes. */
export function formatDuration(ms: number, lang?: PreferenceLang): string {
  const t = stringsFor(lang);
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return minutes % 60 === 0 ? t.hours(String(minutes / 60)) : t.minutes(String(minutes));
}

/**
 * "Send test email": proves the transport delivers *and* that the link base
 * opens — the link is `<linkBase>/`, so a dead base shows up here, before a
 * friend's invite does.
 */
export function testEmail(opts: {
  serverName: string;
  linkBase: string;
  lang?: PreferenceLang;
}): RenderedMail {
  const lang = opts.lang ?? 'en';
  const t = stringsFor(lang);
  const link = `${opts.linkBase.replace(/\/+$/, '')}/`;
  const subject = oneLine(t.test.subject(opts.serverName));
  const text = textBody(t, opts.serverName, [
    t.test.intro(`"${opts.serverName}"`),
    '',
    t.test.works,
    '',
    t.test.linksTo,
    link,
    '',
    t.test.check,
  ]);
  const html = layout({
    lang,
    title: subject,
    preheader: t.test.works,
    serverName: opts.serverName,
    footer: t.footer(opts.serverName),
    bodyHtml: [
      p(t.test.intro(strong(opts.serverName))),
      p(escapeHtml(t.test.works)),
      p(escapeHtml(t.test.linksTo), 'margin:0 0 4px;'),
      p(`<code>${escapeHtml(link)}</code>`, 'margin:0;word-break:break-all;'),
      button(link, t.test.button),
      note(escapeHtml(t.test.check)),
    ].join(''),
  });
  return { subject, text, html };
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
  lang?: PreferenceLang;
}): RenderedMail {
  const lang = opts.lang ?? 'en';
  const t = stringsFor(lang);
  const role = (t.roles as Record<string, string>)[opts.role] ?? opts.role;
  const expires = formatUtc(opts.expiresAt, lang);
  const subject = oneLine(t.invite.subject(opts.inviterName, opts.serverName));
  const intro = t.invite.intro(opts.inviterName, `"${opts.serverName}"`, role);
  const text = textBody(t, opts.serverName, [
    intro,
    '',
    t.invite.choose,
    opts.link,
    '',
    t.invite.expiry(expires),
    t.invite.keepsEmail,
    '',
    t.invite.ignore,
  ]);
  const html = layout({
    lang,
    title: subject,
    preheader: oneLine(intro),
    serverName: opts.serverName,
    footer: t.footer(opts.serverName),
    bodyHtml: [
      p(t.invite.intro(strong(opts.inviterName), strong(opts.serverName), escapeHtml(role))),
      button(opts.link, t.invite.button),
      linkBlock(t, opts.link),
      p(`${escapeHtml(t.invite.expiry(expires))} ${escapeHtml(t.invite.keepsEmail)}`),
      note(escapeHtml(t.invite.ignore)),
    ].join(''),
  });
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
  lang?: PreferenceLang;
}): RenderedMail {
  const lang = opts.lang ?? 'en';
  const t = stringsFor(lang);
  const subject = oneLine(t.verify.subject(opts.serverName));
  const text = textBody(t, opts.serverName, [
    t.hi(opts.username),
    '',
    t.verify.intro(`"${opts.serverName}"`),
    opts.link,
    '',
    t.verify.expiry,
    '',
    t.verify.ignore,
  ]);
  const html = layout({
    lang,
    title: subject,
    preheader: oneLine(t.verify.intro(opts.serverName)),
    serverName: opts.serverName,
    footer: t.footer(opts.serverName),
    bodyHtml: [
      p(escapeHtml(t.hi(opts.username))),
      p(t.verify.intro(strong(opts.serverName))),
      button(opts.link, t.verify.button),
      linkBlock(t, opts.link),
      p(escapeHtml(t.verify.expiry)),
      note(escapeHtml(t.verify.ignore)),
    ].join(''),
  });
  return { subject, text, html };
}

/** "Reset your password": the forgot-password flow (30 min) and the admin's *Email reset link* (24 h). */
export function resetEmail(opts: {
  serverName: string;
  username: string;
  link: string;
  /** How long the link lives; worded in the mail's language by `formatDuration`. */
  ttlMs: number;
  lang?: PreferenceLang;
}): RenderedMail {
  const lang = opts.lang ?? 'en';
  const t = stringsFor(lang);
  const within = formatDuration(opts.ttlMs, lang);
  const subject = oneLine(t.reset.subject(opts.serverName));
  const text = textBody(t, opts.serverName, [
    t.hi(opts.username),
    '',
    t.reset.intro(`"${opts.serverName}"`),
    t.reset.choose,
    opts.link,
    '',
    t.reset.expiry(within),
    '',
    t.reset.ignore,
  ]);
  const html = layout({
    lang,
    title: subject,
    preheader: oneLine(t.reset.intro(opts.serverName)),
    serverName: opts.serverName,
    footer: t.footer(opts.serverName),
    bodyHtml: [
      p(escapeHtml(t.hi(opts.username))),
      p(t.reset.intro(strong(opts.serverName))),
      button(opts.link, t.reset.button),
      linkBlock(t, opts.link),
      p(escapeHtml(t.reset.expiry(within))),
      note(escapeHtml(t.reset.ignore)),
    ].join(''),
  });
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
  lang?: PreferenceLang;
}): RenderedMail {
  const lang = opts.lang ?? 'en';
  const t = stringsFor(lang);
  const when = formatUtc(opts.at, lang);
  const subject = oneLine(t.changed.subject(opts.serverName));
  const text = textBody(t, opts.serverName, [
    t.hi(opts.username),
    '',
    t.changed.intro(`"${opts.serverName}"`, when),
    t.changed.signedOut,
    '',
    t.changed.notYou,
  ]);
  const html = layout({
    lang,
    title: subject,
    preheader: oneLine(t.changed.intro(opts.serverName, when)),
    serverName: opts.serverName,
    footer: t.footer(opts.serverName),
    bodyHtml: [
      p(escapeHtml(t.hi(opts.username))),
      p(
        `${t.changed.intro(strong(opts.serverName), escapeHtml(when))} ${escapeHtml(t.changed.signedOut)}`,
      ),
      note(escapeHtml(t.changed.notYou)),
    ].join(''),
  });
  return { subject, text, html };
}
