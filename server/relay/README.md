# noneos-relay（Stage 3）

5.0 用户互联的新 Rust 中继服务。

## 能力

- WebSocket 二进制中继：按 mux 帧的 `from` / `to` 路由；`from` 必须与连接 `userId` 一致，防止冒名。
- 离线信箱：目标不在线时暂存，目标上线注册连接时按顺序补投。
- 公钥查询：认证后可发文本 `{type:"lookup",requestId,userId}`，用于端到端加密。
- 服务发现：`service-register` / `service-lookup` 文本控制帧。
- 可选持久化信箱：`--mailbox <file>`（JSON + 原子替换），默认内存。
- 多连接：同一 userId 允许多个连接，路由会发给所有在线连接。
- 连接后先完成 ECDSA 挑战应答（Stage 5）；认证通过后才开始转发 mux 帧。

## 当前边界（后续阶段）

- **信箱在内存**：重启丢失；Stage 5 换成持久化存储。
- 没有限流/配额；Stage 5 补。

## 运行

```bash
cargo run -- --port 8081
# 或仓库根目录
npm run relay
```

## 测试

```bash
cargo test
# 或
npm run test:relay
```

测试覆盖：mux 帧解析、在线转发、离线补投、冒名拒绝、缺失 userId 拒绝。
