import { createLogger } from '@nicotind/core';

const log = createLogger('health-check');

export async function waitForHealthy(
  url: string,
  timeoutMs: number,
  intervalMs = 1000,
): Promise<boolean> {
  const start = Date.now();
  let backoff = intervalMs;

  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        log.info({ url }, 'Service is healthy');
        return true;
      }
    } catch {
      // Service not ready yet
    }

    await new Promise((r) => setTimeout(r, backoff));
    backoff = Math.min(backoff * 1.5, 5000);
  }

  log.error({ url, timeoutMs }, 'Service health check timed out');
  return false;
}
