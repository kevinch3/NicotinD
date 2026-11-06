import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import {
  RUNNER_IMAGES,
  RUNTIME_FLOORS,
  checkRefs,
  checkRunners,
  majorOf,
  parseRunners,
  parseUses,
  workflowFiles,
  type ActionRef,
  type RunnerImage,
  type RunnerRef,
  type RuntimeFloor,
} from './check-action-runtimes';

const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), '..');

const ref = (action: string, version: string, tag?: string): ActionRef => ({
  action,
  version,
  ...(tag ? { tag } : {}),
  file: 'w.yml',
  line: 1,
});

const SHA = '3d3c42e5aac5ba805825da76410c181273ba90b1';

describe('parseUses', () => {
  it('reads action and version off a step', () => {
    expect(parseUses('    - uses: actions/checkout@v7\n')).toEqual([
      { action: 'actions/checkout', version: 'v7', file: '', line: 1 },
    ]);
  });

  it('reads the `uses:` on its own line under a named step', () => {
    const src = ['      - name: Cache', '        uses: actions/cache@v6', ''].join('\n');
    expect(parseUses(src).map((r) => r.action)).toEqual(['actions/cache']);
  });

  it('reports the real line number', () => {
    expect(parseUses('\n\n- uses: actions/checkout@v7\n')[0]?.line).toBe(3);
  });

  it('strips quotes around the ref', () => {
    expect(parseUses(`- uses: 'actions/checkout@v7'`)[0]?.version).toBe('v7');
  });

  // These workflows carry long WHY comments that name actions; reading one as a
  // real pin would make the gate fail on prose.
  it('ignores a `uses:` inside a comment', () => {
    expect(parseUses('      # uses: actions/checkout@v4 (the old one)\n')).toEqual([]);
  });

  // The composite lives in this repo and is scanned as a file in its own right.
  it('ignores local composite refs, which carry no version', () => {
    expect(parseUses('- uses: ./.github/actions/playwright-deps\n')).toEqual([]);
  });

  it('reads the version comment after a SHA pin', () => {
    expect(parseUses(`      - uses: docker/login-action@${SHA} # v4\n`)[0]).toEqual({
      action: 'docker/login-action',
      version: SHA,
      tag: 'v4',
      file: '',
      line: 1,
    });
    expect(parseUses(`- uses: aquasecurity/trivy-action@${SHA} # v0.36.0`)[0]?.tag).toBe('v0.36.0');
  });

  it('keeps a non-major pin intact', () => {
    expect(parseUses('- uses: aquasecurity/trivy-action@v0.36.0')[0]?.version).toBe('v0.36.0');
  });
});

describe('majorOf', () => {
  it('reads a bare major tag', () => {
    expect(majorOf('v7')).toBe(7);
  });

  it('reads the major out of a full version', () => {
    expect(majorOf('v0.36.0')).toBe(0);
    expect(majorOf('4.1.3')).toBe(4);
  });

  // Null, not 0: a SHA's runtime is not derivable offline, and treating it as
  // major 0 would fail every SHA pin as "below floor" for the wrong reason.
  it('returns null for a commit SHA', () => {
    expect(majorOf('3d3c42e5aac5ba805825da76410c181273ba90b1')).toBeNull();
  });
});

