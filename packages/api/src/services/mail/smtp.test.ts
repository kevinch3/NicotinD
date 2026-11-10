import { describe, expect, it } from 'bun:test';
import { classifySmtpError, createSmtpTransport } from './smtp.js';
import { startFakeSmtpServer } from '../../test-helpers/fake-smtp-server.js';

const err = (fields: Record<string, unknown>) => Object.assign(new Error('x'), fields);

describe('classifySmtpError', () => {
  it.each([530, 534, 535])('%i is auth', (code) => {
    expect(
      classifySmtpError(err({ code: 'EAUTH', responseCode: code, command: 'AUTH PLAIN' })),
    ).toBe('auth');
  });

  it('EAUTH with no reply code is still auth', () => {
    expect(classifySmtpError(err({ code: 'EAUTH' }))).toBe('auth');
  });

  it.each([550, 551, 553])('%i at RCPT TO is recipient-rejected', (code) => {
    expect(
      classifySmtpError(err({ code: 'EENVELOPE', responseCode: code, command: 'RCPT TO' })),
    ).toBe('recipient-rejected');
  });

  it.each([550, 551, 553])('%i at MAIL FROM is sender-rejected', (code) => {
    expect(
      classifySmtpError(err({ code: 'EENVELOPE', responseCode: code, command: 'MAIL FROM' })),
    ).toBe('sender-rejected');
  });

  it('a 550 outside the envelope phases is unknown, not a guess', () => {
    expect(classifySmtpError(err({ code: 'EMESSAGE', responseCode: 550, command: 'DATA' }))).toBe(
      'unknown',
    );
  });

  it.each([421, 450, 451, 452])('%i is rate-limited', (code) => {
    expect(classifySmtpError(err({ responseCode: code, command: 'RCPT TO' }))).toBe('rate-limited');
  });

  it.each(['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'ESOCKET', 'ECONNECTION', 'EDNS'])(
    '%s is unreachable',
    (code) => {
      expect(classifySmtpError(err({ code }))).toBe('unreachable');
    },
  );

  it('the reply code wins over the transport code', () => {
    // nodemailer tags a refused greeting EPROTOCOL; the 421 is what it means.
    expect(classifySmtpError(err({ code: 'EPROTOCOL', responseCode: 421, command: 'CONN' }))).toBe(
      'rate-limited',
    );
  });

  it.each([[null], [undefined], ['boom'], [err({ code: 'EWHAT', responseCode: 554 })]])(
    'anything else is unknown (%p)',
    (value) => {
      expect(classifySmtpError(value)).toBe('unknown');
    },
  );
});

// A server that never offers STARTTLS (like an attacker stripping it) must not
// receive the credentials in plain text.
describe('createSmtpTransport — TLS with credentials', () => {
  it('refuses to send credentials or mail when the server offers no STARTTLS', async () => {
    const server = await startFakeSmtpServer();
    try {
      const transport = createSmtpTransport({
        host: '127.0.0.1',
        port: server.port,
        secure: false,
        username: 'postmaster@example.com',
        password: 'hunter2-secret',
        fromAddress: 'music@example.com',
        fromName: '',
        timeouts: { connectionMs: 2000, greetingMs: 2000, socketMs: 2000 },
      });
      const result = await transport.send({
        to: 'friend@example.com',
        subject: 's',
        text: 't',
        html: '<p>t</p>',
      });
      expect(result.ok).toBe(false);
      expect(server.received).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it('still relays without TLS when no credentials are configured', async () => {
    const server = await startFakeSmtpServer();
    try {
      const transport = createSmtpTransport({
        host: '127.0.0.1',
        port: server.port,
        secure: false,
        username: '',
        password: '',
        fromAddress: 'music@example.com',
        fromName: '',
        timeouts: { connectionMs: 2000, greetingMs: 2000, socketMs: 2000 },
      });
      const result = await transport.send({
        to: 'friend@example.com',
        subject: 's',
        text: 't',
        html: '<p>t</p>',
      });
      expect(result.ok).toBe(true);
      expect(server.received).toHaveLength(1);
    } finally {
      await server.close();
    }
  });
});
