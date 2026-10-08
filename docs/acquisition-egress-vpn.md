# Acquisition egress: VPN for peer-to-peer addons

> **Partly built.** The Docker VPN overlay (option 1 below) ships as `docker-compose.vpn.yml`
> and routes slskd through the tunnel; how to run it is in
> [deployment.md](deployment.md#routing-peer-to-peer-addons-through-a-vpn-docker-composevpnyml).
> The disclosure, the verification checks and the desktop options are still proposals.
> Companion to [remote-access-options.md](remote-access-options.md),
> which covers the *inbound* direction (a phone reaching the server). This page covers the
> *outbound* direction: what an acquisition addon's traffic reveals, and how to route it through a
> VPN without breaking anything else. Researched 2026-10.

## Two directions, two answers

| Direction | Who connects | What it needs | Answer |
|---|---|---|---|
| Inbound | the user's phone → their server | a stable public HTTPS URL | Tailscale Funnel ([remote-access-options.md](remote-access-options.md)) |
| Outbound | an addon → swarms, Soulseek, YouTube | to hide the home IP from strangers | a VPN **scoped to that addon only** |

They must not be mixed. A whole-machine VPN breaks Funnel and the LAN, slows every stream, and
sits outside NicotinD's control, so nothing can verify it. Core and the streaming path stay on the
normal network. Only the addon that talks to peers goes through the tunnel.

## Disclosure comes first

A BitTorrent or Soulseek addon does two things a user would not guess from "download music":

- **It publishes the home IP address** to every peer in the swarm or network, and those peer lists
  are public. Rights-holder monitoring firms collect them, and that is where ISP copyright notices
  (and, in some countries, fines) come from.
- **It uploads.** A torrent client seeds by default, and slskd shares the music folder out (its
  mount is `:ro` precisely because it serves those files, see
  [acquisition-addon-protocol.md](acquisition-addon-protocol.md)).

If a self-hoster does not know a P2P client is running, a VPN does not fix that. It hides the
consequence from the user without asking them. The consent machinery already exists:
`CAPABILITY_RISK` (`packages/addon-sdk/src/addon-capability-risk.ts`) renders a plain-language line
per capability, and the registry records who consented and when. It is missing the P2P facts:

- Add a manifest declaration, e.g. `network: { peerToPeer: true, uploads: true }`, that core renders
  as its own consent line: *"Connects directly to strangers' computers. Your internet address is
  visible to them, and this addon uploads files to them."*
- P2P addons are **off until explicitly enabled**. They are never part of a default install profile
  without the user seeing that line.
- The addon card shows live egress status: **via VPN (Amsterdam, 185.x.x.x)** or **via your home
  connection**.
- A VPN does not change what is legal to download where the user lives. The copy should say so
  once, plainly, rather than imply the VPN makes it safe.

## How to route an addon through a VPN

Ranked by how hard it is to leak.

### 1. Network-namespace isolation (Docker): recommended, shipped

Run a VPN container ([gluetun](https://github.com/qdm12/gluetun): WireGuard/OpenVPN, about 30
providers, a built-in firewall) and attach the peer-to-peer service to its network stack. This is
`docker-compose.vpn.yml`, in essence:

```yaml
vpn:
  image: qmcgaw/gluetun:v3.41.3
  profiles: ["slskd-addon"]          # comes up exactly when the P2P service does
  cap_add: [NET_ADMIN]
  devices: [/dev/net/tun:/dev/net/tun]
  env_file: [{ path: ./vpn.env, required: true }]   # any gluetun provider, or a raw WireGuard peer
  networks: { internal: { aliases: [slskd] } }      # answers to the joined service's name
slskd:
  network_mode: "service:vpn"        # no network stack of its own
  networks: !reset null
```

- **The kill switch is structural.** The service has no interface except the vpn container's, and
  gluetun's firewall passes only the tunnel and the local compose network. When the VPN drops it
  has no route out at all. There is no setting to get wrong, and no leak through DHT, UDP or DNS.
  Checked on a local stack with a tunnel that never came up: addresses off the compose network that
  a normal container reached were blocked from slskd's namespace, while the addon still reached
  slskd by name.
- **Only the peer.** slskd is the process that talks to strangers; `slskd-addon` only talks to
  slskd and core, so it stays on the normal network. The alias keeps `http://slskd:5030` resolving,
  so nothing is re-registered. `FIREWALL_OUTBOUND_SUBNETS` is not needed: slskd only *answers* the
  compose network, it never dials into it.
- The compose file already used this mechanism: `ytdlp-pot-provider` shares `ytdlp-addon`'s
  stack with `network_mode: "service:ytdlp-addon"`.
- **Restart caveat.** If the vpn *container* restarts (gluetun heals a dropped tunnel in place
  without doing that), the joined container keeps a dead namespace with loopback only. It fails
  closed. `docker compose restart slskd` recovers it; `up -d` does not notice.
- `scripts/compose-vpn-overlay.test.ts` keeps the invariants: every service in its `PEER_TO_PEER`
  list is joined, its networks are reset, the aliases match, the profiles match, nothing is
  published, the firewall stays on, the image is pinned, and Compose itself resolves the overlay.
- **Port forwarding** decides peer-to-peer speed. Without an inbound port, the client can only connect
  to peers that are reachable themselves. Proton (paid plans) and a few others forward a port and
  gluetun can pass it on. Mullvad dropped port forwarding in 2023: it works, but more slowly.

### 2. Bind the client to the VPN interface (bare metal / desktop)

qBittorrent-style clients can bind to one interface (`wg0`). If it disappears, they stop. This is
a good kill switch, but it needs a system WireGuard interface (admin rights), and it competes with
Tailscale for routes on macOS. Acceptable for experts, not a default.

### 3. SOCKS5 / HTTP proxy setting: not for torrents

Fine for HTTP-only addons (`yt-dlp --proxy`). For BitTorrent it leaks: DHT, uTP and peer
connections are UDP, most SOCKS5 relays (e.g. `wireproxy`) only do TCP CONNECT, and a
"proxy trackers only" setting is a classic misconfiguration. There is no kill switch.

### 4. Userspace WireGuard inside the addon (desktop, no admin): later

The same trick as `tsnet` for inbound: the addon embeds a userspace WireGuard stack and opens every
socket, UDP included, through it. That gives a structural kill switch without root or Docker. It is
real work in the addon's own repo, and only matters once desktop ships acquisition (it is out of
scope for desktop v1, [desktop-app.md](desktop-app.md)).

**One provider for both directions, worth a spike:** a `tsnet` node can use a
[Mullvad exit node](https://tailscale.com/kb/1258/mullvad-exit-nodes) (a paid Tailscale add-on),
and `tsnet.Server.Loopback()` exposes a local SOCKS5 proxy. One embedded helper could then do
Funnel in and VPN out under a single Tailscale account. Open questions before promising it: UDP
over that SOCKS5 path (torrents need it), running Funnel and an exit node on the same node or
splitting them into two, and Mullvad's lack of port forwarding.

**Not recommended:** a system-wide VPN app. It is invisible to NicotinD, unverifiable, and it
fights Tailscale on macOS.

## Which VPN provider

Do not pick one for the user, and do not resell one. Accept a **standard WireGuard config**
(any provider) or a gluetun provider name plus key. What matters for P2P:

| Need | Why | Examples |
|---|---|---|
| P2P allowed | many free tiers forbid it | Proton's free tier does not allow P2P; its paid plans do |
| Port forwarding | torrent speed and seeding ratio | Proton (paid), AirVPN |
| No-logs, anonymous signup | the point of the exercise | Mullvad (no port forwarding), IVPN |

## Verification

Same idea as the inbound checklist: prove it, do not assume it.

1. **Egress differs from home.** Core asks the probe endpoint (the same stateless Worker as
   remote access, which returns the caller's IP) for its own public IP. The addon does the same
   from inside its namespace. They must differ, and the addon's must not be the home IP.
2. **DNS goes through the tunnel.** The addon resolves a per-check random hostname under the
   probe zone. The resolver IP the Worker sees must belong to the VPN, not the ISP.
3. **Kill switch holds.** Stop the tunnel (or read gluetun's control API status) and confirm the
   addon cannot reach the probe. Run this at enable time, not on a schedule.
4. **Continuous.** The addon reports its egress IP in its health output. Core pauses the addon's
   jobs (`sourceOffline`, which the job layer already treats as "never reached the network, retry
   later") whenever the egress IP equals the home IP or the check fails, and the addon card says
   why.
5. **Gate.** When a manifest declares `peerToPeer`, enabling it asks which way to go: *Route
   through VPN* (all checks green) or *Use my home connection* (an explicit, recorded consent).
   There is no silent third option.

## Plan

| Phase | What | Where |
|---|---|---|
| 1 | `network.peerToPeer` / `uploads` manifest fields, consent line, off by default, egress status on the card | `addon-sdk` + core + web |
| 2 | **Shipped:** `docker-compose.vpn.yml` (gluetun) for slskd + `vpn.env.example`. Still to do: the probe endpoint that returns the caller IP; following a provider's changing forwarded port | `docker-compose.vpn.yml`, Worker |
| 3 | Egress / DNS / kill-switch checks, and pausing jobs on a leak | core + addon health contract |
| 4 | Spike: `tsnet` + Mullvad exit node for desktop; otherwise userspace WireGuard in the addon | helper / addon repo |

## Sources

- [gluetun](https://github.com/qdm12/gluetun) and its
  [port-forwarding discussion](https://github.com/qdm12/gluetun/issues/1103);
  [per-app VPN with gluetun](https://sumguy.com/mullvad-gluetun-per-app-vpn).
- [Tailscale Mullvad exit nodes](https://tailscale.com/kb/1258/mullvad-exit-nodes);
  [`tsnet` (`Loopback` SOCKS5)](https://pkg.go.dev/tailscale.com/tsnet@v1.38.2).
- [wireproxy](https://github.com/whyvl/wireproxy): userspace WireGuard → SOCKS5, TCP only.
