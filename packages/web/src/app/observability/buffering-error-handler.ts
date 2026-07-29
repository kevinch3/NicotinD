import { ErrorHandler, Injectable } from '@angular/core';
import { captureError } from './error-buffer';

/**
 * Angular `ErrorHandler` that never statically references the Sentry SDK, so the
 * SDK stays out of the initial bundle (issue #285). It forwards to the shared
 * error buffer — which replays into Sentry once the lazily-loaded SDK connects —
 * and logs to the console like Angular's default handler so nothing is silently
 * swallowed in dev. This replaces `Sentry.createErrorHandler()`, whose static
 * import was one of the three things pinning the SDK into the initial chunk.
 */
@Injectable()
export class BufferingErrorHandler implements ErrorHandler {
  handleError(error: unknown): void {
    console.error(error);
    captureError(error, 'angular');
  }
}
