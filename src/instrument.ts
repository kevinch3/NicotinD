import { initServerSentry } from '@nicotind/api/instrument';

// Initialize Sentry at process load — BEFORE the Hono/http modules are imported
// (they load via the `createApp` import in main.ts) — so @sentry/bun's
// auto-instrumentation can patch them for HTTP tracing. Importing the isolated
// `@nicotind/api/instrument` subpath keeps the API barrel (and Hono) out of this
// preload step. No-op when NICOTIND_SENTRY_DSN is unset.
export const sentryEnabled = initServerSentry();
