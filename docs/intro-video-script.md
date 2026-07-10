# NicotinD — Intro Video Script

A single introduction video in **two segments**:

- **Segment A — Set it up** (for self-hosters/installers): what NicotinD is, how to run it, every setup step, environment settings, mandatory vs optional keys, network configuration, and how to upgrade.
- **Segment B — Use it** (for end users): a short demo of the day-to-day experience.

**Format:** two-column shot list. Left column = what's on screen / the action to record. Right column = the voiceover to read. Estimated runtime ~8–11 min (≈5 min Segment A, ≈4–6 min Segment B). Trim optional scenes (marked *optional*) for a tighter cut.

**Voiceover tone:** friendly, confident, unhurried. Read the right column verbatim or paraphrase to taste. Bracketed `[…]` notes in the narration column are director cues, not spoken.

---

## Segment A — Set It Up (self-hoster)

### Scene A1 — Cold open: what NicotinD is

| On screen (visual / action) | Narration (voiceover) |
|---|---|
| Logo animation, then a quick montage: the web UI library grid, a track playing, a phone showing the same app. | This is **NicotinD** — a self-hosted music platform that does two things at once. It **finds and downloads** music for you, and it **streams** your library to any device — web, desktop, Android, iOS. One app, one library, fully yours. |
| Cut to the architecture diagram from the README (NicotinD box on top, slskd / Lidarr / analysis underneath). Highlight the `:8484` label. | Under the hood it orchestrates a few services — the Soulseek client **slskd** for peer-to-peer downloads, **Lidarr** for rich metadata, and an optional analysis engine — but you only ever see one thing: **NicotinD on port 8484**. Everything else stays tucked away inside. |

### Scene A2 — Prerequisites

| On screen (visual / action) | Narration (voiceover) |
|---|---|
| Two cards side by side: "Docker (recommended)" and "Local dev". | You've got two ways to run it. The easy path is **Docker** — one command and you're live. |
| Highlight the local-dev card: "Bun ≥ 1.1 · Node ≥ 22.22.3". | Or, if you'd rather run it from source, you'll want **Bun 1.1 or newer** and **Node 22** for the web build. We'll focus on Docker — it's the recommended route. |

### Scene A3 — Quick start with Docker

| On screen (visual / action) | Narration (voiceover) |
|---|---|
| Terminal, type the three commands one at a time:<br>`git clone https://github.com/kevinch3/NicotinD.git`<br>`cd NicotinD`<br>`docker compose up -d` | Clone the repo, step into it, and run **`docker compose up -d`**. That's it. |
| Show the containers coming up (nicotind, slskd, lidarr, analysis). | Compose brings up the whole stack for you — NicotinD itself, the slskd Soulseek client, a bundled Lidarr for metadata, and the optional audio-analysis sidecar. |
| Browser opens `http://localhost:8484`. | Then open **localhost:8484**. And here's the nice part — **no `.env` file, no manual config**. A setup wizard takes it from here. |
| Lower-third caption: "Your data lives in 4 volumes: music · nicotind-data · slskd-data · lidarr-config". | Your library, database, and settings live in persistent volumes, so they survive restarts and upgrades. |

### Scene A4 — The setup wizard

| On screen (visual / action) | Narration (voiceover) |
|---|---|
| The `/setup` wizard, Step 1 "Admin Account". Type a username + password. | The first account you create becomes the **admin** — no invite needed, you're the owner of this server. |
| Step 2 "Library" — music directory field, defaulting to `~/Music`. | Step two: point it at your **music folder**. This is where downloads land and where NicotinD scans and streams from. |
| Step 3 "Quality" — a lossless→Opus toggle and a bitrate selector (128 / 192 / 256). | Step three, quality. NicotinD can standardize lossless downloads to **Opus** to keep files small and browser-friendly — on by default at 192 kbps. Leave it, or turn it off to keep originals. |
| Step 4 "Soulseek" — optional username/password fields. | Step four: your **Soulseek credentials**. This is optional right now — you can skip it and add it later — but it's what lets you download from the network. |
| Expand the collapsed **Advanced Services** panel: Lidarr URL + API key. | And tucked under **Advanced**, you can wire in **Lidarr** for metadata — the Docker stack already ships one, so it's pre-filled. |
| Finish; a toast reads "Lidarr will be available after restarting NicotinD". | Finish up, and if you just configured Lidarr, it'll ask for a quick restart. Then you're in. |

