import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pruneBuildTooling } from './prune-build-tooling.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'prune-tooling-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const pkg = (rel: string) => {
  mkdirSync(join(root, rel), { recursive: true });
  writeFileSync(join(root, rel, 'package.json'), '{}');
};
const link = (target: string, rel: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  symlinkSync(join(root, target), join(root, rel));
};
const present = (rel: string) => {
  try {
    lstatSync(join(root, rel));
    return true;
  } catch {
    return false;
  }
};

describe('pruneBuildTooling (#1810)', () => {
  it("removes the isolated store's entries and every link to them", () => {
    const plugins =
      'node_modules/.bun/@sentry+bundler-plugins@11.0.0/node_modules/@sentry/bundler-plugins';
    const cli = 'node_modules/.bun/sentry@0.44.1/node_modules/sentry';
    const node = 'node_modules/.bun/@sentry+node@11.0.0/node_modules/@sentry/node';
    pkg(plugins);
    pkg(cli);
    pkg(node);
    link(plugins, 'node_modules/.bun/@sentry+node@11.0.0/node_modules/@sentry/bundler-plugins');
    link(cli, 'node_modules/.bun/node_modules/sentry');

    expect(pruneBuildTooling(root)).toEqual([
      'node_modules/.bun/@sentry+bundler-plugins@11.0.0',
      'node_modules/.bun/@sentry+node@11.0.0/node_modules/@sentry/bundler-plugins',
      'node_modules/.bun/node_modules/sentry',
      'node_modules/.bun/sentry@0.44.1',
    ]);
    expect(
      present('node_modules/.bun/@sentry+node@11.0.0/node_modules/@sentry/bundler-plugins'),
    ).toBe(false);
    expect(existsSync(join(root, node, 'package.json'))).toBe(true);
  });

  it('removes a hoisted install, nested or not', () => {
    pkg('node_modules/sentry');
    pkg('node_modules/@sentry/bundler-plugins');
    pkg('node_modules/@sentry/node');
    pkg('node_modules/@sentry/node/node_modules/@sentry/bundler-plugins');
    expect(pruneBuildTooling(root)).toEqual([
      'node_modules/@sentry/bundler-plugins',
      'node_modules/@sentry/node/node_modules/@sentry/bundler-plugins',
      'node_modules/sentry',
    ]);
    expect(present('node_modules/@sentry/node/package.json')).toBe(true);
  });

  it('leaves names that only look alike', () => {
    pkg('node_modules/sentry-cli-helper');
    pkg('node_modules/.bun/sentry-x@1.0.0/node_modules/sentry-x');
    pkg('node_modules/@sentry/bun');
    expect(pruneBuildTooling(root)).toEqual([]);
    expect(present('node_modules/sentry-cli-helper')).toBe(true);
    expect(present('node_modules/.bun/sentry-x@1.0.0')).toBe(true);
    expect(present('node_modules/@sentry/bun')).toBe(true);
  });
});
