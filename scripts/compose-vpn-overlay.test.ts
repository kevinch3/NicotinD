import { describe, expect, it } from 'bun:test';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'yaml';

/**
 * docker-compose.vpn.yml moves peer-to-peer services into a gluetun container's
 * network namespace, so their only route out is the tunnel
 * (docs/acquisition-egress-vpn.md). Every property below is one whose loss
 * would either leak the home IP or quietly break the addon, and none of them
 * shows up as an error at `up` time.
 */
const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), '..');
const read = (file: string) => readFileSync(join(repoRoot, file), 'utf8');

/** Compose's `!reset` tag, which the plain YAML parser would only warn about. */
const RESET = Symbol('compose !reset');
const parseCompose = (file: string) =>
  parse(read(file), {
    customTags: [{ tag: '!reset', identify: () => false, resolve: () => RESET }],
  }) as { services?: Record<string, Service> };

type Service = {
  image?: string;
  profiles?: string[];
  mem_limit?: string;
  memswap_limit?: string;
  network_mode?: string;
  networks?: unknown;
  ports?: unknown;
  environment?: Record<string, string> | string[];
  env_file?: Array<{ path: string; required?: boolean }>;
  depends_on?: Record<string, { condition?: string }>;
};

/**
 * Services that talk to strangers' computers and so must go through the VPN.
 * A new peer-to-peer service (a torrent client) belongs on this list AND in the
 * overlay; the tests below then hold it to the same rules.
 */
const PEER_TO_PEER = ['slskd'];

const base = parseCompose('docker-compose.yml').services ?? {};
const overlay = parseCompose('docker-compose.vpn.yml').services ?? {};
const vpn = overlay.vpn ?? {};
const joined = Object.entries(overlay)
  .filter(([, svc]) => svc.network_mode === 'service:vpn')
  .map(([name]) => name);

describe('VPN overlay (docker-compose.vpn.yml)', () => {
  // Assert the denominator: a parser slip that yields {} must fail here rather
  // than let every check below pass against nothing.
  it('defines the vpn service and joins at least one service to it', () => {
    expect(overlay.vpn).toBeDefined();
    expect(joined.length).toBeGreaterThan(0);
  });

  it('routes every peer-to-peer service through the VPN', () => {
    expect(joined.sort()).toEqual([...PEER_TO_PEER].sort());
  });

  it('only joins services that exist in the base file', () => {
    expect(joined.filter((name) => !base[name])).toEqual([]);
  });

  it('drops the base networks of each joined service (mutually exclusive with network_mode)', () => {
    expect(joined.filter((name) => overlay[name]?.networks !== RESET)).toEqual([]);
  });

  it('answers to each joined service name, so addon URLs like http://slskd:5030 keep working', () => {
    const networks = vpn.networks as Record<string, { aliases?: string[] }> | undefined;
    expect([...(networks?.internal?.aliases ?? [])].sort()).toEqual([...joined].sort());
  });

  it('starts with exactly the profiles of the services that join it', () => {
    const wanted = new Set(joined.flatMap((name) => base[name]?.profiles ?? []));
    expect(new Set(vpn.profiles ?? [])).toEqual(wanted);
  });

  it('publishes nothing to the host or the LAN', () => {
    expect(vpn.ports).toBeUndefined();
    expect(joined.filter((name) => base[name]?.ports || overlay[name]?.ports)).toEqual([]);
  });

  it('never gates a joined service on the tunnel being HEALTHY (compose-boot-gates)', () => {
    // The kill switch is the namespace, not the start order: nothing can leak
    // while the tunnel comes up, and a health gate would strand the service in
    // `created` with no logs (#1019).
    const gated = joined.filter((name) =>
      Object.values(overlay[name]?.depends_on ?? {}).some(
        (d) => d?.condition === 'service_healthy',
      ),
    );
    expect(gated).toEqual([]);
  });

  it('keeps gluetun’s firewall on (the kill switch)', () => {
    const env = vpn.environment ?? {};
    const entries = Array.isArray(env)
      ? env.map((line) => line.split('=', 2) as [string, string])
      : Object.entries(env);
    expect(entries.filter(([k, v]) => k === 'FIREWALL' && /^(off|no|false)$/i.test(v))).toEqual([]);
  });

  it('reads credentials from a required, git-ignored vpn.env with a committed template', () => {
    expect(vpn.env_file).toEqual([{ path: './vpn.env', required: true }]);
    expect(read('.gitignore').split('\n')).toContain('vpn.env');
    expect(existsSync(join(repoRoot, 'vpn.env.example'))).toBe(true);
  });

  it('pins the gluetun image to an exact version', () => {
    expect(vpn.image).toMatch(/^qmcgaw\/gluetun:v\d+\.\d+\.\d+$/);
  });

  it('is bounded like every other container (compose-memory-limits)', () => {
    expect(vpn.mem_limit).toBeDefined();
    expect(vpn.memswap_limit).toBe(vpn.mem_limit);
  });
});

/**
 * The structural checks above read YAML; this asks Compose itself, which is
 * what actually decides how `!reset`, `env_file.required` and `network_mode`
 * merge. CI's Ubuntu runners ship the docker CLI; `config` needs no daemon.
 */
const hasDocker = Bun.which('docker') !== null;

describe.skipIf(!hasDocker)('VPN overlay resolved by docker compose', () => {
  const compose = (dir: string) =>
    Bun.spawnSync(
      [
        'docker',
        'compose',
        '-f',
        'docker-compose.yml',
        '-f',
        'docker-compose.vpn.yml',
        '--profile',
        'slskd-addon',
        'config',
        '--format',
        'json',
      ],
      { cwd: dir, stderr: 'pipe', stdout: 'pipe' },
    );

  const stage = (withEnv: boolean) => {
    const dir = mkdtempSync(join(tmpdir(), 'nicotind-vpn-'));
    for (const file of ['docker-compose.yml', 'docker-compose.vpn.yml']) {
      copyFileSync(join(repoRoot, file), join(dir, file));
    }
    if (withEnv) copyFileSync(join(repoRoot, 'vpn.env.example'), join(dir, 'vpn.env'));
    return dir;
  };

  it('puts slskd in the vpn namespace with no network of its own', () => {
    const dir = stage(true);
    try {
      const result = compose(dir);
      expect(result.exitCode).toBe(0);
      const { services } = JSON.parse(result.stdout.toString()) as {
        services: Record<string, Service>;
      };
      expect(services.slskd?.network_mode).toBe('service:vpn');
      expect(services.slskd?.networks ?? null).toBeNull();
      expect(services.vpn?.networks).toEqual({ internal: { aliases: ['slskd'] } });
      // The addon itself stays on the normal network and still names slskd.
      expect(services['slskd-addon']?.network_mode).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to start without vpn.env rather than run the tunnel unconfigured', () => {
    const dir = stage(false);
    try {
      const result = compose(dir);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toContain('vpn.env');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