### Scene A5 — Mandatory keys (the honest version)

| On screen (visual / action) | Narration (voiceover) |
|---|---|
| Title card: "What's actually required?" | Let's be straight about configuration. |
| Big check: "To *boot*: nothing." Sub-text: "Secrets auto-generate." | To simply **start** NicotinD, you need **nothing** — the JWT secret, internal passwords, all of it is generated for you on first run. |
| Show `.env.example` scrolled to the core vars: `NICOTIND_PORT`, `NICOTIND_DATA_DIR`, `NICOTIND_MUSIC_DIR`, `NICOTIND_MODE`. | The core knobs, if you ever want to override them by environment variable, are the **port** (8484), the **data directory**, the **music directory**, and the **mode** — `embedded`, where NicotinD manages its own services, or `external`, which is what Docker uses. |
| Highlight `SOULSEEK_USERNAME` / `SOULSEEK_PASSWORD`. | The one credential that actually matters for the core feature — downloading — is your **Soulseek account**. Set `SOULSEEK_USERNAME` and `SOULSEEK_PASSWORD`, or just use the wizard. |
| Caption: "slskd web login defaults to slskd / slskd". | The internal slskd login defaults to `slskd` / `slskd` — you only touch that if you change slskd's own credentials. |

### Scene A6 — Optional keys & integrations

| On screen (visual / action) | Narration (voiceover) |
|---|---|
| Title card: "Turn these on when you want more." | Everything past that is opt-in. Here's the menu. |
| List item: **Lidarr** — `NICOTIND_LIDARR_URL`, `LIDARR_API_KEY`. | **Lidarr** unlocks catalog search, metadata cleanup, and automatic acquisition. It's bundled in Docker, so it's already working. |
| List item: **Spotify fallback** — `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`. | **Spotify** adds a metadata fallback lane — when Soulseek comes up empty, it finds the album on Spotify and grabs it via spotDL. Register an app on Spotify's dashboard, then enable it under **Settings → Extensions**. |
| List item: **Analysis sidecar** — `NICOTIND_ANALYSIS_URL`, note "optional GPU: `--build-arg GPU=1`". | The **analysis sidecar** adds mood, danceability, and valence — the ingredients for smart radio. It's bundled, degrades gracefully if it's down, and can run on a GPU for a big speed-up. |
| List item: **Sentry** — `NICOTIND_SENTRY_DSN` (empty = off). | **Sentry** is opt-in error tracking. Leave the DSN empty and it's completely off. |
| List item: **Lyrics (LRCLIB)** — "zero setup, no key". | And **lyrics** work out of the box — no key, no setup, on by default. |
| Quick-scroll a "behavior toggles" list: metadata auto-fix, lossless→Opus, download retry & fallback, auto-acquire *(default-off)*. | There are also behavior toggles — automatic tag repair, the lossless-to-Opus conversion, download retry and cross-peer fallback, and an **auto-acquisition** poller that fills gaps in your Lidarr wishlist unattended. That last one is **off by default** — it downloads on its own, so enable it deliberately. |

### Scene A7 — Network configuration (good to know)