describe('checkRefs', () => {
  const floors: Record<string, RuntimeFloor> = {
    'actions/checkout': { minMajor: 5, note: 'v4 is node20' },
    'some/composite': { composite: true, note: 'no node runtime' },
  };

  it('passes a pin at the floor', () => {
    const f = checkRefs([ref('actions/checkout', 'v5')], floors);
    expect(f.belowFloor).toEqual([]);
    expect(f.unclassified).toEqual([]);
  });

  it('passes a pin above the floor', () => {
    expect(checkRefs([ref('actions/checkout', 'v7')], floors).belowFloor).toEqual([]);
  });

  it('fails a pin below the floor', () => {
    const f = checkRefs([ref('actions/checkout', 'v4')], floors);
    expect(f.belowFloor).toHaveLength(1);
    expect(f.belowFloor[0]?.minMajor).toBe(5);
  });

  // The denominator, both ways: an action the table has never heard of is the
  // one thing this gate must not wave through.
  it('fails an action with no floor entry', () => {
    const f = checkRefs([ref('brand/new', 'v1')], floors);
    expect(f.unclassified).toHaveLength(1);
    expect(f.unclassified[0]?.why).toContain('RUNTIME_FLOORS');
  });

  it('fails a floor entry no workflow uses', () => {
    const f = checkRefs([ref('actions/checkout', 'v7')], floors);
    expect(f.unusedFloors).toEqual(['some/composite']);
  });

  it('exempts a composite action from the floor check at any version', () => {
    const f = checkRefs([ref('actions/checkout', 'v7'), ref('some/composite', 'v0.1.0')], floors);
    expect(f.belowFloor).toEqual([]);
    expect(f.unusedFloors).toEqual([]);
  });

  it('classifies a SHA pin by its version comment', () => {
    const ok = checkRefs([ref('actions/checkout', SHA, 'v7'), ref('some/composite', 'v1')], floors);
    expect(ok.unclassified).toEqual([]);
    expect(ok.belowFloor).toEqual([]);

    const old = checkRefs(
      [ref('actions/checkout', SHA, 'v4'), ref('some/composite', 'v1')],
      floors,
    );
    expect(old.belowFloor.map((b) => b.ref.version)).toEqual([SHA]);
  });

  it('reports a short SHA as unclassifiable even with a comment', () => {
    const f = checkRefs(
      [ref('actions/checkout', '3d3c42e', 'v7'), ref('some/composite', 'v1')],
      floors,
    );
    expect(f.unclassified).toHaveLength(1);
  });

  it('reports a SHA pin with no version comment as unclassifiable rather than passing it', () => {
    const f = checkRefs(
      [
        ref('actions/checkout', '3d3c42e5aac5ba805825da76410c181273ba90b1'),
        ref('some/composite', 'v1'),
      ],
      floors,
    );
    expect(f.unclassified).toHaveLength(1);
    expect(f.unclassified[0]?.why).toContain('SHA');
  });
});

const runner = (label: string, line = 1): RunnerRef => ({ label, file: 'w.yml', line });

describe('parseRunners', () => {
  it('reads a literal runs-on label with its line', () => {
    expect(parseRunners('jobs:\n  build:\n    runs-on: macos-15\n', 'd.yml')).toEqual([
      { label: 'macos-15', file: 'd.yml', line: 3 },
    ]);
  });

  it('strips quotes and a trailing comment', () => {
    expect(parseRunners(`    runs-on: 'ubuntu-latest' # cheap`).map((r) => r.label)).toEqual([
      'ubuntu-latest',
    ]);
  });

  // `runs-on: ${{ matrix.runner }}` names no image itself; the labels live in the
  // matrix, so those are what get classified.
  it('reads matrix runner values instead of the indirection that consumes them', () => {
    const src = [
      '    runs-on: ${{ matrix.runner }}',
      '    strategy:',
      '      matrix:',
      '        include:',
      '          - platform: linux/amd64',
      '            runner: ubuntu-latest',
      '          - runner: ubuntu-24.04-arm',
    ].join('\n');
    expect(parseRunners(src).map((r) => [r.label, r.line])).toEqual([
      ['ubuntu-latest', 6],
      ['ubuntu-24.04-arm', 7],
    ]);
  });

  // Any other expression hides its labels from this gate, so it is surfaced to be
  // reported rather than dropped.
  it('returns any other runs-on expression verbatim', () => {
    expect(parseRunners('    runs-on: ${{ matrix.os }}').map((r) => r.label)).toEqual([
      '${{ matrix.os }}',
    ]);
  });

  it('ignores runs-on inside a comment', () => {
    expect(parseRunners('  # runs-on: macos-14 (retired)\n')).toEqual([]);
  });
});

