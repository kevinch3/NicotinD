/**
 * Library quality auditor — asserts the library is reliable across DB **and**
 * disk, and exits non-zero when any HIGH-severity defect is present (so it can
 * run as a scheduled gate / pre-release check).
 *
 *   bun run packages/api/src/scripts/audit-library.ts            # human report
 *   bun run packages/api/src/scripts/audit-library.ts --json     # machine output
 *   bun run packages/api/src/scripts/audit-library.ts --no-fail  # always exit 0
 *   bun run packages/api/src/scripts/audit-library.ts --rule=watermark_artist  # list one rule
 *
 * Checks (see docs/library-audit.md for the rule catalogue):
 *   DB   — aggregate-count drift, dangling refs, orphan artists; DJ-pool/VA-source
 *          watermark & numeric artists; watermark/numeric singles; mis-split
 *          albums; render gaps (missing year/artwork, visible 'unknown').
 *   Disk — library_songs paths missing on disk; audio files not in the DB; empty
 *          directories.
 *
 * Read-only. Env: NICOTIND_DATA_DIR, NICOTIND_MUSIC_DIR, NICOTIND_CONFIG.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parse } from 'yaml';
import { Database } from 'bun:sqlite';
import { auditLibrary, summarize, type AuditFinding, type AuditSeverity } from '../services/library-audit.js';
import { scanMusicDir, diskFindings } from '../services/library-disk-audit.js';

function expandHome(p: string): string {
  return p.startsWith('~') ? join(process.env.HOME ?? '/root', p.slice(1)) : p;
}

function loadConfig(): { dataDir: string; musicDir: string } {
  let fileConfig: Record<string, unknown> = {};
  const configPath = resolve(process.env.NICOTIND_CONFIG ?? 'config/default.yml');
  try {
    fileConfig = (parse(readFileSync(configPath, 'utf-8')) ?? {}) as Record<string, unknown>;
  } catch {
    /* no config file */
  }
  const dataDir = expandHome(
    process.env.NICOTIND_DATA_DIR ?? (fileConfig.dataDir as string | undefined) ?? '~/.nicotind',
  );
  const musicDirRaw = process.env.NICOTIND_MUSIC_DIR ?? (fileConfig.musicDir as string | undefined);
  if (!musicDirRaw) throw new Error('musicDir not configured');
  return { dataDir, musicDir: expandHome(musicDirRaw) };
}

const SEV_ICON: Record<AuditSeverity, string> = { high: '🔴', medium: '🟠', low: '🟡' };

function main(): void {
  const args = new Set(process.argv.slice(2));
  const json = args.has('--json');
  const noFail = args.has('--no-fail');
  const ruleFilter = [...args].find((a) => a.startsWith('--rule='))?.slice('--rule='.length);

  const { dataDir, musicDir } = loadConfig();
  const dbPath = join(dataDir, 'nicotind.db');
  if (!existsSync(dbPath)) {
    console.error(`Database not found at ${dbPath}. Run nicotind at least once first.`);
    process.exit(2);
  }
  const db = new Database(dbPath, { readonly: true });

  // DB findings + disk findings merged into one report.
  let findings: AuditFinding[] = auditLibrary(db).findings;
  if (existsSync(musicDir)) {
    const scan = scanMusicDir(musicDir);
    const dbPaths = db.query<{ path: string }, []>('SELECT path FROM library_songs').all().map((r) => r.path);
    findings = [...findings, ...diskFindings(scan, dbPaths)];
  } else {
    console.warn(`⚠️  musicDir ${musicDir} not found — skipping disk checks.`);
  }
  const report = summarize(db, findings);

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    process.exit(noFail || report.ok ? 0 : 1);
  }

  if (ruleFilter) {
    const matched = report.findings.filter((f) => f.rule === ruleFilter);
    console.log(`# rule "${ruleFilter}" — ${matched.length} finding(s)\n`);
    for (const f of matched) console.log(`  ${f.subject}\t${f.message}`);
    process.exit(noFail || report.ok ? 0 : 1);
  }

  const t = report.totals;
  console.log(`\nLibrary audit — ${dbPath}`);
  console.log(
    `  ${t.artists} artists · ${t.albums} albums · ${t.songs} songs · ${t.visibleSingles} visible singles\n`,
  );
  if (report.summary.length === 0) {
    console.log('✅ No findings — the library is clean.\n');
  } else {
    console.log('Findings by rule (worst first):');
    for (const s of report.summary) {
      console.log(`  ${SEV_ICON[s.severity]} ${s.severity.padEnd(6)} ${String(s.count).padStart(5)}  ${s.rule}`);
    }
    console.log(
      `\n  ${report.highSeverityCount} high-severity finding(s). Use --rule=<id> to list, --json for detail.`,
    );
    console.log('  Cleanup: bun run packages/api/src/scripts/repair-pollution.ts  (dry-run; --apply to act)\n');
  }

  process.exit(noFail || report.ok ? 0 : 1);
}

main();