| On screen (visual / action) | Narration (voiceover) |
|---|---|
| Diagram: internet → reverse proxy → NicotinD `:8484`. Caption: "Expose only 8484." | A few networking notes for exposing this to the outside world. Publish **only port 8484**, put a reverse proxy in front, and set **`NICOTIND_PUBLIC_URL`** to your public address. |
| Callout box: "Enable WebSockets at the proxy (Cloudflare: Network → WebSockets)." | One gotcha: remote playback uses **WebSockets**. Make sure your proxy allows them — on Cloudflare, flip on **Network → WebSockets** — or the connection upgrade gets dropped. |
| Callout box *(optional)*: "Soulseek P2P port 50300 — forward for active connections." | *[Optional]* For better Soulseek connectivity, you can forward the peer-to-peer listen port, **50300**, on your router. It's internal by default, so this is an advanced, optional tweak. |
| Callout box: "Remote playback works out of the box on your network." | Remote playback — casting between your own browser tabs and devices — works across your network with no extra setup. |

### Scene A8 — Upgrades

| On screen (visual / action) | Narration (voiceover) |
|---|---|
| Terminal: `git pull` then `docker compose up --build -d`. | Upgrading is simple. Pull the latest — or check out a specific version tag — and run **`docker compose up --build -d`**. Your volumes persist, so the database, library, and secrets all carry over untouched. |
| Show the in-app changelog modal opening from the clickable version string. | Every release has a changelog, and you can read it right in the app — just click the **version number**. |
| Caption *(optional)*: "One-time migration available: Lossless → Opus sweep (Admin)". | *[Optional]* If you're coming from an older library, there's a one-time **Lossless-to-Opus** sweep in the Admin panel — with a dry-run option — to standardize files you already have. |
| Caption: "Mobile: grab the new APK / IPA from the GitHub Release." | And the mobile apps upgrade by grabbing the new build attached to each **GitHub Release**. |

---

## Segment B — Use It (end user)

### Scene B1 — First login

| On screen (visual / action) | Narration (voiceover) |
|---|---|
| Log in as a regular user. The welcome banner appears at the top. | If your admin set you up with an account, logging in is all you do — you land straight in the shared library. |
| Zoom on the banner text, then click **Got it**. | A quick welcome — *"Browse the library, search Soulseek, or start playing music"* — click **Got it**, and it's gone for good. |

### Scene B2 — Search is one omnibox

| On screen (visual / action) | Narration (voiceover) |
|---|---|
| The search page. Type into the box with placeholder "Search music or paste a link…". | Everything starts here. One search box — **"Search music or paste a link."** |
| Results populate: album cards, artist pills, then a blended **Results** list with neutral source chips and a **Get** button on each row. | And here's the whole idea: you don't pick a source. You search for music, and you get **one ranked list**. Each result shows where it's from as a small chip — but there's just **one button: Get**. |
| Hover the collapsed "Advanced: browse Soulseek peers & folders" disclosure. | Power users can crack open **Advanced** to browse raw Soulseek peers and folders — but most of the time, you'll never need to. |

### Scene B3 — Acquire an album

| On screen (visual / action) | Narration (voiceover) |
|---|---|
| Click an album card. The **Album Hunt** modal opens, showing search queries running, then a "★ Best match (auto)" row with a match % and size. | Click an album, and NicotinD **hunts** for it — you can watch it search — then it auto-picks the **best match**, showing you the confidence and file size. |
| Click Get / confirm. The download row walks through stages: **Queued → Downloading → Organizing → Scanning → Done**. | One tap. From there it's hands-off: it downloads, organizes the files, tags them, and scans them into your library. |
| The row ends with an **Open in Library** button; click it to jump to the album. | When it's done, **Open in Library** takes you right to it. It just shows up, clean and playable. |

### Scene B4 — Paste a link *(optional)*

| On screen (visual / action) | Narration (voiceover) |
|---|---|
| Paste a YouTube or Bandcamp URL into the same search box. A "link-intent card" appears with a **Get** button. | The same box takes **links**, too. Paste a YouTube, Bandcamp, or archive URL, and NicotinD offers to grab it directly. |
| Click Get; the card shows progress, then "Added to library ✓ · Open". | It figures out the right downloader behind the scenes, pulls the audio, and drops it straight into your library. |

