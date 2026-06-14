/**
 * Custom Playwright reporter for the playground project. Collects the
 * `playground.observation` annotations every flow emits and writes a
 * markdown + JSON findings report to `playground-report/`. Only registered for
 * the gated `playground` project (see playwright.config.ts).
 */
import type { Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ANNOTATION_TYPE, decodeObservation, summarize, type Observation } from './observe.js';
import { renderJson, renderMarkdown } from './report.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, '..', 'playground-report');

export default class PlaygroundReporter implements Reporter {
  private observations: Observation[] = [];

  onTestEnd(_test: TestCase, result: TestResult): void {
    for (const a of result.annotations) {
      if (a.type !== ANNOTATION_TYPE || !a.description) continue;
      const o = decodeObservation(a.description);
      if (o) this.observations.push(o);
    }
  }

  onEnd(): void {
    const input = {
      generatedAt: new Date().toISOString(),
      target: process.env.E2E_BASE_URL ?? `http://localhost:${process.env.E2E_PORT ?? '8585'}`,
      mode: (process.env.E2E_BASE_URL ? 'live' : 'managed') as 'live' | 'managed',
      observations: this.observations,
    };

    mkdirSync(OUT_DIR, { recursive: true });
    const md = resolve(OUT_DIR, 'playground-report.md');
    const json = resolve(OUT_DIR, 'playground-report.json');
    writeFileSync(md, renderMarkdown(input), 'utf8');
    writeFileSync(json, renderJson(input), 'utf8');

    const sum = summarize(this.observations);
    // eslint-disable-next-line no-console
    console.log(
      `\n📋 Playground report: ${sum.total} observations ` +
        `(${sum.bySeverity.high} high, ${sum.bySeverity.medium} medium) → ${md}\n`,
    );
  }
}
