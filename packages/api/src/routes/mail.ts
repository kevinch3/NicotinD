/**
 * Admin → Email delivery (docs/email-invitations.md, increment 3), mounted at
 * `/api/admin/mail` behind the `/api/admin/*` blanket auth plus the admin check
 * here. The SMTP password is write-only: GET says `passwordSet`, never the value.
 *
 * `GET /outbox` exists only when the effective transport is `outbox` — that is
 * env-only (`NICOTIND_MAIL_TRANSPORT=outbox`, fixed at boot), so the route is
 * registered or not at construction and a production server has no such path.
 */
import { Hono } from 'hono';
import { hostname } from 'node:os';
import type { Database } from 'bun:sqlite';
import type { AuthEnv } from '../middleware/auth.js';
import { recordAudit } from '../services/audit-log.js';
import { linkBaseCandidates } from '../services/link-base.js';
import type { MailService } from '../services/mail/mailer.js';
import { listOutbox } from '../services/mail/outbox.js';
import { MAIL_PRESETS } from '../services/mail/presets.js';
import { looksLikeEmail, type MailSettings } from '../services/mail/settings.js';
import { testEmail } from '../services/mail/templates.js';
import type { RemoteAccess } from '../services/tailscale.js';

export interface MailAdminRoutesDeps {
  db: Database;
  mail: MailService;
  remoteAccess?: Pick<RemoteAccess, 'publicUrl'> | null;
  serverName?: () => string;
}

/** Which fields a save changed — the audit detail, never their values. */
function changedFields(before: MailSettings, after: MailSettings, passwordTouched: boolean) {
  const keys = (Object.keys(after) as (keyof MailSettings)[]).filter((k) => before[k] !== after[k]);
  if (passwordTouched) keys.push('password' as keyof MailSettings);
  return keys;
}

export function mailAdminRoutes(deps: MailAdminRoutesDeps) {
  const { db, mail } = deps;
  const settings = mail.settings;
  const serverName = deps.serverName ?? hostname;
  const linkSources = {
    remoteAccess: deps.remoteAccess ?? null,
    publicUrl: () => settings.publicUrl(),
  };
  const app = new Hono<AuthEnv>();

  app.use('*', async (c, next) => {
    if (c.get('user')?.role !== 'admin') {
      return c.json({ error: 'Admin access required', code: 'FORBIDDEN' }, 403);
    }
    await next();
  });

  const view = async (requestUrl: string) => {
    const effective = settings.effective();
    const bases = await linkBaseCandidates(linkSources, requestUrl);
    return {
      settings: settings.configurable() ? settings.stored() : effective,
      effectiveTransport: effective.transport,
      passwordSet: settings.passwordSet(),
      configurable: settings.configurable(),
      publicUrlConfigurable: settings.publicUrlConfigurable(),
      presets: MAIL_PRESETS,
      usage: mail.usage(),
      linkBase: bases[0] ?? null,
    };
  };

  app.get('/', async (c) => c.json(await view(c.req.url)));

  app.put('/', async (c) => {
    if (!settings.configurable()) {
      return c.json(
        { error: 'Mail is configured by NICOTIND_MAIL_TRANSPORT', code: 'MAIL_ENV_LOCKED' },
        409,
      );
    }
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ error: 'Expected a JSON object', code: 'VALIDATION_ERROR' }, 400);
    }
    // NICOTIND_PUBLIC_URL fixes the link base; a save may not pretend otherwise.
    if (!settings.publicUrlConfigurable()) delete body.publicUrl;
    const before = settings.stored();
    const result = settings.update(body);
    if (!result.ok) return c.json({ error: result.error, code: result.code }, 400);
    const changed = changedFields(before, result.settings, result.password !== undefined);
    recordAudit(db, c.get('user'), 'mail.settings', {
      targetKind: 'mail',
      detail: `transport=${result.settings.transport} changed=${changed.join(',') || 'none'}`,
    });
    return c.json(await view(c.req.url));
  });

  app.post('/test', async (c) => {
    const body = await c.req.json<{ to?: unknown }>().catch(() => ({}) as { to?: unknown });
    const to = typeof body.to === 'string' ? body.to.trim() : '';
    if (!looksLikeEmail(to)) {
      return c.json({ error: 'to must be an email address', code: 'VALIDATION_ERROR' }, 400);
    }
    const bases = await linkBaseCandidates(linkSources, c.req.url);
    const linkBase = bases[0] ?? new URL(c.req.url).origin;
    const result = await mail.send('test', {
      to,
      ...testEmail({ serverName: serverName(), linkBase }),
    });
    recordAudit(db, c.get('user'), 'mail.test', {
      targetKind: 'mail',
      detail: result.ok ? 'sent' : `failed reason=${result.reason}`,
    });
    return c.json({ ...result, usage: mail.usage(), linkBase });
  });

  if (settings.effective().transport === 'outbox') {
    app.get('/outbox', (c) => {
      const to = c.req.query('to')?.trim() || undefined;
      return c.json({ messages: listOutbox(db, { to }) });
    });
  }

  return app;
}
