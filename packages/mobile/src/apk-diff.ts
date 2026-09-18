/**
 * Compare two APKs the way F-Droid's reproducible-build check does.
 *
 * F-Droid verifies a developer-signed APK by running `apksigcopier.do_copy` —
 * which grafts our signature onto its own unsigned build — and then
 * `apksigner verify`. That passes only if the two zips are byte-identical apart
 * from the signature itself. When it fails, it says so with no detail, which is
 * a bad place to start debugging; this module answers *which entry* differs.
 *
 * The exclusion set mirrors apksigcopier's `exclude_meta`: the JAR signature
 * files, and nothing else. `META-INF/com/android/build/gradle/app-metadata.properties`
 * and `META-INF/*.version` are ordinary content and a difference there is real.
 */

/** Files that carry the signature rather than the app, so a diff is expected. */
export function isSignatureEntry(name: string): boolean {
  if (name === 'META-INF/MANIFEST.MF') return true;
  // Only directly under META-INF/ — a `.SF` deeper in the tree is app content.
  return /^META-INF\/[^/]+\.(SF|RSA|DSA|EC)$/i.test(name);
}

export interface ApkEntry {
  /** sha256 of the entry's uncompressed bytes. */
  sha256: string;
  /** Compression method as `zipinfo -l` reports it (`defN`, `stor`, …). */
  method?: string;
}

export type ApkEntries = ReadonlyMap<string, ApkEntry>;

export interface ApkDiff {
  onlyInA: string[];
  onlyInB: string[];
  changed: { name: string; a: ApkEntry; b: ApkEntry }[];
  /** Entry order differs even though the set matches — zip layout drift. */
  orderDiffers: boolean;
  /** How many entries the comparison actually looked at. */
  examined: number;
  /** How many were skipped as signature files. */
  ignored: number;
}

/**
 * Parse `zipinfo -1` (names, in archive order) — the order matters because two
 * archives with identical entries in a different order are not byte-identical.
 */
export function parseZipinfoNames(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.endsWith('/'));
}

/**
 * Parse the compression method out of `zipinfo -l` lines. Format:
 *   `-rw-r--r--  0.0 unx  5968 b- 2347 defN 81-Jan-01 01:01 assets/public/ngsw.json`
 * Anything that does not look like an entry line is skipped rather than throwing:
 * `zipinfo` brackets its output with a header and a summary.
 */
export function parseZipinfoMethods(text: string): Map<string, string> {
  const methods = new Map<string, string>();
  for (const line of text.split('\n')) {
    const m = /^\S+\s+\S+\s+\S+\s+\d+\s+\S+\s+\d+\s+(\S+)\s+\S+\s+\S+\s+(.+)$/.exec(line.trim());
    if (m) methods.set(m[2], m[1]);
  }
  return methods;
}

/**
 * `a` is the reference (the published APK), `b` the candidate (our rebuild).
 * Signature entries are counted, not compared — `ignored` is the denominator
 * that says so out loud.
 */
export function diffApkEntries(
  a: ApkEntries,
  b: ApkEntries,
  order?: { a: string[]; b: string[] },
): ApkDiff {
  const names = new Set([...a.keys(), ...b.keys()]);
  const diff: ApkDiff = {
    onlyInA: [],
    onlyInB: [],
    changed: [],
    orderDiffers: false,
    examined: 0,
    ignored: 0,
  };

  for (const name of [...names].sort()) {
    if (isSignatureEntry(name)) {
      diff.ignored++;
      continue;
    }
    diff.examined++;
    const ea = a.get(name);
    const eb = b.get(name);
    if (ea && !eb) diff.onlyInA.push(name);
    else if (eb && !ea) diff.onlyInB.push(name);
    else if (ea && eb && (ea.sha256 !== eb.sha256 || ea.method !== eb.method)) {
      diff.changed.push({ name, a: ea, b: eb });
    }
  }

  if (order) {
    const keep = (n: string): boolean => !isSignatureEntry(n);
    const oa = order.a.filter(keep);
    const ob = order.b.filter(keep);
    diff.orderDiffers = oa.length === ob.length && oa.some((n, i) => n !== ob[i]);
  }

  return diff;
}

export function isIdentical(diff: ApkDiff): boolean {
  return (
    diff.onlyInA.length === 0 &&
    diff.onlyInB.length === 0 &&
    diff.changed.length === 0 &&
    !diff.orderDiffers
  );
}

/** Human-readable report. Always states the denominator, never just "OK". */
export function formatApkDiff(diff: ApkDiff, labels = { a: 'reference', b: 'candidate' }): string {
  const lines: string[] = [];
  const total = diff.examined + diff.ignored;
  lines.push(
    `${total} entries: ${diff.examined} compared, ${diff.ignored} signature entries ignored.`,
  );

  if (isIdentical(diff)) {
    lines.push('IDENTICAL — every compared entry matches, in the same order.');
    return lines.join('\n');
  }

  for (const n of diff.onlyInA) lines.push(`  only in ${labels.a}:  ${n}`);
  for (const n of diff.onlyInB) lines.push(`  only in ${labels.b}:  ${n}`);
  for (const c of diff.changed) {
    const why = c.a.sha256 === c.b.sha256 ? `method ${c.a.method} vs ${c.b.method}` : 'content';
    lines.push(`  differs (${why}): ${c.name}`);
    if (c.a.sha256 !== c.b.sha256) {
      lines.push(`      ${labels.a}: ${c.a.sha256}`);
      lines.push(`      ${labels.b}: ${c.b.sha256}`);
    }
  }
  if (diff.orderDiffers) {
    lines.push('  entry ORDER differs — the sets match but the archives do not.');
  }

  const n = diff.onlyInA.length + diff.onlyInB.length + diff.changed.length;
  lines.push(
    n === 1 ? 'NOT REPRODUCIBLE — 1 entry differs.' : `NOT REPRODUCIBLE — ${n} entries differ.`,
  );
  return lines.join('\n');
}
