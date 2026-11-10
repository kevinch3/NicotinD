/**
 * The contract every `MailTransport` must pass (docs/email-invitations.md,
 * increment 3): send ok, verify ok, and every failure reason that transport can
 * produce, reported as a `MailResult` rather than thrown. A future HTTP adapter
 * joins by adding one `runTransportContract` call.
 */
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../../db.js';
import {
  closedPort,
  startFakeSmtpServer,
  type FakeSmtpReplies,
  type FakeSmtpServer,
} from '../../test-helpers/fake-smtp-server.js';
import { createOutboxTransport, listOutbox } from './outbox.js';
import { createSmtpTransport, type SmtpConfig } from './smtp.js';
import type { MailFailure, MailMessage, MailTransport } from './transport.js';

const MESSAGE: MailMessage = {
  to: 'friend@example.com',
  subject: 'Hello',
  text: 'Plain body',
  html: '<p>HTML body</p>',
};

interface ContractHarness {
  /** A transport whose next send/verify succeeds. */
  healthy(): Promise<MailTransport>;
  /** Proof a successful send was delivered (the message as the far side saw it). */
  delivered(): Promise<string[]>;
  /** Per reason this transport can produce: a transport + message provoking it. */
  failures: Partial<
    Record<
      MailFailure,
      () => Promise<{ transport: MailTransport; msg?: MailMessage; verify?: boolean }>
    >
  >;
}

function runTransportContract(name: string, harness: () => ContractHarness) {
  describe(`MailTransport contract: ${name}`, () => {
    it('sends and reports ok', async () => {
      const h = harness();
      const result = await (await h.healthy()).send(MESSAGE);
      expect(result.ok).toBe(true);
      const seen = await h.delivered();
      expect(seen).toHaveLength(1);
      expect(seen[0]).toContain('Plain body');
    });

    it('verifies ok', async () => {
      const h = harness();
      expect(await (await h.healthy()).verify()).toEqual({ ok: true });
    });

    const reasons = Object.keys(harness().failures) as MailFailure[];
    it.each(reasons)('reports %s as a result, never a throw', async (reason) => {
      const h = harness();
      const { transport, msg = MESSAGE, verify = false } = await h.failures[reason]!();
      const result = verify ? await transport.verify() : await transport.send(msg);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe(reason);
        expect(typeof result.detail).toBe('string');
      }
    });
  });
}

// --- outbox -----------------------------------------------------------------

let db: Database;
beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
});

runTransportContract('outbox', () => ({
  healthy: async () => createOutboxTransport(db, () => 1000),
  delivered: async () => listOutbox(db).map((m) => `${m.subject}\n${m.text}\n${m.html}`),
  failures: {
    'recipient-rejected': async () => ({
      transport: createOutboxTransport(db),
      msg: { ...MESSAGE, to: 'not an address' },
    }),
  },
}));

// --- SMTP against the in-process fake server ---------------------------------

const servers: FakeSmtpServer[] = [];
afterAll(async () => {
  await Promise.all(servers.map((s) => s.close()));
});

async function serve(replies: FakeSmtpReplies = {}): Promise<FakeSmtpServer> {
  const server = await startFakeSmtpServer(replies);
  servers.push(server);
  return server;
}

function smtpFor(port: number, overrides: Partial<SmtpConfig> = {}): MailTransport {
  return createSmtpTransport({
    host: '127.0.0.1',
    port,
    secure: false,
    ignoreTLS: true,
    username: 'postmaster@example.com',
    password: 'hunter2',
    fromAddress: 'music@example.com',
    fromName: 'NicotinD',
    timeouts: { connectionMs: 2000, greetingMs: 2000, socketMs: 2000 },
    ...overrides,
  });
}

let lastHealthy: FakeSmtpServer | null = null;

runTransportContract('smtp (fake server)', () => ({
  healthy: async () => {
    lastHealthy = await serve();
    return smtpFor(lastHealthy.port);
  },
  delivered: async () => lastHealthy!.received.map((m) => m.data),
  failures: {
    auth: async () => ({
      transport: smtpFor((await serve({ auth: '535 5.7.8 Bad credentials' })).port),
    }),
    'sender-rejected': async () => ({
      transport: smtpFor((await serve({ mailFrom: '553 5.7.1 Sender not allowed' })).port),
    }),
    'recipient-rejected': async () => ({
      transport: smtpFor((await serve({ rcptTo: '550 5.1.1 No such user' })).port),
    }),
    'rate-limited': async () => ({
      transport: smtpFor((await serve({ greeting: '421 4.7.0 Try again later' })).port),
    }),
    unreachable: async () => ({ transport: smtpFor(await closedPort()) }),
    unknown: async () => ({
      transport: smtpFor((await serve({ dataEnd: '554 5.6.0 Message rejected' })).port),
    }),
  },
}));

describe('smtp transport specifics', () => {
  it('authenticates with the configured credentials and sends From with the display name', async () => {
    const server = await serve();
    const result = await smtpFor(server.port).send(MESSAGE);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.providerId).toBeTruthy();
    const [mail] = server.received;
    expect(mail!.auth).toEqual({ user: 'postmaster@example.com', pass: 'hunter2' });
    expect(mail!.from).toBe('music@example.com');
    expect(mail!.to).toEqual(['friend@example.com']);
    expect(mail!.data).toContain('From: NicotinD <music@example.com>');
    expect(mail!.data).toContain('Subject: Hello');
    expect(mail!.data).toContain('HTML body');
  });

  it('skips AUTH when no username is configured', async () => {
    const server = await serve();
    expect((await smtpFor(server.port, { username: '' }).send(MESSAGE)).ok).toBe(true);
    expect(server.received[0]!.auth).toBeNull();
  });

  it('verify reports bad credentials as auth', async () => {
    const server = await serve({ auth: '535 5.7.8 Bad credentials' });
    const result = await smtpFor(server.port).verify();
    expect(result).toMatchObject({ ok: false, reason: 'auth' });
  });

  it('a 452 at RCPT (mailbox full / too many) is rate-limited, not a rejection', async () => {
    const server = await serve({ rcptTo: '452 4.5.3 Too many recipients' });
    expect(await smtpFor(server.port).send(MESSAGE)).toMatchObject({
      ok: false,
      reason: 'rate-limited',
    });
  });

  it('implicit TLS against a plain-text server fails fast as unreachable, never hangs', async () => {
    const server = await serve();
    const started = Date.now();
    const result = await smtpFor(server.port, { secure: true, ignoreTLS: false }).send(MESSAGE);
    expect(result).toMatchObject({ ok: false, reason: 'unreachable' });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(server.received).toHaveLength(0);
  });

  it('a silent server times out instead of holding the send open', async () => {
    // Greeting never arrives: a 2xx-less server that just sits there.
    const { createServer } = await import('node:net');
    const sockets: import('node:net').Socket[] = [];
    const silent = createServer((s) => sockets.push(s));
    await new Promise<void>((r) => silent.listen(0, '127.0.0.1', r));
    const port = (silent.address() as { port: number }).port;
    const result = await smtpFor(port, {
      timeouts: { connectionMs: 300, greetingMs: 300, socketMs: 300 },
    }).send(MESSAGE);
    expect(result).toMatchObject({ ok: false, reason: 'unreachable' });
    for (const s of sockets) s.destroy();
    await new Promise<void>((r) => silent.close(() => r()));
  });
});
