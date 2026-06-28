# NoneOS Handshake Server

A WebSocket handshake and relay server that serves as the backend for NoneOS Core user interconnection.

## Features

- **ECDSA P-256 Authentication** — Challenge-response handshake with signature verification
- **Session Management** — Multi-session per user with configurable limits
- **Message Relay** — Text and binary relay between user sessions with quota control
- **Relay Abuse Protection** — Rate-limited relay failure counting per session window
- **Admin Commands** — Query online users, system info, traffic history, manage quotas
- **Traffic Statistics** — 30-second granularity with redb persistence
- **Heartbeat Detection** — Configurable ping/pong interval and timeout for stale connection cleanup
- **Memory Overload Protection** — Rejects non-admin connections when memory exceeds threshold

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
| `admin_user_id` | none | Admin user ID |
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
