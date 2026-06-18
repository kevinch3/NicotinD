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
