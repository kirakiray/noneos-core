# NoneOS Core

NoneOS Core is a lightweight core engine designed specifically for decentralized applications. It allows one-click startup, development, and debugging of ofa.js projects without the need to install any additional software.

The engine originates from NoneOS3, undergoing deep streamlining and architectural restructuring to achieve complete decoupling between the system and applications.

Our vision: To create a universal, minimal, and cross-platform application runtime environment that enables various applications to achieve truly seamless, efficient, and stable operation across different operating systems.

## Core Features

- **Lightweight Design** — Streamlined code architecture, removing redundant functionality, keeping the core engine lean and efficient
- **High-Performance Operation** — Optimized underlying engine providing a stable and efficient runtime environment, ensuring smooth application performance
- **Complete Compatibility** — Full support for development and operation of ofa.js applications, seamlessly integrating with the existing ecosystem
- **High Extensibility** — Modular design with the capability to support multiple front-end frameworks, reserving space for future expansion

## Project Structure

```
nos/               # Core runtime modules (filesystem, crypto, user, hybrid-data)
nos-tool/          # UI tools: OFA Studio, File Explore, Monaco-based editor
sw/                # Service Worker (fetch interception, routing, caching)
server/            # Backend implementations
  rust/            #   Rust handshake & relay server (production)
scripts/           # Build, signing, packing utilities
docs/              # Multi-language documentation site
tests/             # Browser-based test suites
_install/          # Service worker registration & system file installer
```

## Quick Start

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Build service worker
npm run build
```

The dev server runs at `http://localhost:3002`.

## Modules

### Virtual File System (`nos/fs/`)
A virtual filesystem backed by Service Worker + IndexedDB, supporting file read/write, directory operations, mounting, and file observation.

### User System (`nos/user/`)
Decentralized user identity with ECDSA (P-256) key pair generation, user cards, certificates, and peer-to-peer connection via WebSocket relay server.

### Hybrid Data (`nos/hybrid-data/`) ⚠️ Experimental
A dual-storage layer that preserves data in IndexedDB and mirrors it as regular files for app access — enabling both efficient queries and direct file reads. **This module is experimental and may be deprecated in future releases.**

### Crypto (`nos/crypto/`)
Web Crypto API wrappers for ECDSA signing/verification, E2EE, RSA, and AES encryption.

### Handshake Server (`server/rust/`)
A secure WebSocket relay server with challenge-response authentication, multi-session management, relay abuse protection, admin commands, traffic statistics (persisted via redb), and heartbeat detection.

## Scripts

| Script | Description |
|---|---|
| `npm run dev` | Start static server + watch service worker |
| `npm run build` | Build hashes, pack nos.zip, build service worker |
| `npm run bump` | Increment version number across all files |
| `npm run ws` | Start two Rust handshake servers (test mode) |
| `npm run test` | Run browser-based test suites |

## License

Apache 2.0 — see [LICENSE](LICENSE).
