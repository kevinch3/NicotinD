import { describe, expect, it } from 'bun:test';
import {
  escapeHtml,
  formatUtc,
  inviteEmail,
  passwordChangedEmail,
  resetEmail,
  testEmail,
  verifyEmail,
} from './templates.js';

describe('testEmail', () => {
  it('links to the base so the admin can check it opens', () => {
    const mail = testEmail({ serverName: 'den', linkBase: 'https://music.example.com' });
    expect(mail.subject).toBe('Test email from den');
    expect(mail.text).toContain('https://music.example.com/');
    expect(mail.html).toContain('href="https://music.example.com/"');
  });

  it('does not double the slash on a base that already ends in one', () => {
    const mail = testEmail({ serverName: 'den', linkBase: 'https://music.example.com/' });
    expect(mail.text).toContain('https://music.example.com/\n');
    expect(mail.text).not.toContain('.com//');
  });

  it('HTML-escapes every interpolated value', () => {
    const mail = testEmail({
      serverName: '<script>alert(1)</script>',
      linkBase: 'https://x.example.com/"><img src=x onerror=alert(1)>',
    });
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).not.toContain('<img');
    expect(mail.html).toContain('&lt;script&gt;');
    expect(mail.html).toContain('&quot;&gt;&lt;img');
  });

  it('loads nothing remote — no images, stylesheets or tracking', () => {
    const { html } = testEmail({ serverName: 'den', linkBase: 'https://music.example.com' });
    expect(html).not.toMatch(/<img|<link|<script|url\(/i);
  });
});

describe('escapeHtml', () => {
  it('escapes the five specials', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });
});

describe('inviteEmail', () => {
  const opts = {
    serverName: 'den',
    inviterName: 'boss',
    role: 'listener',
    link: 'https://music.example.com/invite#t=TOKEN',
    expiresAt: Date.UTC(2026, 10, 17, 14, 5),
  };

  it('names the inviter, server, role and expiry, and carries the link in both parts', () => {
    const mail = inviteEmail(opts);
    expect(mail.subject).toBe('boss invited you to den');
    expect(mail.text).toContain('"den" as a listener');
    expect(mail.text).toContain(opts.link);
    expect(mail.text).toContain('17 Nov 2026, 14:05 UTC');
    expect(mail.html).toContain(`href="${opts.link}"`);
  });

  it('HTML-escapes names and keeps the subject to one line', () => {
    const mail = inviteEmail({ ...opts, inviterName: '<b>evil</b>\r\nBcc: x@y.z' });
    expect(mail.html).not.toContain('<b>evil');
    expect(mail.html).toContain('&lt;b&gt;evil');
    expect(mail.subject).not.toMatch(/[\r\n]/);
  });

  it('loads nothing remote', () => {
    expect(inviteEmail(opts).html).not.toMatch(/<img|<link|<script|url\(/i);
  });
});

describe('formatUtc', () => {
  it('pads hours and minutes', () => {
    expect(formatUtc(Date.UTC(2026, 0, 2, 3, 4))).toBe('2 Jan 2026, 03:04 UTC');
  });
});

describe('increment 5 templates', () => {
  const link = 'https://music.example.com/x#t=TOKEN';
  const evil = '<i>x</i>\nBcc: a@b.c';

  it('verifyEmail and resetEmail carry the link in both parts and escape names', () => {
    for (const mail of [
      verifyEmail({ serverName: evil, username: evil, link }),
      resetEmail({ serverName: evil, username: evil, link, expiresIn: '30 minutes' }),
    ]) {
      expect(mail.text).toContain(link);
      expect(mail.html).toContain(`href="${link}"`);
      expect(mail.html).not.toContain('<i>x');
      expect(mail.subject).not.toMatch(/[\r\n]/);
      expect(mail.html).not.toMatch(/<img|<link|<script|url\(/i);
    }
    expect(
      resetEmail({ serverName: 'den', username: 'sam', link, expiresIn: '30 minutes' }).text,
    ).toContain('expires in 30 minutes');
  });

  it('passwordChangedEmail says when, and carries no link at all', () => {
    const mail = passwordChangedEmail({
      serverName: 'den',
      username: 'sam',
      at: Date.UTC(2026, 10, 10, 9, 30),
    });
    expect(mail.subject).toBe('Your password for den was changed');
    expect(mail.text).toContain('10 Nov 2026, 09:30 UTC');
    expect(mail.text).not.toMatch(/https?:\/\//);
    expect(mail.html).not.toContain('href=');
  });
});
