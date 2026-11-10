import { describe, expect, it } from 'bun:test';
import { escapeHtml, testEmail } from './templates.js';

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
