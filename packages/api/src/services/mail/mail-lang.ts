/**
 * Which language a mail is written in (docs/email-invitations.md, "Mail
 * language"): the recipient's saved language, else the language of the browser
 * that caused the mail, else English — the same order the web app uses, so a
 * user who never picked a language reads their mail as they read the app.
 */
import type { Database } from 'bun:sqlite';
import { PREFERENCE_LANGS, type PreferenceLang } from '@nicotind/core';
import { getUserPreferences } from '../user-preferences.js';

/** The best catalog for an `Accept-Language` header, by q-value then order, matched on the base language. */
export function negotiateLang(header: string | null | undefined): PreferenceLang | null {
  if (!header) return null;
  const ranked = header
    .split(',')
    .map((part, index) => {
      const [tag, ...params] = part.trim().split(';');
      const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      const weight = q ? Number(q.slice(2)) : 1;
      return { base: tag!.trim().toLowerCase().split('-')[0]!, weight, index };
    })
    .filter((e) => e.base && Number.isFinite(e.weight) && e.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.index - b.index);
  const hit = ranked.find((e) => (PREFERENCE_LANGS as readonly string[]).includes(e.base));
  return (hit?.base as PreferenceLang | undefined) ?? null;
}

export function mailLangOf(
  db: Database,
  userId: string | null | undefined,
  acceptLanguage?: string | null,
): PreferenceLang {
  const saved = userId ? getUserPreferences(db, userId).language : null;
  return saved ?? negotiateLang(acceptLanguage) ?? 'en';
}
