# Acquisition egress: VPN for peer-to-peer addons

> **Proposed, NOT built.** Companion to [remote-access-options.md](remote-access-options.md),
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

### 1. Network-namespace isolation (Docker): recommended

Run a VPN container ([gluetun](https://github.com/qdm12/gluetun): WireGuard/OpenVPN, about 30
providers, a built-in firewall) and attach the addon to its network stack:

```yaml
vpn:
  image: qmcgaw/gluetun:<pinned>
  cap_add: [NET_ADMIN]
  devices: [/dev/net/tun]
  environment:
    VPN_SERVICE_PROVIDER: ${VPN_PROVIDER}
    VPN_TYPE: wireguard
    WIREGUARD_PRIVATE_KEY: ${VPN_WG_KEY}
    FIREWALL_OUTBOUND_SUBNETS: 172.16.0.0/12   # lets the addon answer core on the compose network
    VPN_PORT_FORWARDING: ${VPN_PORT_FORWARDING:-off}
torrent-addon:
  network_mode: "service:vpn"   # no network stack of its own
```

- **The kill switch is structural.** The addon has no interface except the tunnel, so when the VPN
  drops it has no network at all. There is no setting to get wrong, and no leak through DHT, UDP,
  or DNS.
- Core reaches the addon at the `vpn` service's hostname, because the addon's ports live on that
  container.
- The compose file already uses this exact mechanism: `ytdlp-pot-provider` shares
  `ytdlp-addon`'s stack with `network_mode: "service:ytdlp-addon"`. Shipping it is a compose
  profile (`vpn`) plus documentation, not new code in core.
- **Port forwarding** decides torrent speed. Without an inbound port, the client can only connect
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
| 2 | `vpn` compose profile (gluetun) + docs for P2P addons; probe endpoint returns caller IP | `docker-compose.yml`, Worker |
| 3 | Egress / DNS / kill-switch checks, and pausing jobs on a leak | core + addon health contract |
| 4 | Spike: `tsnet` + Mullvad exit node for desktop; otherwise userspace WireGuard in the addon | helper / addon repo |

## Sources

- [gluetun](https://github.com/qdm12/gluetun) and its
  [port-forwarding discussion](https://github.com/qdm12/gluetun/issues/1103);
  [per-app VPN with gluetun](https://sumguy.com/mullvad-gluetun-per-app-vpn).
- [Tailscale Mullvad exit nodes](https://tailscale.com/kb/1258/mullvad-exit-nodes);
  [`tsnet` (`Loopback` SOCKS5)](https://pkg.go.dev/tailscale.com/tsnet@v1.38.2).
- [wireproxy](https://github.com/whyvl/wireproxy): userspace WireGuard → SOCKS5, TCP only.
