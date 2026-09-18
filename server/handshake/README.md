# NoneOS Handshake Server

A WebSocket handshake and relay server that serves as the backend for NoneOS Core user interconnection.

## Features

- **ECDSA P-256 Authentication** — Challenge-response handshake with signature verification
- **Session Management** — Multi-session per user with configurable limits
- **Message Relay** — Text and binary relay between user sessions with quota control
- **Relay Abuse Protection** — Rate-limited relay failure counting per session window
- **Admin HTTP API** — Standalone token-protected HTTP endpoint: query online users, system info, traffic stats, manage quotas
- **Traffic Statistics** — 30-second granularity with redb persistence
- **Heartbeat Detection** — Configurable ping/pong interval and timeout for stale connection cleanup
- **Memory Overload Protection** — Rejects new connections when memory exceeds threshold (admin HTTP API is exempt)

## Configuration

Configuration is via TOML file. See [test-space/config.example.toml](test-space/config.example.toml) for all options.

### Quick Start

```bash
# Default config (port 8081)
cargo run

# Custom config file
cargo run -- --config test-space/config.example.toml
```

### Key Config Options

| Option | Default | Description |
|---|---|---|
| `port` | 8081 | Listen port |
| `host` | `""` (all interfaces) | Listen address |
| `admin_token` | none | Admin API bearer token (disabled if unset) |
| `admin_http_host` | `127.0.0.1` | Admin API listen host (behind nginx) |
| `admin_http_port` | `8082` | Admin API listen port |
| `admin_base_path` | `/ctrl-9f2a` | Admin API path prefix (use a random string in production) |
| `handshake_timeout_secs` | 5 | Handshake timeout |
| `max_sessions_per_user` | 10 | Max concurrent sessions per user |
| `heartbeat_interval_secs` | 15 | Ping interval |
| `heartbeat_timeout_secs` | 60 | Idle timeout |
| `redb_path` | `./noneos-handshake.redb` | Database path |

## Build

```bash
cargo build --release
```

## Release Builds

Pre-built binaries are available for:
- Linux (x86_64, aarch64)
- Windows (x86_64, aarch64, via mingw)
- macOS (aarch64)

See [GitHub Releases](https://github.com/kirakiray/noneos-core/releases).

## License

Apache 2.0
