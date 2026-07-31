// Extract a human-readable message from a failed HttpClient call.
//
// Angular's HttpErrorResponse is NOT an `instanceof Error`, so a naive
// `err instanceof Error ? err.message : fallback` swallows the server's body
// (which NicotinD routes send as `{ error: "..." }`) and always shows the
// generic fallback. Prefer the server message, then a real Error's message,
// then the caller's fallback — matching the convention in login/admin/setup.
export function httpErrorMessage(err: unknown, fallback: string): string {
  const serverMsg = (err as { error?: { error?: string } })?.error?.error;
  if (typeof serverMsg === 'string' && serverMsg.length > 0) return serverMsg;
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

/** Read the server's typed error `code` (e.g. "ALBUM_NOT_IN_LIDARR") from a failed call, if any. */
export function httpErrorCode(err: unknown): string | undefined {
  const code = (err as { error?: { code?: string } })?.error?.code;
  return typeof code === 'string' && code.length > 0 ? code : undefined;
}

/**
 * Server error `code` → i18n key, for codes whose English message is stable
 * across every call site (issue #337, following #236's stable error codes).
 *
 * Deliberately NOT exhaustive: codes like `VALIDATION_ERROR`/`FORBIDDEN`/
 * `NOT_FOUND`/`INTERNAL_ERROR`/`SERVICE_UNAVAILABLE` carry a different English
 * message per call site (e.g. "name is required" vs "path is required"), so a
 * single translated string per code would be wrong at most of their sites —
 * those fall through to the raw server message below instead. Add a code here
 * only once it has one fixed meaning everywhere it's returned.
 */
export const ERROR_CODE_I18N_KEYS: Record<string, string> = {
  REGISTRATION_DISABLED: 'errors.registrationDisabled',
  USERNAME_TAKEN: 'errors.usernameTaken',
  INVALID_CREDENTIALS: 'errors.invalidCredentials',
  ACCOUNT_DISABLED: 'errors.accountDisabled',
  PAIRING_NOT_FOUND: 'errors.pairingNotFound',
  PAIRING_EXPIRED: 'errors.pairingExpired',
  RATE_LIMITED: 'errors.rateLimited',
};

/** Minimal shape `errorMessageForCode`/`httpErrorMessageI18n` need from TranslateService. */
export interface Translator {
  t(key: string): string;
}

/** Resolve a server error `code` to a translated message, else the fallback. */
export function errorMessageForCode(
  code: string | undefined,
  i18n: Translator,
  fallback: string,
): string {
  const key = code ? ERROR_CODE_I18N_KEYS[code] : undefined;
  return key ? i18n.t(key) : fallback;
}

/**
 * Localized counterpart to `httpErrorMessage`: prefers a mapped `code`'s
 * translation, then the raw server `error` string (untranslated — it's
 * English regardless of UI language), then a real Error's message, then the
 * caller's (already-translated) fallback.
 */
export function httpErrorMessageI18n(err: unknown, i18n: Translator, fallback: string): string {
  const code = httpErrorCode(err);
  if (code && ERROR_CODE_I18N_KEYS[code]) return i18n.t(ERROR_CODE_I18N_KEYS[code]);
  return httpErrorMessage(err, fallback);
}
