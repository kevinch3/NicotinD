import type { EnvironmentProviders, Provider } from '@angular/core';
import type { HttpInterceptorFn } from '@angular/common/http';

/**
 * Empty everywhere but the static demo, whose `demo` build configuration
 * replaces this file with `demo-config.demo.ts` (angular.json
 * `fileReplacements`) — so no demo code reaches any other bundle.
 */
export const DEMO_INTERCEPTORS: HttpInterceptorFn[] = [];
export const DEMO_PROVIDERS: Array<Provider | EnvironmentProviders> = [];
