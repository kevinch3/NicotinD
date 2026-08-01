// TV-flagged production build (Angular "tv" build configuration, angular.json).
// Same runtime behavior as environment.prod.ts except tvBuild:true, which
// RemotePlaybackService reads to default "Allow remote control" on for a TV
// build with no explicit user choice yet (see remote-playback.service.ts).
export const environment = {
  production: true,
  sentryDsn:
    'https://10c3535096cee5fd283f70bbeb0b0f3b@o432900.ingest.us.sentry.io/4511658482991104', // Prod Sentry DSN (public ingest key)
  tvBuild: true,
};
