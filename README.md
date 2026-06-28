# NoneOS Core

[![License](https://img.shields.io/badge/license-Apache%202.0_with_additional_terms-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-4.1.2-blue.svg)](package.json)
[![Rust Server](https://github.com/kirakiray/noneos-core/actions/workflows/build-rust-server.yml/badge.svg)](https://github.com/kirakiray/noneos-core/actions/workflows/build-rust-server.yml)
[![Browser Tests](https://github.com/kirakiray/noneos-core/actions/workflows/browser-tests.yml/badge.svg)](https://github.com/kirakiray/noneos-core/actions/workflows/browser-tests.yml)
[![Documentation](https://img.shields.io/badge/docs-core.noneos.com-green.svg)](https://core.noneos.com)

**NoneOS Core** is a browser-based virtual operating system core that provides a **virtual filesystem** and a **decentralized user interconnection** system — no server-side installation required for basic usage. Applications built on NoneOS Core can read/write files in a sandboxed virtual filesystem and communicate peer-to-peer between users.

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
┌──────────────────────────────────────────────────────────┐
│                    Browser (ofajs app)                    │
│  ┌──────────┐  ┌──────────┐  ┌───────────────────────┐  │
│  │  nos/fs   │  │ nos/user │  │ nos/publish           │  │
│  │ (OPFS-    │  │ (decent- │  │ (DataPublisher        │  │
│  │  backed)  │  │ ralized  │  │  & AppManager)        │  │
│  │           │  │ identity)│  │                       │  │
│  └──────────┘  └────┬─────┘  └───────────────────────┘  │
│                      │ WebSocket relay / RTC signaling   │
├──────────────────────┼──────────────────────────────────┤
│              Service Worker (sw/)                        │
│         (fetch interception, caching, routing)           │
└──────────────────────┼──────────────────────────────────┘
                       │ WebSocket (wss://)
┌──────────────────────┼──────────────────────────────────┐
│         Rust Relay Server (server/rust/)                 │
│  ┌──────────┐ ┌───────────┐ ┌────────────────────────┐  │
│  │Handshake │ │  Message  │ │ Traffic Stats          │  │
│  │(ECDSA    │ │  Relay    │ │ (redb persistence)     │  │
│  │Challenge)│ │           │ │                        │  │
│  └──────────┘ ├───────────┤ ├────────────────────────┤  │
│               │ RTC Sig-  │ │ Quota / Abuse          │  │
│               │ nal Tunnel│ │ Protection             │  │
│               │(transpar- │ │                        │  │
│               │ ent pass- │ │                        │  │
│               │ through)  │ │                        │  │
│  ┌──────────┐ └───────────┘ └────────────────────────┘  │
│  │ Admin    │ ┌───────────┐ ┌────────────────────────┐  │
│  │ Commands │ │ Heartbeat │ │ Memory Overload        │  │
│  │          │ │ Detection │ │ Protection             │  │
│  └──────────┘ └───────────┘ └────────────────────────┘  │
└──────────────────────────────────────────────────────────┘

     ─ ─ ─  WebRTC direct (once negotiated via server) ─ ─ ─
     │                                                     │
     ▼                                                     ▼
  Browser A                                         Browser B
```

The Rust relay server provides **challenge-response authentication** (ECDSA P-256), **message relay**, and **RTC signaling tunnel** between users. Server-negotiated relay is always available as a fallback, but once peers discover each other they can switch to direct **WebRTC** connections — the relay server transparently passes SDP/ICE signaling messages as ordinary relay data, with no server-side awareness of the signaling protocol.

---

## Project Structure

```
nos/                  # Core runtime modules (browser-side)
  fs/                 #   Virtual filesystem (IndexedDB-backed)
  user/               #   Decentralized user identity & messaging
  crypto/             #   ECDSA, E2EE, RSA, AES encryption
  publish/            #   P2P file publishing & app management
  ai/                 #   AI chat utilities
  util/               #   Hash, zip, async pool utilities
nos-tool/             # Desktop-like UI tools
  studio/             #   OFA Studio (app dev environment)
  editor/             #   Monaco-based code editor
  file-explore/       #   File explorer
sw/                   # Service Worker (fetch interception, routing, caching)
server/               # Backend implementations
  rust/               #   Rust handshake & relay server (production)
  client/             #   Server admin dashboard (web UI)
_install/             # Service worker registration & system installer
tests/                # Browser-based test suites (.sb.html)
scripts/              # Build, signing, packing utilities
docs/                 # Multi-language documentation site (OBook)
skills/               # AI agent skill definitions
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

### Relay Server (`server/rust/`)
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
- `DataPublisher` — chunked P2P file distribution
- `AppManager` — app creation, publishing, discovery, installation & updates

---

## Quick Start

Running the browser-side modules only requires any **static file server**. Node.js is used here as a convenient dev server; you can use Python, nginx, or any alternative.

### 1. Quick Start with Node.js

```bash
git clone https://github.com/kirakiray/noneos-core.git
cd noneos-core
npm install

# Start the dev server (port 3002) + build service worker
npm run dev
# → opens at http://localhost:3002
```

### 2. Start a Local Relay Server (optional, for multi-user testing)

```bash
# Terminal 1: start two Rust relay servers (port 8081, 8082)
npm run ws
```
Requires [Rust](https://www.rust-lang.org/) to compile.

### 3. Use in Your App

```html
<script src="https://cdn.jsdelivr.net/gh/ofajs/ofa.js"></script>
<script type="module">
  import { getUser } from "/nos/user/main.js";

  const user = await getUser("my-app");
  console.log("My ID:", user.userId);

  // Send a message to another user via relay server
  const remote = await user.connectUser(targetUserId);
  const sessions = await remote.getSessionIds();
  await remote.send(sessions[0], { hello: "world" });
</script>
```

---

## Documentation

Full documentation is available at **[https://core.noneos.com](https://core.noneos.com)** (multi-language: English, 中文, 日本語).

Key references:
- [User System API](nos/user/README.md) — identity, messaging, certificates, service registry
- [Virtual Filesystem API](nos/fs/) — file operations, mounting, observation
- [P2P Publishing](nos/publish/README.md) — DataPublisher & AppManager
- [Server Configuration](server/rust/README.md) — relay server setup

---

## Scripts

| Script | Description |
|---|---|
| `npm run dev` | Start static server (port 3002) + watch service worker |
| `npm run build` | Build all: hashes → nos.zip → service worker |
| `npm run bump` | Increment version across all files |
| `npm run ws` | Start two Rust relay servers (test mode, ports 8081 & 8082) |
| `npm run test` | Run browser-based test suites |

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