describe('checkRunners', () => {
  const images: Record<string, RunnerImage> = {
    'ubuntu-latest': { note: 'default' },
    'macos-15': { note: 'arm64' },
    'macos-14': { note: 'arm64', retired: '2026-11-02' },
  };

  it('passes a classified label', () => {
    const f = checkRunners([runner('ubuntu-latest'), runner('macos-15')], images);
    expect(f).toEqual({ retired: [], unclassified: [], unusedImages: [] });
  });

  it('fails a retired label, keeping where it is', () => {
    const f = checkRunners(
      [runner('ubuntu-latest'), runner('macos-15'), runner('macos-14', 477)],
      images,
    );
    expect(f.retired).toHaveLength(1);
    expect(f.retired[0]?.ref).toEqual({ label: 'macos-14', file: 'w.yml', line: 477 });
    expect(f.retired[0]?.image.retired).toBe('2026-11-02');
  });

  it('fails a label the table has never heard of', () => {
    const f = checkRunners(
      [runner('ubuntu-latest'), runner('macos-15'), runner('macos-27')],
      images,
    );
    expect(f.unclassified).toHaveLength(1);
    expect(f.unclassified[0]?.why).toContain('RUNNER_IMAGES');
  });

  it('fails an expression it cannot resolve', () => {
    const f = checkRunners(
      [runner('ubuntu-latest'), runner('macos-15'), runner('${{ matrix.os }}')],
      images,
    );
    expect(f.unclassified[0]?.why).toContain('matrix.runner');
  });

  // A retired entry is a record of why a label is refused, not a rule that needs a
  // user; only a live image no workflow runs on is dead config.
  it('reports an unused live image as dead config, but never a retired one', () => {
    expect(checkRunners([runner('ubuntu-latest')], images).unusedImages).toEqual(['macos-15']);
  });
});

describe('the real workflows', () => {
  const files = workflowFiles();
  const refs = files.flatMap((f) => parseUses(readFileSync(join(repoRoot, f), 'utf8'), f));
  const runners = files.flatMap((f) => parseRunners(readFileSync(join(repoRoot, f), 'utf8'), f));

  it('finds runner labels in them, matrix values included', () => {
    const labels = new Set(runners.map((r) => r.label));
    expect(labels.has('ubuntu-latest')).toBe(true);
    expect(labels.has('ubuntu-24.04-arm')).toBe(true);
  });

  it('runs every job on a classified, live runner image', () => {
    expect(checkRunners(runners, RUNNER_IMAGES)).toEqual({
      retired: [],
      unclassified: [],
      unusedImages: [],
    });
  });

  // Issue #1629: v0.8.122's desktop-mac never started, publish-release skipped,
  // and F-Droid found no APK at the tag's download URL.
  it('would have failed on the v0.8.122 desktop-mac runner', () => {
    const { retired } = checkRunners([runner('macos-14', 477)], RUNNER_IMAGES);
    expect(retired.map((r) => r.ref.label)).toEqual(['macos-14']);
  });

  // The scan finding nothing is the failure mode that looks like success — it is
  // exactly what happened while Bun's Glob was skipping the `.github` dot-dir.
  it('finds the workflow files at all', () => {
    expect(files.length).toBeGreaterThan(0);
    expect(files).toContain('.github/workflows/ci.yml');
    expect(files).toContain('.github/workflows/deploy.yml');
  });

  it('finds pins in them', () => {
    expect(refs.length).toBeGreaterThan(0);
  });

  it('has every pinned action classified, and no dead floor entries', () => {
    const { belowFloor, unclassified, unusedFloors } = checkRefs(refs, RUNTIME_FLOORS);
    expect(unclassified).toEqual([]);
    expect(unusedFloors).toEqual([]);
    expect(belowFloor).toEqual([]);
  });

  // Issue #848: this is the state the gate exists to have caught.
  it('would have failed on the pre-#848 pins', () => {
    const { belowFloor } = checkRefs(
      [ref('actions/checkout', 'v4'), ref('docker/build-push-action', 'v6')],
      RUNTIME_FLOORS,
    );
    expect(belowFloor.map((b) => b.ref.action)).toEqual([
      'actions/checkout',
      'docker/build-push-action',
    ]);
  });
});
