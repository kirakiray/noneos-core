# 5.0 用户互联重写计划

目标：用 `PeerSession + Link` 重写用户互联，替代旧 `nos/user` / `nos/publish` / `server/handshake`。旧实现已移除。

## 已定架构

- 一个 `PeerSession` 管理一个远端用户：持久化 Outbox、单调 seq、ACK/重传、去重、加密。
- Link 可替换：WebRTC 直连（leader 标签页）→ WS 中继（SharedWorker 常驻）→ 以后可加 WebTransport。
- **不使用 TURN**：ICE 只配 STUN；直连失败直接走 WS。
- SharedWorker 持有 PeerSession、WS 与离线信箱同步；leader 标签页持有 `RTCPeerConnection`，其他标签页通过 MessagePort 共享会话。
- leader 关闭/冻结：先切回 WS，再选新 leader 重建 RTC，消息按 seq 连续。
- 单协议版本 + capability bitmask，不保留旧版本分支。

## 阶段与验收

| 阶段 | 内容 | 验收 |
|---|---|---|
| 0 | 归档旧代码、清 CI/测试入口、写计划 | ✅ 构建通过；剩余测试清单无归档引用 |
| 1 | 帧格式、Outbox、seq/ACK/去重、PeerSession、FakeLink | ✅ `node --test tests/peer/session.node.test.mjs` 6/6 |
| 2 | WsLink + SharedWorker hub + 多标签代理 | ✅ RelayMux/PeerHub/FakeTransport：4/4；真实 SharedWorker/WS 留给 Stage 3 集成 |
| 3 | Rust signaling/relay/mailbox 服务端 | ✅ `cargo test` 15/15；Node 客户端经真实 WS 验证在线转发、离线补投、认证与公钥查询 |
| 4 | RTC Link（leader 标签 + proxy） | ✅ 假 RTCPeerConnection：offer/answer、DataChannel 帧、hub 代理切换/回退 12/12 |
| 5 | 身份/加密/服务发现/离线信箱接入 | ✅ 身份持久化、ECDSA 认证、E2EE、公钥查询、服务发现、可选持久化信箱；10+5+17 测试通过 |
| 6 | 入口页、nos-lib 组件、Skill/README、CI、删除 legacy | ✅ 入口身份卡、Skill/README、Relay CI；全量测试与打包通过；`legacy/` 删除 |

每个阶段必须先通过本阶段测试并回归上一阶段，再进入下一阶段。
