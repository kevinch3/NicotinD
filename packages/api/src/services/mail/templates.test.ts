import { describe, expect, it } from 'bun:test';
import {
  escapeHtml,
  noAutolink,
  formatDuration,
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
      resetEmail({ serverName: evil, username: evil, link, ttlMs: 30 * 60_000 }),
    ]) {
      expect(mail.text).toContain(link);
      expect(mail.html).toContain(`href="${link}"`);
      expect(mail.html).not.toContain('<i>x');
      expect(mail.subject).not.toMatch(/[\r\n]/);
      expect(mail.html).not.toMatch(/<img|<link|<script|url\(/i);
    }
    expect(
      resetEmail({ serverName: 'den', username: 'sam', link, ttlMs: 30 * 60_000 }).text,
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

describe('brand and language', () => {
  const link = 'https://music.example.com/x#t=TOKEN';
  const all = (lang?: 'en' | 'es') => [
    testEmail({ serverName: 'den', linkBase: 'https://music.example.com', lang }),
    inviteEmail({
      serverName: 'den',
      inviterName: 'boss',
      role: 'refiner',
      link,
      expiresAt: Date.UTC(2026, 0, 5, 8, 0),
      lang,
    }),
    verifyEmail({ serverName: 'den', username: 'sam', link, lang }),
    resetEmail({ serverName: 'den', username: 'sam', link, ttlMs: 24 * 3_600_000, lang }),
    passwordChangedEmail({ serverName: 'den', username: 'sam', at: 0, lang }),
  ];

  it('every mail carries the brand header, its language and a footer naming the server', () => {
    for (const mail of all('es')) {
      expect(mail.html).toContain('<html lang="es">');
      expect(mail.html).toContain('>NicotinD</td>');
      expect(mail.html).toContain('#6366f1');
      expect(mail.html).toContain('Enviado por den, un servidor de música NicotinD.');
      expect(mail.text.endsWith('Enviado por den, un servidor de música NicotinD.')).toBe(true);
      expect(mail.html).not.toMatch(/<img|<link|<script|url\(/i);
    }
    for (const mail of all()) expect(mail.html).toContain('<html lang="en">');
  });

  it('Spanish wording: subject, role, month and duration', () => {
    const [test, invite, verify, reset, changed] = all('es');
    expect(test!.subject).toBe('Correo de prueba de den');
    expect(invite!.subject).toBe('boss te invitó a den');
    expect(invite!.text).toContain('como curador.');
    expect(invite!.text).toContain('vence el 5 ene 2026, 08:00 UTC');
    expect(verify!.html).toContain('Confirmar mi correo');
    expect(reset!.text).toContain('vence en 24 horas');
    expect(changed!.subject).toBe('Se cambió tu contraseña de den');
  });

  it('English names the refiner role as the app does', () => {
    expect(all()[1]!.text).toContain('as a refiner.');
  });

  it('an unknown role is shown as stored rather than dropped', () => {
    const mail = inviteEmail({
      serverName: 'den',
      inviterName: 'boss',
      role: 'dj',
      link,
      expiresAt: 0,
      lang: 'es',
    });
    expect(mail.text).toContain('como dj.');
  });

  it('formatDuration: whole hours as hours, else minutes, singular for one', () => {
    expect(formatDuration(30 * 60_000)).toBe('30 minutes');
    expect(formatDuration(24 * 3_600_000)).toBe('24 hours');
    expect(formatDuration(3_600_000, 'es')).toBe('1 hora');
    expect(formatDuration(90 * 60_000, 'es')).toBe('90 minutos');
  });
});

describe('Gmail rendering', () => {
  const server = 'nicotined.kevinroberts.ar';
  const mails = () => [
    testEmail({ serverName: server, linkBase: 'https://nicotined.kevinroberts.ar' }),
    inviteEmail({
      serverName: server,
      inviterName: 'boss',
      role: 'listener',
      link: 'https://nicotined.kevinroberts.ar/invite#t=T',
      expiresAt: 0,
    }),
    passwordChangedEmail({ serverName: server, username: 'sam', at: 0 }),
  ];

  it('draws the play mark with CSS, never a glyph Gmail swaps for an emoji', () => {
    for (const { html } of mails()) {
      expect(html).not.toMatch(/&#9654;|&#x25b6;|▶/i);
      expect(html).toContain('border-left:11px solid #f4f4f5');
    }
  });

  it('never shows the server name as a bare domain, so Gmail does not link it', () => {
    for (const { html } of mails()) {
      // Visible text only: hrefs and the <title> may carry the real address.
      const visible = html
        .replace(/<title>.*?<\/title>/, '')
        .replace(/href="[^"]*"/g, '')
        .replace(/<code[^>]*>.*?<\/code>/g, '');
      expect(visible).not.toContain(server);
      expect(visible).toContain('nicotined.&#8288;kevinroberts.&#8288;ar');
    }
  });

  it('leaves the text part and the real links untouched', () => {
    const [test] = mails();
    expect(test!.text).toContain('"nicotined.kevinroberts.ar"');
    expect(test!.html).toContain('href="https://nicotined.kevinroberts.ar/"');
  });

  it('noAutolink escapes first, and only breaks dots inside a word', () => {
    expect(noAutolink('<a.b>')).toBe('&lt;a.&#8288;b&gt;');
    expect(noAutolink('Done.')).toBe('Done.');
  });
});
