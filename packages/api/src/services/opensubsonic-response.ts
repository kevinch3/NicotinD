/**
 * The OpenSubsonic response envelope, in both wire formats (docs/opensubsonic.md).
 *
 * Handlers build one plain object; `renderSubsonic` writes it as JSON (`f=json`)
 * or XML (the Subsonic default). The XML rules are the ones every Subsonic
 * server follows, so one payload shape serves both:
 *   - a scalar field becomes an attribute,
 *   - an object becomes a child element named after its key,
 *   - an array becomes one repeated element per item,
 *   - a field named `value` becomes the element's text (lyrics lines).
 */

export const SUBSONIC_API_VERSION = '1.16.1';
const XMLNS = 'http://subsonic.org/restapi';

/** Subsonic's numeric error codes. */
export const SubsonicError = {
  Generic: 0,
  MissingParameter: 10,
  WrongCredentials: 40,
  TokenAuthUnsupported: 41,
  AuthMechanismUnsupported: 42,
  ConflictingAuth: 43,
  InvalidApiKey: 44,
  NotAuthorized: 50,
  NotFound: 70,
} as const;

export type SubsonicPayload = Record<string, unknown>;

export type SubsonicFormat = 'json' | 'xml';

export function pickFormat(f: string | undefined): SubsonicFormat {
  // `jsonp` is not supported; it is JSON with a callback a browser no longer needs.
  return f === 'json' ? 'json' : 'xml';
}

function header(serverVersion: string, status: 'ok' | 'failed') {
  return {
    status,
    version: SUBSONIC_API_VERSION,
    type: 'nicotind',
    serverVersion,
    openSubsonic: true,
  };
}

export function renderSubsonic(
  format: SubsonicFormat,
  serverVersion: string,
  payload: SubsonicPayload,
  status: 'ok' | 'failed' = 'ok',
): Response {
  const body = { ...header(serverVersion, status), ...payload };
  if (format === 'json') {
    return new Response(JSON.stringify({ 'subsonic-response': body }), {
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n${element('subsonic-response', { xmlns: XMLNS, ...body })}`,
    { headers: { 'Content-Type': 'application/xml; charset=utf-8' } },
  );
}

export function renderSubsonicError(
  format: SubsonicFormat,
  serverVersion: string,
  code: number,
  message: string,
): Response {
  return renderSubsonic(format, serverVersion, { error: { code, message } }, 'failed');
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function isScalar(v: unknown): v is string | number | boolean {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

function element(name: string, obj: Record<string, unknown>): string {
  let attrs = '';
  let children = '';
  let text = '';
  for (const [key, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    if (key === 'value' && isScalar(v)) {
      text = escapeXml(String(v));
    } else if (isScalar(v)) {
      attrs += ` ${key}="${escapeXml(String(v))}"`;
    } else if (Array.isArray(v)) {
      for (const item of v) children += child(key, item);
    } else if (typeof v === 'object') {
      children += element(key, v as Record<string, unknown>);
    }
  }
  const inner = text + children;
  return inner ? `<${name}${attrs}>${inner}</${name}>` : `<${name}${attrs}/>`;
}

function child(name: string, item: unknown): string {
  if (item === undefined || item === null) return '';
  if (isScalar(item)) return `<${name}>${escapeXml(String(item))}</${name}>`;
  return element(name, item as Record<string, unknown>);
}
