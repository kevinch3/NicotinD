# Bare metal, no root (no Docker)

Docker compose ([deployment.md](deployment.md)) is the supported install. This page is for the
host where you can't use it: a shared box, a seedbox, a family laptop or a university machine,
where you have a normal user account and no `sudo`. Docker and rootless Podman both need root to
set up (rootless Podman needs the `uidmap` package), the `.deb` installs system-wide, and the
AppImage is the desktop client, not a server. What's left is running the server from source as
your own user, which works fine.

Everything below runs as your user and writes only under your home directory. It was walked
end to end on a ThinkPad L13 Yoga (i5-10310U, 4 cores / 8 threads, 7.3 GiB RAM, no dGPU, Wi-Fi,
Ubuntu 24.04 base) with no root (#1722).

## What needs root, and what doesn't

| Path                                                     | Needs root or Docker                                                                |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Docker compose ([deployment.md](deployment.md))          | Docker (root to install; rootless needs `uidmap`)                                   |
| `.deb` package                                           | root                                                                                |
| This page (source, user service)                         | **no**                                                                              |
| Desktop app (AppImage, [desktop-app.md](desktop-app.md)) | no, but it is a desktop client with its own sidecar, not a server for other devices |

## Requirements

- **Bun** ≥ 1.1, per user: `curl -fsSL https://bun.sh/install | bash` (installs to `~/.bun`).
- **Node** ≥ 24.19, only for the from-source route (to build the web UI once); the prebuilt
  tarball needs none. No root needed: unpack the Linux tarball from
  [nodejs.org](https://nodejs.org/en/download) into `~/.local/node` and put `~/.local/node/bin` on
  your `PATH` for the build.
- **ffmpeg** on `PATH`, for transcoding, waveforms and the Ogg fallback. Most distros ship it; if
  yours doesn't and you can't install packages, put an `ffmpeg` binary in `~/.local/bin`.
- **RAM:** the web build peaks at about **1.7 GB**; the server idles at about **700–750 MB**. A
  2 GB board will struggle with the build: build elsewhere and copy `packages/web/dist` over.
- **Disk:** with the prebuilt tarball, its unpacked size (production dependencies only); from
  source, about 1.2 GB for the dev dependencies the build needs. Plus your music.

## Install

### Prebuilt tarball (Linux x64 and arm64)

Each release since #1742 attaches `nicotind-X.Y.Z-server-linux-<arch>.tar.gz` (`x64` or
`arm64`) with a `.sha256` beside it. It holds the backend source, its production dependencies
(about 170 packages, against ~1,500 for a build) and the built web UI, so it needs only Bun: no
Node, and no `ng build`, whose 1.66 GB peak would run a 2 GB board out of memory.

```bash
mkdir -p ~/apps && cd ~/apps
v=X.Y.Z; arch=x64   # or arm64
base=https://github.com/kevinch3/NicotinD/releases/download/v$v
curl -fsSLO "$base/nicotind-$v-server-linux-$arch.tar.gz"
curl -fsSLO "$base/nicotind-$v-server-linux-$arch.tar.gz.sha256"
sha256sum -c "nicotind-$v-server-linux-$arch.tar.gz.sha256"
tar -xzf "nicotind-$v-server-linux-$arch.tar.gz"
mv "nicotind-$v" nicotind && cd nicotind
cp .env.example .env
```

Then pick a Lidarr setting and start it, as below. Every release runs this exact tarball on a
clean runner with only Bun before attaching it.

### From source

Any other platform, or a commit between releases:

```bash
# 1. Source, no git needed: the release's source tarball (pick the latest tag)
mkdir -p ~/apps && cd ~/apps
curl -fsSL https://github.com/kevinch3/NicotinD/archive/refs/tags/vX.Y.Z.tar.gz | tar -xz
mv NicotinD-X.Y.Z nicotind && cd nicotind

# 2. Dependencies (~1,500 packages, ~1.2 GB, seconds on a decent connection)
bun install

# 3. Build the web UI into packages/web/dist (about a minute on 4 cores)
PATH="$HOME/.local/node/bin:$PATH" bun run build

# 4. Config: Bun reads .env from the working directory
cp .env.example .env
```

Then decide on Lidarr, the metadata catalog behind album search and discographies, and set it in
`.env`:

- **No Lidarr** (lightest): `NICOTIND_MODE=external` and no `NICOTIND_LIDARR_URL`. Library,
  streaming and acquisition work; album search says it needs Lidarr (#1729).
- **Your own Lidarr:** `NICOTIND_MODE=external`, `NICOTIND_LIDARR_URL=http://…:8686` and
  `LIDARR_API_KEY=…`.
- **Bundled Lidarr** (the default, `embedded`): on first run NicotinD downloads Lidarr (~100 MB)
  into `<dataDir>/bin` and runs it on `127.0.0.1:8686` only. It adds about 180 MB of RAM.

Run it once in the foreground to check it starts:

```bash
bun run src/main.ts
```

Open `http://<this-host>:8484`. The setup wizard creates the admin and picks the music folder. If
every page says "web UI not built", step 3 of the source install didn't produce
`packages/web/dist` (#1732); the tarball ships it built.

## Keep it running: a systemd user service

A user unit runs the server under your account, restarts it if it crashes and, with lingering
on, starts it at boot without you logging in.

`~/.config/systemd/user/nicotind.service`:

```ini
[Unit]
Description=NicotinD music server (bare metal, user service)
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=%h/apps/nicotind
Environment=PATH=%h/.bun/bin:%h/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=%h/.bun/bin/bun run src/main.ts
Restart=on-failure
RestartSec=10
KillMode=control-group
TimeoutStopSec=30

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now nicotind
journalctl --user -u nicotind -f      # logs
loginctl enable-linger                # start at boot without a login; may ask for your password
```

`KillMode=control-group` stops an embedded Lidarr with the server. If `enable-linger` is refused
on your host, the service still runs while you are logged in.

## Opening it from other devices

`http://<lan-or-tailnet-ip>:8484` is a full client: playback, search, history and stats all work
over plain HTTP. The installed app (PWA) and offline mode need HTTPS, because browsers only allow
a service worker on a secure origin. Without root, the easy way is
[Tailscale](https://tailscale.com/) in userspace mode plus `tailscale serve --bg 8484`, which gives
the host an HTTPS name on your tailnet with no open ports. See
[deployment.md](deployment.md#opening-it-from-another-device-plain-http-works-https-unlocks-the-pwa).

## Measured footprint

On the 4c/8t i5 above, empty library:

|                  |                                                    |
| ---------------- | -------------------------------------------------- |
| `bun install`    | ~1,500 packages, 1.2 GB `node_modules`, ~10 s      |
| `bun run build`  | ~54 s wall, ~100 CPU-seconds, **peak RSS 1.66 GB** |
| Server idle      | ~700–750 MB RSS, stable over 26 min                |
| Bundled Lidarr   | +~180 MB RSS, +103 MB download on first run        |
| Streaming a FLAC | ~8 % CPU                                           |

## Upgrading

Unpack the new tarball next to the old one and copy your `.env` across. From source, also run
`bun install` and `bun run build` in it; the prebuilt tarball needs neither. Point the unit's `WorkingDirectory` at it and
`systemctl --user restart nicotind`. Your library, database and settings live in the data dir
(`~/.nicotind` by default) and music folder, not in the source tree, so nothing else moves.
Keep the old tree until the new one is up, then delete it.

## Acquisition add-ons

Soulseek, yt-dlp and spotDL are separate add-on processes registered under **Extensions**
([acquisition-addon-protocol.md](acquisition-addon-protocol.md)); archive.org is bundled and only
needs enabling. An add-on can run the same way as the server: its own directory, `bun install`, a
user unit. Check its README for the environment variables it needs.
