# NoneOS Core

> English | [中文](README.zh-CN.md)

[![License](https://img.shields.io/badge/license-Apache%202.0_with_additional_terms-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-4.4.0-blue.svg)](package.json)
[![Handshake Server](https://github.com/kirakiray/noneos-core/actions/workflows/build-handshake-server.yml/badge.svg)](https://github.com/kirakiray/noneos-core/actions/workflows/build-handshake-server.yml)
[![Browser Tests](https://github.com/kirakiray/noneos-core/actions/workflows/browser-tests.yml/badge.svg)](https://github.com/kirakiray/noneos-core/actions/workflows/browser-tests.yml)
[![Website](https://img.shields.io/badge/website-core.noneos.com-blue.svg)](https://core.noneos.com)

**NoneOS Core** is a browser-based virtual operating system core that provides a **virtual filesystem** and a **decentralized user interconnection** system — no server-side installation required for basic usage. Applications built on NoneOS Core can read/write files in a sandboxed virtual filesystem and communicate peer-to-peer between users.

> **In essence**, NoneOS Core is an innovative **Micro-Frontend Containerization Technology**. While it *appears* as a browser-based virtual operating system, its technical essence is micro-frontend containerization built on Service Worker resource virtualization — it intercepts browser fetches through a routing layer, hosts independently published apps, and runs each one inside a sandboxed, persistent container with no server-side installation.

```js
import { getUser } from "/nos/user/main.js";

const user = await getUser("my-app");
// user.userId → unique ECDSA-based identity
// Auto-connects to relay servers for messaging

const remote = await user.connectUser(targetUserId);
await remote.send(sessionId, { text: "Hello from NoneOS!" });
```

---

## Architecture

```
┌───────────────────────────────────────────────────────────────────────┐
│                         Browser (ofajs app)                           │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │                    ofa.js Framework                           │    │
│  │             (Web Components, data binding, routing)           │    │
│  └─────────────────────┬────────────────────────────────────────┘    │
│                        │                                              │
│  ┌──────────┐  ┌──────┴──────┐  ┌─────────────────────────────┐   │
│  │  nos/fs   │  │  nos/user  │  │  nos/publish                 │   │
│  │ (OPFS-    │  │ (decent-   │  │ (DataPublisher)              │   │
│  │  backed)  │  │  ralized   │  │                              │   │
│  │           │  │  identity) │  │                              │   │
│  └──────────┘  └──────┬─────┘  └─────────────────────────────┘   │
│                        │ WebSocket relay / RTC signaling             │
├────────────────────────┼────────────────────────────────────────────┤
│                   Service Worker (sw/)                               │
│               (fetch interception, caching, routing)                 │
└────────────────────────┼────────────────────────────────────────────┘
                         │ WebSocket (wss://)
┌────────────────────────┼────────────────────────────────────────────┐
│                Rust Relay Server (server/handshake/)                      │
│  ┌──────────┐  ┌──────┴──────┐  ┌──────────────────────────────┐   │
│  │ Handshake│  │  Message    │  │  Traffic Stats               │   │
│  │ (ECDSA   │  │  Relay      │  │  (redb persistence)          │   │
│  │ P-256)   │  │             │  │                              │   │
│  └──────────┘  ├─────────────┤  ├──────────────────────────────┤   │
│                │ RTC Signal  │  │  Quota / Abuse               │   │
│                │ Tunnel      │  │  Protection                  │   │
│                │(transparent │  │                              │   │
│                │ pass-through│  └──────────────────────────────┘   │
│  ┌──────────┐  └─────────────┘  ┌──────────────────────────────┐   │
│  │  Admin   │  ┌─────────────┐  │  Memory Overload             │   │
│  │ Commands │  │  Heartbeat  │  │  Protection                  │   │
│  └──────────┘  │  Detection  │  └──────────────────────────────┘   │
│                └─────────────┘                                     │
└────────────────────────────────────────────────────────────────────┘

      ─ ─ ─  WebRTC direct (once negotiated via server) ─ ─ ─
      │                                                          │
      ▼                                                          ▼
   Browser A                                               Browser B
```

The Rust relay server provides **challenge-response authentication** (ECDSA P-256), **message relay**, and **RTC signaling tunnel** between users. Server-negotiated relay is always available as a fallback, but once peers discover each other they can switch to direct **WebRTC** connections — the relay server transparently passes SDP/ICE signaling messages as ordinary relay data, with no server-side awareness of the signaling protocol.

---

## Micro-Frontend Containerization

Although NoneOS Core *presents itself* as a virtual operating system, its technical essence is **Micro-Frontend Containerization**. The "OS" metaphor is the user-facing surface; underneath, containerization is realized through three engineering pillars:

| Pillar | What it means | Where it lives |
|--------|---------------|----------------|
| **Micro-frontend hosting** | Apps are content-addressed, independently publishable, and loaded on demand — no build-time coupling between the host and its apps. A signed manifest lets any peer distribute or serve an app. | [`nos/publish/`](nos/publish/README.md), [`nos-tool/studio/`](nos-tool/studio/) |
| **Container isolation** | Each app runs inside a sandboxed runtime: an OPFS-backed virtual filesystem for isolation and persistence, plus a decentralized identity & messaging system that acts as the app's I/O surface to the outside world. | [`nos/fs/`](nos/fs/), [`nos/user/`](nos/user/README.md) |
| **Resource virtualization** | The containerization is built on a Service Worker layer that intercepts every fetch and maps a set of *virtual URL prefixes* (`/nos/`, `/nos-tool/`, `/ncomp/`, `/gh/`, `/npm/`, `/$/`, `/$mount-.../`) to different backends — local OPFS, CDN, the official source, or remote users. The browser sees one origin, but the app perceives many. | [`sw/`](sw/) |

In short: **micro-frontend hosting** keeps apps independent, the **container** gives each app a private, persistent, connected runtime, and **resource virtualization** is the Service Worker foundation that makes the container work — all running purely in the browser.

---

## Project Structure

```
nos/                  # Core runtime modules (browser-side)
  fs/                 #   Virtual filesystem (OPFS-backed)
  user/               #   Decentralized user identity & messaging
  crypto/             #   ECDSA, E2EE, RSA, AES encryption
  publish/            #   P2P file publishing & app management
  storage/            #   Async key-value storage (IndexedDB, localStorage-like)
  locale-text/        #   Lightweight i18n (<locale-text> + getLocaleText)
  n-icon/             #   Icon component
  hybrid-data/        #   Hybrid remote + local data (experimental)
  util/               #   Hash, zip, async pool utilities
ncomp/                # Shared UI components built on nos (<n-user-name>, ...)
nos-tool/             # Built-in tools, usable by any NoneOS Core system
  studio/             #   OFA Studio (app dev environment)
  file-explore/       #   File explorer (browse / import / download OPFS files)
  system-info/        #   System info & update manager (version, SW, install)
  locale-text-tool/   #   Extract <locale-text> entries into locale-text.json
  rtc-tool/           #   Manage the WebRTC STUN/TURN server list
  _install/           #   Service worker registration & system installer
sw/                   # Service Worker (fetch interception, routing, caching)
server/               # Backend implementations
  rust/               #   Rust handshake & relay server (production)
  client/             #   Server admin dashboard (web UI)
tests/                # Browser-based test suites (.sb.html)
scripts/              # Build, signing, packing utilities
docs/                 # Multi-language documentation site (OBook)
.agents/skills/       # AI agent skill definitions
others/               # Archived / experimental code (not part of the runtime)
```

---

## Features

### Virtual Filesystem (`nos/fs/`)
- **OPFS-backed** sandboxed filesystem (`navigator.storage.getDirectory()`)
- File/directory CRUD, move, copy, observe
- Mount real local directories (Chrome File System Access API) — mounted handles persisted via IndexedDB
- Files accessible via `/$dirName/path` HTTP-style URLs
- Remote filesystem access over P2P connection

### Decentralized User System (`nos/user/`)
- **ECDSA P-256** key pair generation and identity (userId = public key hash)
- Challenge-response **authentication** against relay servers
- **Message relay** through configurable WebSocket servers
- **End-to-end encryption** (ECDH + AES-GCM) for private messages
- **WebRTC** direct peer-to-peer fallback after initial discovery
- **Service Registry** — app-level routing by `appId`, no session management needed
- **Certificate system** for role/permission management
- **Cross-tab session** support via BroadcastChannel
- Latency monitoring with automatic server selection

### Relay Server (`server/handshake/`)
- Challenge-response handshake with ECDSA P-256 signature verification
- Text and binary relay with configurable size limits
- **RTC signaling tunnel** — transparently passes SDP/ICE offers and candidates as ordinary relay data; the server is unaware it's carrying signaling
- Multi-session per user with configurable concurrency limits
- Relay abuse protection (failure counting per time window)
- Traffic statistics with redb persistence (30s granularity)
- User bandwidth quotas (configurable per user)
- Heartbeat detection for stale connection cleanup
- Memory overload protection
- Admin commands: online users, system info, traffic history, quota management

### P2P Publishing (`nos/publish/`)
- `DataPublisher` — chunked P2P file distribution (128KB chunks, signed manifest, per-chunk SHA-256)

### Key-Value Storage (`nos/storage/`)
- Async, `localStorage`-like API (`setItem` / `getItem` / `removeItem` / `clear`) backed by IndexedDB
- Stores any structured-cloneable value (Object, Array, Date, Blob, Map, Set) plus `nos/fs` handles
- Isolated stores per id, proxy syntax (`storage.key = value`), cross-tab sync via BroadcastChannel
- **Preferred over native `localStorage`** for all persistence in this project

### Service Worker Layer (`sw/`)
- Virtual URL prefixes: `/nos/`, `/nos-tool/`, `/ncomp/`, `/gh/`, `/npm/`, `/$/`, `/$mount-.../`
- SWR + in-memory TTL caching for CDN-style prefixes; OPFS-first for local system files
- **Host project offline cache** — a host project can declare a manifest of its own files via `globalThis.HOST_CACHE_CONFIG`, and the SW pre-caches and serves them offline
- Special routes: `/__config`, `/__host-cache`, `/__update-host-cache`

### Shared UI (`ncomp/`, `nos/locale-text/`, `nos/n-icon/`)
- `ncomp/` — reusable components tied to nos capabilities (`<n-user-name>`, `<n-user-status>`), referenced via `/ncomp/{name}/{name}.html`
- `nos/locale-text/` — lightweight i18n: the `<locale-text>` component plus `getLocaleText()` for scripts
- `nos/n-icon/` — icon component used across the built-in tools

### Built-in Tools (`nos-tool/`)

Every system built on NoneOS Core can use the tools under `nos-tool/` **as-is**. The Service Worker maps the virtual prefix `/nos-tool/{path}` to the official source (`https://core.noneos.com/nos-tool/{path}`, with `localhost:3002` taking priority during development), so these tools need no installation, build step, or copying into your project — just open the corresponding URL in a NoneOS Core page.

| Tool | Entry | Description |
|---|---|---|
| **File Explorer** | [`/nos-tool/file-explore/`](nos-tool/file-explore/) | Browse the OPFS virtual filesystem with breadcrumb navigation; create directories, import files/directories from the local disk, download and delete entries, copy the current path, and open files via `/$path` URLs. |
| **System Info** | [`/nos-tool/system-info/`](nos-tool/system-info/) | Inspect local / online / Service Worker versions and update state, view registered Service Workers and the active controller, then check for updates, (re)register or uninstall the SW, and run a full system update (SW → `nos.zip` → hash verification → OPFS) with progress feedback. |
| **OFA Studio** | [`/nos-tool/studio/`](nos-tool/studio/) | App dev environment: create projects from templates, manage project files, and tune the theme/color scheme. |
| **Locale Text Tool** | [`/nos-tool/locale-text-tool/`](nos-tool/locale-text-tool/) | Scan HTML files for `<locale-text>` blocks and generate a `locale-text.json` translation index. |
| **RTC Tool** | [`/nos-tool/rtc-tool/`](nos-tool/rtc-tool/) | Manage the WebRTC STUN/TURN server list: test reachability and latency, reorder, and enable/disable entries. |

`nos-tool/_install/` is not a page-level tool but the installer entry (`registerSw()`, version check, full system install) used by `<nos-version>` and the System Info tool. See [`nos-tool/README.md`](nos-tool/README.md) for the current positioning of this directory.

---

## Quick Start

Running the browser-side modules only requires any **static file server**. Node.js is used here as a convenient dev server; you can use Python, nginx, or any alternative.

### 1. Local Debugging (port 3002)

```bash
git clone https://github.com/kirakiray/noneos-core.git
cd noneos-core
npm install

# Start the dev server (port 3002) + watch service worker
npm run dev
# → opens at http://localhost:3002
```

Port **3002** is the debugging port: the Service Worker serves `/nos/` resources directly from local files (no OPFS cache), and the default handshake servers are local only (`ws://localhost:8081`, `ws://localhost:8082`).

### 2. Local Production Use (port 30028)

```bash
npm start
# → opens at http://localhost:30028
```

Use `npm start` when you want to actually *use* NoneOS Core locally rather than debug it. On any local port other than 3002, the default handshake server list also includes the online relay servers (`wss://hand3-jp1.noneos.com:4331`, `wss://hand3-us1.noneos.com:4331`, `wss://hand3-hk1.noneos.com:4331`), so you can connect with remote users without running your own relay server.

### 3. Start a Local Relay Server (optional, for multi-user testing)

```bash
# Terminal 1: start two Rust relay servers (port 8081, 8082)
npm run ws
```
Requires [Rust](https://www.rust-lang.org/) to compile.

### 4. Use in Your Own Project

Create `sw.js` at your project root:

```js
importScripts("https://core.noneos.com/sw/dist.js");
```

Install the system from your entry HTML, then use the runtime modules:

```html
<script src="https://cdn.jsdelivr.net/gh/ofajs/ofa.js"></script>
<l-m src="https://core.noneos.com/nos-tool/comps/nos-version.html"></l-m>
<nos-version auto-install></nos-version>

<script type="module">
  $("nos-version").on("installed", async () => {
    const { getUser } = await import("/nos/user/main.js");

    const user = await getUser("my-app");
    console.log("My ID:", user.userId);

    // Send a message to another user via relay server
    const remote = await user.connectUser(targetUserId);
    const sessions = await remote.getSessionIds();
    await remote.send(sessions[0], { hello: "world" });
  });
</script>
```

Once installed, the virtual prefixes are live: `/nos/...` for core modules, `/ncomp/...` for shared components, `/nos-tool/...` for the built-in tools, and `/gh/...` / `/npm/...` as cached shortcuts for jsDelivr.

---

## Documentation

Full documentation is available at **[https://core.noneos.com](https://core.noneos.com)** (multi-language: English, 中文, 日本語).

Key references:
- [User System API](nos/user/README.md) — identity, messaging, certificates, service registry
- [Virtual Filesystem API](nos/fs/README.md) — file operations, mounting, observation
- [Key-Value Storage](nos/storage/README.md) — async localStorage-like storage
- [P2P Publishing](nos/publish/README.md) — DataPublisher
- [Shared Components](ncomp/README.md) — `<n-user-name>`, `<n-user-status>`
- [i18n Module](nos/locale-text/README.md) — `<locale-text>`, `getLocaleText()`
- [Host Offline Cache](.agents/skills/noneos-core-docs/references/host-cache.md) — cache a host project's own files
- [Server Configuration](server/handshake/README.md) — relay server setup
- [AI Agent Skill](.agents/skills/noneos-core-docs/SKILL.md) — condensed docs for AI agents

---

## Scripts

| Script | Description |
|---|---|
| `npm run dev` | Start static server (port 3002) + watch service worker — **for local debugging** |
| `npm start` | Start static server (port 30028) — **for local production use / automated tests** |
| `npm run static` | Static server only (port 3002) |
| `npm run watch:sw` | Rebuild the service worker on `sw/src/**` changes |
| `npm run build` | Build all: hashes → nos.zip → service worker → skill package |
| `npm run build:sw` | Build the service worker via Rollup (`sw/dist.js` + `sw/dist.min.js`) |
| `npm run build:hashes` | Compute and sign hashes of `nos/` sources (consumed by `nos.json`) |
| `npm run build:skill` | Build the `.agents/skills/noneos-core-docs` knowledge base (`noneos-core-docs.zip`) |
| `npm run bump` | Increment version across all files, then reinstall & rebuild |
| `npm run ws` | Start two Rust relay servers (test mode, ports 8081 & 8082) |
| `npm run ws1` / `npm run ws2` | Start a single Rust relay server (port 8081 / 8082) |
| `npm run test` | Run browser-based test suites (`sb-test`) |

> **Important**: after changing anything under `sw/src/`, you must re-run `npm run build:sw` (or keep `npm run watch:sw` running), otherwise the deployed service worker won't pick up the change.

---

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feat/my-feature`
3. Commit changes: `git commit -am 'Add my feature'`
4. Push: `git push origin feat/my-feature`
5. Open a [Pull Request](https://github.com/kirakiray/noneos-core/pulls)

For bugs and feature requests, please [open an issue](https://github.com/kirakiray/noneos-core/issues).

---

## License

[Apache 2.0 with additional terms](LICENSE) © NoneOS Contributors
