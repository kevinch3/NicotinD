import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import {
  RUNTIME_FLOORS,
  checkRefs,
  majorOf,
  parseUses,
  workflowFiles,
  type ActionRef,
  type RuntimeFloor,
} from './check-action-runtimes';

const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), '..');

const ref = (action: string, version: string): ActionRef => ({
  action,
  version,
  file: 'w.yml',
  line: 1,
});

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

  it('reports a SHA pin as unclassifiable rather than passing it', () => {
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

describe('the real workflows', () => {
  const files = workflowFiles();
  const refs = files.flatMap((f) => parseUses(readFileSync(join(repoRoot, f), 'utf8'), f));

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
