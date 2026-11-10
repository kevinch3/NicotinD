/**
 * An in-process SMTP server that speaks just enough of RFC 5321 for nodemailer:
 * greeting, EHLO, AUTH PLAIN/LOGIN, MAIL FROM, RCPT TO, DATA, RSET, NOOP, QUIT.
 * No STARTTLS is advertised, so clients connect with `secure: false,
 * ignoreTLS: true`. Each scenario picks its replies, so the SMTP transport's
 * contract tests can provoke every failure reason without a network or a
 * dependency (docs/email-invitations.md, increment 3).
 */
import { createServer, type Server, type Socket } from 'node:net';

export interface FakeSmtpReplies {
  /** Reply to the connection (default `220 fake.smtp ESMTP`). */
  greeting?: string;
  /** Reply to a completed AUTH (default `235 2.7.0 Authentication successful`). */
  auth?: string;
  /** Reply to MAIL FROM (default `250 2.1.0 OK`). */
  mailFrom?: string;
  /** Reply to RCPT TO (default `250 2.1.5 OK`). */
  rcptTo?: string;
  /** Reply after the DATA terminator (default `250 2.0.0 OK queued as <id>`). */
  dataEnd?: string;
}

export interface ReceivedMail {
  from: string;
  to: string[];
  /** The raw message as sent between DATA and the terminator (dot-unstuffed). */
  data: string;
  /** Credentials the client authenticated with, if any. */
  auth: { user: string; pass: string } | null;
}

export interface FakeSmtpServer {
  port: number;
  received: ReceivedMail[];
  /** Replace the replies for the next connections. */
  setReplies(replies: FakeSmtpReplies): void;
  close(): Promise<void>;
}

const decode = (b64: string): string => Buffer.from(b64, 'base64').toString('utf8');

function parsePlain(b64: string): { user: string; pass: string } {
  const [, user = '', pass = ''] = decode(b64).split('\0');
  return { user, pass };
}

/** `"235 …"` → is it a 2xx/3xx success? */
const succeeded = (reply: string): boolean => /^[23]/.test(reply);

export async function startFakeSmtpServer(initial: FakeSmtpReplies = {}): Promise<FakeSmtpServer> {
  let replies: FakeSmtpReplies = initial;
  const received: ReceivedMail[] = [];
  const sockets = new Set<Socket>();
  let queued = 0;

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    socket.setEncoding('utf8');
    const r = { ...replies };
    const write = (line: string) => {
      if (!socket.destroyed) socket.write(`${line}\r\n`);
    };

    let buffer = '';
    let mode: 'command' | 'data' | 'auth-plain' | 'auth-login-user' | 'auth-login-pass' = 'command';
    let data = '';
    let loginUser = '';
    let auth: ReceivedMail['auth'] = null;
    let from = '';
    let to: string[] = [];

    const finishAuth = (creds: { user: string; pass: string }) => {
      const reply = r.auth ?? '235 2.7.0 Authentication successful';
      if (succeeded(reply)) auth = creds;
      write(reply);
      mode = 'command';
    };

    const onLine = (line: string) => {
      if (mode === 'data') {
        if (line === '.') {
          const reply = r.dataEnd ?? `250 2.0.0 OK queued as fake-${++queued}`;
          if (succeeded(reply)) received.push({ from, to, data, auth });
          write(reply);
          data = '';
          from = '';
          to = [];
          mode = 'command';
        } else {
          data += `${line.startsWith('..') ? line.slice(1) : line}\r\n`;
        }
        return;
      }
      if (mode === 'auth-plain') return finishAuth(parsePlain(line));
      if (mode === 'auth-login-user') {
        loginUser = decode(line);
        mode = 'auth-login-pass';
        return write(`334 ${Buffer.from('Password:').toString('base64')}`);
      }
      if (mode === 'auth-login-pass') return finishAuth({ user: loginUser, pass: decode(line) });

      const verb = line.split(' ', 1)[0]!.toUpperCase();
      const arg = line.slice(verb.length).trim();
      switch (verb) {
        case 'EHLO':
          write('250-fake.smtp Hello');
          write('250-AUTH PLAIN LOGIN');
          write('250-8BITMIME');
          write('250 SMTPUTF8');
          return;
        case 'HELO':
          return write('250 fake.smtp');
        case 'AUTH': {
          const [mech = '', initialResponse] = arg.split(' ');
          if (mech.toUpperCase() === 'PLAIN') {
            if (initialResponse) return finishAuth(parsePlain(initialResponse));
            mode = 'auth-plain';
            return write('334 ');
          }
          if (mech.toUpperCase() === 'LOGIN') {
            if (initialResponse) {
              loginUser = decode(initialResponse);
              mode = 'auth-login-pass';
              return write(`334 ${Buffer.from('Password:').toString('base64')}`);
            }
            mode = 'auth-login-user';
            return write(`334 ${Buffer.from('Username:').toString('base64')}`);
          }
          return write('504 5.5.4 Unrecognized authentication type');
        }
        case 'MAIL': {
          const reply = r.mailFrom ?? '250 2.1.0 OK';
          if (succeeded(reply)) from = /<([^>]*)>/.exec(arg)?.[1] ?? '';
          return write(reply);
        }
        case 'RCPT': {
          const reply = r.rcptTo ?? '250 2.1.5 OK';
          if (succeeded(reply)) to.push(/<([^>]*)>/.exec(arg)?.[1] ?? '');
          return write(reply);
        }
        case 'DATA':
          mode = 'data';
          return write('354 End data with <CR><LF>.<CR><LF>');
        case 'RSET':
          from = '';
          to = [];
          return write('250 2.0.0 OK');
        case 'NOOP':
          return write('250 2.0.0 OK');
        case 'QUIT':
          write('221 2.0.0 Bye');
          socket.end();
          return;
        default:
          return write('502 5.5.2 Command not recognized');
      }
    };

    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        onLine(line);
      }
    });

    const greeting = r.greeting ?? '220 fake.smtp ESMTP';
    write(greeting);
    // A 4xx/5xx greeting is the server refusing the session outright.
    if (!succeeded(greeting)) socket.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fake SMTP: no port');

  return {
    port: address.port,
    received,
    setReplies(next) {
      replies = next;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

/** A port nothing listens on: bind, read the number, release it. */
export async function closedPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  const port = address && typeof address !== 'string' ? address.port : 1;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}
