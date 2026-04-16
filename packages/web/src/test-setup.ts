// Must be first — enables Angular JIT compiler for all subsequent Angular imports
import '@angular/compiler';

import { getTestBed } from '@angular/core/testing';
import { BrowserTestingModule, platformBrowserTesting } from '@angular/platform-browser/testing';
import { afterEach, beforeEach } from 'vitest';

const TESTBED_SETUP = Symbol.for('@angular/cli/testbed-setup');
if (!(globalThis as Record<symbol, unknown>)[TESTBED_SETUP]) {
  (globalThis as Record<symbol, unknown>)[TESTBED_SETUP] = true;

  getTestBed().initTestEnvironment(BrowserTestingModule, platformBrowserTesting(), {
    errorOnUnknownElements: false,
    errorOnUnknownProperties: false,
    teardown: { destroyAfterEach: true },
  });
}

// TestBed cleanup hooks — mirrors what @angular/build:unit-test injects
beforeEach(() => getTestBed().resetTestingModule());
afterEach(() => getTestBed().resetTestingModule());
