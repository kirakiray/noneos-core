# NoneOS Core

> [English](README.md) | 中文

[![License](https://img.shields.io/badge/license-Apache%202.0_with_additional_terms-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-4.1.2-blue.svg)](package.json)
[![Rust Server](https://github.com/kirakiray/noneos-core/actions/workflows/build-rust-server.yml/badge.svg)](https://github.com/kirakiray/noneos-core/actions/workflows/build-rust-server.yml)
[![Browser Tests](https://github.com/kirakiray/noneos-core/actions/workflows/browser-tests.yml/badge.svg)](https://github.com/kirakiray/noneos-core/actions/workflows/browser-tests.yml)
[![Website](https://img.shields.io/badge/website-core.noneos.com-blue.svg)](https://core.noneos.com)

**NoneOS Core** 是一个运行于浏览器的虚拟操作系统内核,提供**虚拟文件系统**与**去中心化用户互联**体系——基础用法无需服务端安装。基于 NoneOS Core 构建的应用可以在沙箱化的虚拟文件系统中读写文件,并在用户之间点对点通信。

> **本质上**,NoneOS Core 是一项创新的**微前端容器化技术**。虽然它*表面上*呈现为一个浏览器内的虚拟操作系统,但其技术本质是建立在 Service Worker 资源虚拟化之上的微前端容器化——通过路由层拦截浏览器请求,托管独立发布的应用,并将每一个运行在无需服务端安装的沙箱化、持久化容器之中。

```js
import { getUser } from "/nos/user/main.js";

const user = await getUser("my-app");
// user.userId → 基于 ECDSA 的唯一身份标识
// 自动连接中继服务器以收发消息

const remote = await user.connectUser(targetUserId);
await remote.send(sessionId, { text: "Hello from NoneOS!" });
```

---

## 架构

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
│                Rust Relay Server (server/rust/)                      │
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

Rust 中继服务器在用户之间提供**挑战-响应认证**(ECDSA P-256)、**消息中继**和 **RTC 信令隧道**。服务器中继始终作为可用兜底,一旦对端互相发现,即可切换为直连 **WebRTC**——中继服务器以普通中继数据的形式透明转发 SDP/ICE 信令消息,服务端对其承载的是信令协议毫无感知。

---

## 微前端容器化

虽然 NoneOS Core *自呈现*为一个虚拟操作系统,但其技术本质是**微前端容器化**。"操作系统"只是面向用户的表象;在其之下,容器化通过三大工程支柱实现:

| 支柱 | 含义 | 所在位置 |
|------|------|----------|
| **微前端托管** | 应用基于内容寻址、可独立发布、按需加载——宿主与应用之间无构建期耦合。签名清单允许任意对端分发或提供应用服务。 | [`nos/publish/`](nos/publish/README.md)、[`nos-tool/studio/`](nos-tool/studio/) |
| **容器隔离** | 每个应用运行在沙箱化运行时中:OPFS 支撑的虚拟文件系统负责隔离与持久化,去中心化身份与消息系统作为应用与外部世界交互的 I/O 接口。 | [`nos/fs/`](nos/fs/)、[`nos/user/`](nos/user/README.md) |
| **资源虚拟化** | 容器化建立在 Service Worker 层之上,拦截每一次 fetch,将一组*虚拟 URL 前缀*(`/packages/`、`/nos/`、`/$/`、`/gh/`、`/npm/`、`/$mount-.../`)映射到不同后端——本地 OPFS、CDN、官方源或远端用户。浏览器只看到一个源,应用却感知到多个。 | [`sw/`](sw/) |

简而言之:**微前端托管**让应用彼此独立,**容器**为每个应用提供私有、持久、可互联的运行时,**资源虚拟化**则是让容器得以运作的 Service Worker 基石——这一切全部纯粹运行在浏览器中。

---

## 项目结构

```
nos/                  # 核心运行时模块(浏览器端)
  fs/                 #   虚拟文件系统(基于 IndexedDB)
  user/               #   去中心化用户身份与消息系统
  crypto/             #   ECDSA、E2EE、RSA、AES 加密
  publish/            #   P2P 文件发布与应用管理
  ai/                 #   AI 对话工具
  util/               #   哈希、zip、异步池等工具
nos-tool/             # 桌面化 UI 工具
  studio/             #   OFA Studio(应用开发环境)
  editor/             #   基于 Monaco 的代码编辑器
  file-explore/       #   文件浏览器
  _install/           #   Service Worker 注册与系统安装器
sw/                   # Service Worker(请求拦截、路由、缓存)
server/               # 后端实现
  rust/               #   Rust 握手与中继服务器(生产用)
  client/             #   服务端管理面板(Web UI)
tests/                # 浏览器测试套件(.sb.html)
scripts/              # 构建、签名、打包工具
docs/                 # 多语言文档站点(OBook)
skills/               # AI 代理技能定义
```

---

## 特性

### 虚拟文件系统(`nos/fs/`)
- 基于 **OPFS** 的沙箱化文件系统(`navigator.storage.getDirectory()`)
- 文件/目录增删改查、移动、复制、监听
- 挂载真实本地目录(Chrome File System Access API)——挂载句柄通过 IndexedDB 持久化
- 文件可通过 `/$dirName/path` 风格的 HTTP URL 访问
- 通过 P2P 连接访问远端文件系统

### 去中心化用户系统(`nos/user/`)
- 基于 **ECDSA P-256** 的密钥对生成与身份(userId = 公钥哈希)
- 针对中继服务器的挑战-响应**认证**
- 通过可配置的 WebSocket 服务器进行**消息中继**
- 私聊消息的**端到端加密**(ECDH + AES-GCM)
- 初始发现后的 **WebRTC** 直连兜底
- **服务注册表**——按 `appId` 进行应用级路由,无需管理会话
- 用于角色/权限管理的**证书系统**
- 通过 BroadcastChannel 支持**跨标签页会话**
- 延迟监控与自动服务器选路

### 中继服务器(`server/rust/`)
- 基于 ECDSA P-256 签名验证的挑战-响应握手
- 文本与二进制中继,支持可配置的大小限制
- **RTC 信令隧道**——透明转发 SDP/ICE offer 与 candidate,以普通中继数据形式传输;服务器对其承载的是信令毫无感知
- 单用户多会话,支持可配置的并发上限
- 中继滥用防护(按时间窗口统计失败次数)
- 基于 redb 持久化的流量统计(30 秒粒度)
- 用户带宽配额(可按用户配置)
- 心跳检测,清理过期连接
- 内存过载保护
- 管理员命令:在线用户、系统信息、流量历史、配额管理

### P2P 发布(`nos/publish/`)
- `DataPublisher`——分块式 P2P 文件分发

---

## 快速开始

运行浏览器端模块只需任意**静态文件服务器**。这里以 Node.js 作为便捷的开发服务器,你也可以使用 Python、nginx 或任何替代方案。

### 1. 使用 Node.js 快速启动

```bash
git clone https://github.com/kirakiray/noneos-core.git
cd noneos-core
npm install

# 启动开发服务器(端口 3002)+ 构建 Service Worker
npm run dev
# → 打开 http://localhost:3002
```

### 2. 启动本地中继服务器(可选,用于多用户测试)

```bash
# 终端 1:启动两个 Rust 中继服务器(端口 8081、8082)
npm run ws
```
编译需要 [Rust](https://www.rust-lang.org/)。

### 3. 在你的应用中使用

```html
<script src="https://cdn.jsdelivr.net/gh/ofajs/ofa.js"></script>
<script type="module">
  import { getUser } from "/nos/user/main.js";

  const user = await getUser("my-app");
  console.log("My ID:", user.userId);

  // 通过中继服务器向另一个用户发送消息
  const remote = await user.connectUser(targetUserId);
  const sessions = await remote.getSessionIds();
  await remote.send(sessions[0], { hello: "world" });
</script>
```

---

## 文档

完整文档见 **[https://core.noneos.com](https://core.noneos.com)**(多语言:English、中文、日本語)。

核心参考:
- [用户系统 API](nos/user/README.md)——身份、消息、证书、服务注册表
- [虚拟文件系统 API](nos/fs/)——文件操作、挂载、监听
- [P2P 发布](nos/publish/README.md)——DataPublisher
- [服务器配置](server/rust/README.md)——中继服务器搭建

---

## 脚本

| 脚本 | 说明 |
|---|---|
| `npm run dev` | 启动静态服务器(端口 3002)+ 监听 Service Worker |
| `npm run build` | 完整构建:哈希 → nos.zip → Service Worker |
| `npm run bump` | 跨所有文件升级版本号 |
| `npm run ws` | 启动两个 Rust 中继服务器(测试模式,端口 8081 & 8082) |
| `npm run test` | 运行浏览器测试套件 |

---

## 贡献

1. Fork 本仓库
2. 创建功能分支:`git checkout -b feat/my-feature`
3. 提交变更:`git commit -am 'Add my feature'`
4. 推送:`git push origin feat/my-feature`
5. 发起 [Pull Request](https://github.com/kirakiray/noneos-core/pulls)

如遇 Bug 或有功能建议,请[提交 issue](https://github.com/kirakiray/noneos-core/issues)。

---

## 许可证

[Apache 2.0 with additional terms](LICENSE) © NoneOS Contributors