### Scene B5 — Browse the library

| On screen (visual / action) | Narration (voiceover) |
|---|---|
| The Library page. Click across the modes: **Albums · Compilations · Singles · Artists · Genre · Playlists**. | Your library is organized the way you'd expect — **Albums, Compilations, Singles and EPs, Artists, Genres, and Playlists**. |
| Open the Sort dropdown and the Filters disclosure. | Sort by newest, most played, or A-to-Z, and filter it down when you want something specific. |
| Open an album detail page; point to **Play**, **Download** (offline), and **Share**. | Each album gives you **Play**, an **offline download** for when you're off the grid, and a **Share** link. |

### Scene B6 — Play it: Now Playing, lyrics, radio

| On screen (visual / action) | Narration (voiceover) |
|---|---|
| Start a track. The mini-player appears at the bottom; swipe/tap up to open the full **Now Playing** sheet. | Hit play, and the mini-player rides along the bottom. Swipe it up for the full **Now Playing** view — big art, a seek bar, and full controls. |
| Show the **Queue** — drag to reorder, remove a row, Clear link. | Manage your queue right here — drag to reorder, remove, or clear. |
| Toggle **Lyrics**; the synced karaoke view scrolls and highlights the active line. | Toggle **lyrics** for a synced, karaoke-style view that follows along. |
| Toggle **Radio** ("Radio on"). Let the queue run low and show new tracks auto-appending. | And turn on **Radio**. When your queue runs low, NicotinD keeps the music going — matching tempo, key, genre, and mood so the vibe never breaks. |

### Scene B7 — Playlists

| On screen (visual / action) | Narration (voiceover) |
|---|---|
| The Playlists tab: "Made for you" curated shelves (gradient covers) and "Your playlists". | There are curated shelves **made for you** — refreshed automatically — and then there's **your** collection. |
| Click **Create**, then the **✨ Generate from your favorites** button. | Build a playlist by hand, or hit **Generate from your favorites** and let NicotinD assemble one from the songs you've starred. |

### Scene B8 — Remote playback (cast to another device)

| On screen (visual / action) | Narration (voiceover) |
|---|---|
| In the player bar, click the speaker/device icon. A popover lists connected devices. Pick another one. | See this speaker icon? That's **remote playback**. Every browser tab and device you've got open is a target. |
| Audio starts on the second device while the first tab keeps the controls. | Pick another device and the audio moves there — while you keep **controlling** it from here. Play, pause, skip, seek, all in sync. It's Spotify-Connect, but for your own library. |

### Scene B9 — Admin coda *(optional)*

| On screen (visual / action) | Narration (voiceover) |
|---|---|
| As admin, open the **Admin** panel. Show the user table with **Online / Devices / Sessions** columns. | If you're the admin, there's a control room. Manage users, and see who's online right now, and on how many devices. |
| Scroll to **Library processing** — per-task toggles (BPM, Genre, Key, Audio features), a time window, Run now. | Down here is **library processing** — the background engine that analyzes tempo, key, genre, and mood. That's what powers smart radio, and it runs quietly in an off-hours window. |
| Open **Extensions**; show sources being enabled. Cut back to a fresh Search reading "No acquisition sources enabled." | And **Extensions** is the gate for everything: no download source does anything until you switch it on — which is why a brand-new install tells you *"No acquisition sources enabled."* You're always in control of what's active. |

### Scene B10 — Outro

| On screen (visual / action) | Narration (voiceover) |
|---|---|
| Montage recap: search → get → library → play → cast. End on the logo. | So that's NicotinD — **find it, download it, own it, and play it anywhere**. One server, your whole music world. |
| Lower third: "github.com/kevinch3/NicotinD · Android & iOS on the Releases page". | Grab it on **GitHub**, install the mobile apps from the **Releases** page, and make it yours. Thanks for watching. |
