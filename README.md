# NoneOS Core

> English | [中文](README.zh-CN.md)

[![License](https://img.shields.io/badge/license-Apache%202.0_with_additional_terms-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-5.0.0-blue.svg)](package.json)
[![Browser Tests](https://github.com/kirakiray/noneos-core/actions/workflows/browser-tests.yml/badge.svg)](https://github.com/kirakiray/noneos-core/actions/workflows/browser-tests.yml)
[![Website](https://img.shields.io/badge/website-core.noneos.com-blue.svg)](https://core.noneos.com)

> **5.0** replaces the old user/identity/messaging, publishing and Rust relay implementations with a new `PeerSession + Link` architecture (relay + optional WebRTC), ECDSA identity, E2EE, service discovery and a Rust relay server.

**NoneOS Core** is a browser-based virtual operating system core that provides a **virtual filesystem** and a **decentralized user interconnection** system — no server-side installation required for basic usage. Applications built on NoneOS Core can read/write files in a sandboxed virtual filesystem and communicate peer-to-peer between users.

> **In essence**, NoneOS Core is an innovative **Micro-Frontend Containerization Technology**. While it *appears* as a browser-based virtual operating system, its technical essence is micro-frontend containerization built on Service Worker resource virtualization — it intercepts browser fetches through a routing layer, hosts independently published apps, and runs each one inside a sandboxed, persistent container with no server-side installation.

---

## Architecture

```
Browser
├─ ofa.js app (Web Components / routing)
├─ nos/fs       OPFS virtual filesystem
├─ nos/storage  IndexedDB key-value storage
├─ nos/peer     PeerSession + Link (5.0)
│    ├─ RTC Link   leader tab owns RTCPeerConnection
│    └─ WS Relay   SharedWorker owns the persistent relay connection
└─ sw/          resource virtualization (/nos, /nos-lib, /gh, /npm, /$, /$mount-*)

Relay: server/relay (Rust WebSocket relay + offline mailbox).
```

## Micro-Frontend Containerization

Although NoneOS Core *presents itself* as a virtual operating system, its technical essence is **Micro-Frontend Containerization**. The "OS" metaphor is the user-facing surface; underneath, containerization is realized through three engineering pillars:

| Pillar | What it means | Where it lives |
|--------|---------------|----------------|
| **Micro-frontend hosting** | Apps are content-addressed, independently publishable, and loaded on demand — no build-time coupling between the host and its apps. A signed manifest lets any peer distribute or serve an app. | `nos/peer` |
| **Container isolation** | Each app runs inside a sandboxed runtime: an OPFS-backed virtual filesystem for isolation and persistence, plus a decentralized identity & messaging system that acts as the app's I/O surface to the outside world. | [`nos/fs/`](nos/fs/), `nos/peer` |
| **Resource virtualization** | The containerization is built on a Service Worker layer that intercepts every fetch and maps a set of *virtual URL prefixes* (`/nos/`, `/nos-lib/`, `/nos-tool/`, `/gh/`, `/npm/`, `/$/`, `/$mount-.../`) to different backends — local OPFS, CDN, the official source, or remote users. The browser sees one origin, but the app perceives many. | [`sw/`](sw/) |

In short: **micro-frontend hosting** keeps apps independent, the **container** gives each app a private, persistent, connected runtime, and **resource virtualization** is the Service Worker foundation that makes the container work — all running purely in the browser.

---

## Project Structure

```
nos/                  # Core runtime modules (browser-side)
  fs/                 #   Virtual filesystem (OPFS-backed)
  crypto/             #   ECDSA, RSA, AES encryption
  storage/            #   Async key-value storage (IndexedDB, localStorage-like)
  util/               #   Hash, zip, async pool utilities
nos-lib/              # Official online library (CDN-served, outside the signed pack)
  nos-version/        #   <nos-version> install/upgrade entry component
  _install/           #   SW registration & system installer bootstrap
  locale-text/        #   Lightweight i18n (<locale-text> + getLocaleText)
  n-icon/             #   Icon component
  nos-lib.json        #   Signed file manifest (verified by the service worker)
nos-tool/             # Built-in tools, usable by any NoneOS Core system
  file-explore/       #   File explorer (browse / import / download OPFS files)
  system-info/        #   System info & update manager (version, SW, install)
  locale-text-tool/   #   Extract <locale-text> entries into locale-text.json
  rtc-tool/           #   Manage the WebRTC STUN/TURN server list
sw/                   # Service Worker (fetch interception, routing, caching)
server/relay/         # Rust WebSocket relay (auth, mailbox, services)
tests/                # Browser-based test suites (.sb.html)
scripts/              # Build, signing, packing utilities
.agents/skills/       # AI agent skill definitions
```

---

## Features

### Virtual Filesystem (`nos/fs/`)
- **OPFS-backed** sandboxed filesystem (`navigator.storage.getDirectory()`)
- File/directory CRUD, move, copy, observe
- Mount real local directories (Chrome File System Access API) — mounted handles persisted via IndexedDB
- Files accessible via `/$dirName/path` HTTP-style URLs

### Peer Interconnect (`nos/peer/`)
- `PeerSession` — transport-agnostic reliability: sequence numbers, cumulative ACK, retransmit, reorder buffer and dedup
- `RelayMux` — many peers over one WebSocket; SharedWorker owns the socket and broadcasts to tabs
- Optional WebRTC — leader tab owns `RTCPeerConnection`; SharedWorker proxies frames and falls back to the relay
- ECDSA P-256 identity (`userId = sha256(publicKey)`), challenge-response auth, E2EE and appId service discovery

### Relay Server (`server/relay/`)
- WebSocket binary relay: routes mux frames by `from` / `to`, verifies `from` against the connection userId
- Multi-connection per user; offline mailbox (memory or `--mailbox <file>`), TTL 1h
- Public-key lookup and appId service discovery
- ECDSA P-256 challenge-response auth + public-key lookup; persistent mailbox via `--mailbox`

### Key-Value Storage (`nos/storage/`)
- Async, `localStorage`-like API (`setItem` / `getItem` / `removeItem` / `clear`) backed by IndexedDB
- Stores any structured-cloneable value (Object, Array, Date, Blob, Map, Set) plus `nos/fs` handles
- Isolated stores per id, proxy syntax (`storage.key = value`), cross-tab sync via BroadcastChannel
- **Preferred over native `localStorage`** for all persistence in this project

### Service Worker Layer (`sw/`)
- Virtual URL prefixes: `/nos/`, `/nos-lib/`, `/nos-tool/`, `/gh/`, `/npm/`, `/$/`, `/$mount-.../`
- SWR + in-memory TTL caching for CDN-style prefixes; OPFS-first for local system files
- Special route: `/__config`
- `nos-lib/` files are verified against the signed `nos-lib/nos-lib.json` before being written to the OPFS cache

### Shared UI (`nos-lib/`)
- `nos-lib/` — official online library: `<nos-version>`, `<locale-text>`, `<n-icon>`, referenced via `/nos-lib/{name}/{name}.html`
- `nos-lib/nos-version/` — `<nos-version>` install/upgrade entry component; `nos-lib/_install/` is its bootstrap (SW registration, version check, full install, root-cert trust verification), also used by the System Info tool — see [`nos-lib/README.md`](nos-lib/README.md)
- `nos-lib/locale-text/` — lightweight i18n: the `<locale-text>` component plus `getLocaleText()` for scripts
- `nos-lib/n-icon/` — icon component used across the built-in tools
- `nos-lib/nos-lib.json` — signed file manifest verified by the service worker before caching `nos-lib` files |

### Built-in Tools (`nos-tool/`)

Every system built on NoneOS Core can use the tools under `nos-tool/` **as-is**. The Service Worker maps the virtual prefix `/nos-tool/{path}` to the official source (`https://core.noneos.com/nos-tool/{path}`, with `localhost:3002` taking priority during development), so these tools need no installation, build step, or copying into your project — just open the corresponding URL in a NoneOS Core page.

| Tool | Entry | Description |
|---|---|---|
| **File Explorer** | [`/nos-tool/file-explore/`](nos-tool/file-explore/) | Browse the OPFS virtual filesystem with breadcrumb navigation; create directories, import files/directories from the local disk, download and delete entries, copy the current path, and open files via `/$path` URLs. |
| **System Info** | [`/nos-tool/system-info/`](nos-tool/system-info/) | Inspect local / online / Service Worker versions and update state, view registered Service Workers and the active controller, then check for updates, (re)register or uninstall the SW, and run a full system update (SW → `nos.tgz` → hash verification → OPFS) with progress feedback. |
| **Locale Text Tool** | [`/nos-tool/locale-text-tool/`](nos-tool/locale-text-tool/) | Scan HTML files for `<locale-text>` blocks and generate a `locale-text.json` translation index. |
| **RTC Tool** | [`/nos-tool/rtc-tool/`](nos-tool/rtc-tool/) | Manage the WebRTC STUN/TURN server list: test reachability and latency, reorder, and enable/disable entries. |

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

### 3. Use in Your Own Project

Create `sw.js` at your project root:

```js
importScripts("https://core.noneos.com/sw/dist.js");
```

Install the system from your entry HTML, then use the runtime modules:

```html
<script src="https://cdn.jsdelivr.net/gh/ofajs/ofa.js@5/dist/ofa.min.js"></script>
<l-m src="https://core.noneos.com/nos-lib/nos-version/nos-version.html"></l-m>
<nos-version auto-install></nos-version>

<script type="module">
  $("nos-version").on("installed", async () => {
    const { get } = await import("/nos/fs/main.js");
    const file = await get("my-app/hello.txt", { create: "file" });
    await file.write("hello");
  });
</script>
```

Once installed, the virtual prefixes are live: `/nos/...` for core modules, `/nos-lib/...` for shared components and the installer, `/nos-tool/...` for the built-in tools, and `/gh/...` / `/npm/...` as cached shortcuts for jsDelivr.

---

## Documentation

Full documentation is available at **[https://core.noneos.com](https://core.noneos.com)** (multi-language: English, 中文, 日本語).

Key references:
- [Virtual Filesystem API](nos/fs/README.md) — file operations, mounting, observation
- [Key-Value Storage](nos/storage/README.md) — async localStorage-like storage
- [Official Online Library](nos-lib/README.md) — `<nos-version>`, `<locale-text>`, `<n-icon>`, `_install/`
- [i18n Module](nos-lib/locale-text/README.md) — `<locale-text>`, `getLocaleText()`
- [AI Agent Skill](.agents/skills/noneos-core-docs/SKILL.md) — condensed docs for AI agents

---

## Scripts

| Script | Description |
|---|---|
| `npm run dev` | Start static server (port 3002) + watch service worker — **for local debugging** |
| `npm start` | Start static server (port 30028) — **for local production use / automated tests** |
| `npm run static` | Static server only (port 3002) |
| `npm run watch:sw` | Rebuild the service worker on `sw/src/**` changes |
| `npm run build` | Build all: hashes → nos.tgz → service worker → skill package |
| `npm run build:sw` | Build the service worker via Rollup (`sw/dist.js` + `sw/dist.min.js`) |
| `npm run build:hashes` | Compute and sign hashes of `nos/` sources (consumed by `nos.json`) and `nos-lib/` sources (consumed by `nos-lib/nos-lib.json`) |
| `npm run build:skill` | Build the `.agents/skills/noneos-core-docs` knowledge base (`noneos-core-docs.zip`) |
| `npm run bump` | Increment version across all files, then reinstall & rebuild |
| `npm run relay` | Start the new Rust relay server (default port 8081) |
| `npm run test:relay` | Run Rust relay tests |
| `npm run test:peer` | Run Stage 1/2 PeerSession tests |
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
