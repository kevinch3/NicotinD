/**
 * Downloads slskd (and optionally Lidarr) binaries for embedded mode.
 * Usage: bun run scripts/download-deps.ts [--force]
 */
import { existsSync, mkdirSync, chmodSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const DATA_DIR = join(process.env.HOME ?? '/root', '.nicotind');
const BIN_DIR = join(DATA_DIR, 'bin');
const FORCE = process.argv.includes('--force');

interface DepConfig {
  name: string;
  repo: string;
  binaryName: string;
  getAssetName: (version: string, platform: string, arch: string) => string;
  extractCmd: (archive: string, dest: string, binaryName: string) => string;
  /** Optional deps log a warning on failure instead of aborting the install. */
  optional?: boolean;
}

const LIDARR_PLATFORM_MAP: Record<string, string> = {
  linux: 'linux-core',
  darwin: 'osx-core',
  win32: 'windows-core',
};

const PLATFORM_MAP: Record<string, string> = {
  linux: 'linux',
  darwin: 'osx',
  win32: 'win',
};

const ARCH_MAP: Record<string, string> = {
  x64: 'x64',
  arm64: 'arm64',
};

const deps: DepConfig[] = [
  {
    name: 'slskd',
    repo: 'slskd/slskd',
    binaryName: 'slskd',
    getAssetName: (version, platform, arch) => {
      const p = PLATFORM_MAP[platform];
      const a = ARCH_MAP[arch];
      if (!p || !a) throw new Error(`Unsupported platform: ${platform}/${arch}`);
      return `slskd-${version}-${p}-${a}.zip`;
    },
    extractCmd: (archive, dest) =>
      `unzip -o "${archive}" "slskd" "wwwroot/*" -d "${dest}"`,
  },
  {
    name: 'lidarr',
    repo: 'Lidarr/Lidarr',
    // Lidarr's archive extracts to a top-level `Lidarr/` folder; the executable
    // lives inside it. Powers discography features; optional so a download
    // failure never blocks slskd.
    binaryName: join('Lidarr', 'Lidarr'),
    optional: true,
    getAssetName: (version, platform, arch) => {
      const p = LIDARR_PLATFORM_MAP[platform];
      const a = ARCH_MAP[arch];
      if (!p || !a) throw new Error(`Unsupported platform: ${platform}/${arch}`);
      const v = version.replace(/^v/, '');
      const ext = platform === 'win32' ? 'zip' : 'tar.gz';
      return `Lidarr.master.${v}.${p}-${a}.${ext}`;
    },
    extractCmd: (archive, dest) =>
      archive.endsWith('.zip')
        ? `unzip -o "${archive}" -d "${dest}"`
        : `tar -xzf "${archive}" -C "${dest}"`,
  },
];

async function getLatestVersion(repo: string): Promise<string> {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { 'User-Agent': 'nicotind' },
  });
  if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
  const data = (await res.json()) as { tag_name: string };
  return data.tag_name;
}

async function downloadFile(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { headers: { 'User-Agent': 'nicotind' } });
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${url}`);
  if (!res.body) throw new Error('No response body');

  const totalBytes = Number(res.headers.get('content-length') ?? 0);
  let downloaded = 0;

  const writer = createWriteStream(dest);
  const reader = res.body.getReader();

  // Manual pipe with progress
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    writer.write(value);
    downloaded += value.length;
    if (totalBytes > 0) {
      const pct = ((downloaded / totalBytes) * 100).toFixed(0);
      process.stdout.write(`\r  Downloading... ${pct}% (${(downloaded / 1_000_000).toFixed(1)} MB)`);
    }
  }
  writer.end();
  await new Promise<void>((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
  console.log();
}

async function downloadDep(dep: DepConfig): Promise<void> {
  const binaryPath = join(BIN_DIR, dep.binaryName);

  if (existsSync(binaryPath) && !FORCE) {
    console.log(`  ${dep.name}: already installed at ${binaryPath}`);
    return;
  }

  console.log(`  ${dep.name}: resolving latest version...`);
  const version = await getLatestVersion(dep.repo);
  console.log(`  ${dep.name}: latest version is ${version}`);

  const platform = process.platform;
  const arch = process.arch;
  const assetName = dep.getAssetName(version, platform, arch);
  const url = `https://github.com/${dep.repo}/releases/download/${version}/${assetName}`;

  const tmpDir = join(DATA_DIR, 'tmp');
  mkdirSync(tmpDir, { recursive: true });
  const archivePath = join(tmpDir, assetName);

  console.log(`  ${dep.name}: downloading ${assetName}...`);
  await downloadFile(url, archivePath);

  console.log(`  ${dep.name}: extracting...`);
  mkdirSync(BIN_DIR, { recursive: true });
  execSync(dep.extractCmd(archivePath, BIN_DIR, dep.binaryName), { stdio: 'pipe' });

  chmodSync(binaryPath, 0o755);

  // Clean up archive
  const { unlinkSync } = await import('node:fs');
  unlinkSync(archivePath);

  console.log(`  ${dep.name}: installed to ${binaryPath}`);
}

async function main() {
  console.log(`NicotinD dependency installer${FORCE ? ' (force mode)' : ''}`);
  console.log(`Binary directory: ${BIN_DIR}\n`);

  for (const dep of deps) {
    try {
      await downloadDep(dep);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (dep.optional) {
        console.warn(`  ${dep.name}: skipped (optional) — ${msg}`);
        continue;
      }
      console.error(`  ${dep.name}: FAILED — ${msg}`);
      process.exit(1);
    }
  }

  console.log('\nAll dependencies installed.');
}

main();
