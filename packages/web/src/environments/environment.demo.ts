// The static, serverless demo (Angular "demo" build configuration, angular.json;
// docs/demo-mode.md). A production build whose API is faked in the browser —
// no Sentry: a visitor's demo session is not a production error.
export const environment = {
  production: true,
  sentryDsn: '',
  tvBuild: false,
  demo: true,
};
