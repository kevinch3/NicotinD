import { describe, expect, it } from 'bun:test';
import { MAIL_PRESETS, findMailPreset } from './presets.js';

describe('MAIL_PRESETS', () => {
  it('has unique ids, and a help key named after each id', () => {
    const ids = MAIL_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of MAIL_PRESETS) expect(p.helpKey).toBe(`admin.email.presetHelp.${p.id}`);
  });

  it('pairs port 465 with implicit TLS and every other port with STARTTLS', () => {
    for (const p of MAIL_PRESETS) expect(p.secure, p.id).toBe(p.port === 465);
  });

  it('Resend: smtp.resend.com over implicit TLS, username "resend"', () => {
    expect(findMailPreset('resend')).toMatchObject({
      label: 'Resend',
      host: 'smtp.resend.com',
      port: 465,
      secure: true,
      usernameHint: 'resend',
      username: 'resend',
    });
  });

  it('only a provider with one username for everyone carries it', () => {
    const fixed = MAIL_PRESETS.filter((p) => p.username !== undefined).map((p) => p.id);
    expect(fixed).toEqual(['resend']);
  });
});
