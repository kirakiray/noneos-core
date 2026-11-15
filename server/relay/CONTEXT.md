# noneos-relay 上下文（Stage 5）

## 定位

5.0 用户互联的新 Rust 中继服务，替代旧的 `server/handshake`。

## 能力

1. WebSocket 二进制中继：按 mux 帧 `from/to` 路由，校验 `from == 连接 userId`
2. ECDSA P-256 挑战应答认证：`userId == sha256(publicKey)`
3. 在线连接注册：同一 userId 允许多连接
4. 公钥查询：已认证连接可查询远端 `publicKey`（供 E2EE）
5. 服务发现：`service-register` / `service-lookup`
6. 离线信箱：默认内存；`--mailbox <file>` 使用 JSON 原子写持久化，TTL 1h、100 条/用户

## 协议

- 连接：`ws://host:port/`
- 认证：服务端先发 `{type:"challenge"}`；客户端回 `{type:"auth",userId,publicKey,signature}`；通过后 `{type:"ready"}`。
- 数据帧：浏览器 `nos/peer/relay/mux.js` 的 mux 帧：
  `u8 version=1, u8 type=1, u16 fromLen, from, u16 toLen, to, inner PeerSession frame`
- 控制帧（文本，认证后）：
  - `{type:"lookup",requestId,userId}` → `{type:"pubkey",publicKey}` / `pubkey-error`
  - `{type:"service-register",requestId,appIds}` → `services-ok`
  - `{type:"service-lookup",requestId,appId}` → `{type:"services",userIds}`

## 代码

- `src/protocol.rs`：mux 帧解析/编码
- `src/auth.rs`：挑战、userId 校验、签名验证
- `src/hub.rs`：在线表、路由、公钥/服务注册
- `src/mailbox.rs`：内存 / 文件信箱
- `src/lib.rs`：WS 接受、认证、读写任务
- `src/main.rs`：`--port`、`--mailbox`
- `tests/integration.rs`：认证转发、离线补投、公钥查询、服务发现、坏签名

## 测试

```bash
npm run test:relay   # cargo test：10 单测 + 5 集成
```

## 后续（Stage 6+）

- 限流/配额、部署配置、监控
