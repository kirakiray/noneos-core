# NoneOS Core

> [English](README.md) | 中文

[![License](https://img.shields.io/badge/license-Apache%202.0_with_additional_terms-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-5.0.0-blue.svg)](package.json)
[![Browser Tests](https://github.com/kirakiray/noneos-core/actions/workflows/browser-tests.yml/badge.svg)](https://github.com/kirakiray/noneos-core/actions/workflows/browser-tests.yml)
[![Website](https://img.shields.io/badge/website-core.noneos.com-blue.svg)](https://core.noneos.com)

> **5.0** 用全新的 `PeerSession + Link` 架构（Relay + 可选 WebRTC）、ECDSA 身份、E2EE、服务发现与 Rust 中继服务端，替换旧用户/身份/通信、发布与中继实现。

**NoneOS Core** 是一个运行于浏览器的虚拟操作系统内核,提供**虚拟文件系统**与**去中心化用户互联**体系——基础用法无需服务端安装。基于 NoneOS Core 构建的应用可以在沙箱化的虚拟文件系统中读写文件,并在用户之间点对点通信。

> **本质上**,NoneOS Core 是一项创新的**微前端容器化技术**。虽然它*表面上*呈现为一个浏览器内的虚拟操作系统,但其技术本质是建立在 Service Worker 资源虚拟化之上的微前端容器化——通过路由层拦截浏览器请求,托管独立发布的应用,并将每一个运行在无需服务端安装的沙箱化、持久化容器之中。

---

## 架构

```
Browser
├─ ofa.js 应用（Web Components / 路由）
├─ nos/fs       OPFS 虚拟文件系统
├─ nos/storage  IndexedDB 键值存储
├─ nos/peer     PeerSession + Link（5.0）
│    ├─ RTC Link   leader 标签页持有 RTCPeerConnection
│    └─ WS Relay   SharedWorker 持有常驻中继连接
└─ sw/          资源虚拟化（/nos、/nos-lib、/gh、/npm、/$、/$mount-*）

中继：server/relay（Rust WebSocket 中继 + 离线信箱）。
```

## 微前端容器化

虽然 NoneOS Core *自呈现*为一个虚拟操作系统,但其技术本质是**微前端容器化**。"操作系统"只是面向用户的表象;在其之下,容器化通过三大工程支柱实现:

| 支柱 | 含义 | 所在位置 |
|------|------|----------|
| **微前端托管** | 应用基于内容寻址、可独立发布、按需加载——宿主与应用之间无构建期耦合。签名清单允许任意对端分发或提供应用服务。 | `nos/peer` |
| **容器隔离** | 每个应用运行在沙箱化运行时中:OPFS 支撑的虚拟文件系统负责隔离与持久化,去中心化身份与消息系统作为应用与外部世界交互的 I/O 接口。 | [`nos/fs/`](nos/fs/)、`nos/peer` |
| **资源虚拟化** | 容器化建立在 Service Worker 层之上,拦截每一次 fetch,将一组*虚拟 URL 前缀*(`/nos/`、`/nos-lib/`、`/nos-tool/`、`/gh/`、`/npm/`、`/$/`、`/$mount-.../`)映射到不同后端——本地 OPFS、CDN、官方源或远端用户。浏览器只看到一个源,应用却感知到多个。 | [`sw/`](sw/) |

简而言之:**微前端托管**让应用彼此独立,**容器**为每个应用提供私有、持久、可互联的运行时,**资源虚拟化**则是让容器得以运作的 Service Worker 基石——这一切全部纯粹运行在浏览器中。

---

## 项目结构

```
nos/                  # 核心运行时模块(浏览器端)
  fs/                 #   虚拟文件系统(基于 OPFS)
  crypto/             #   ECDSA、E2EE、RSA、AES 加密
  storage/            #   异步键值存储(IndexedDB,类 localStorage 接口)
  util/               #   哈希、zip、异步池等工具
nos-lib/              # nos 官方在线库(CDN 分发,不进签名包)
  nos-version/        #   <nos-version> 安装/升级入口组件
  _install/           #   SW 注册与系统安装器引导
  locale-text/        #   轻量国际化(<locale-text> + getLocaleText)
  n-icon/             #   图标组件
  nos-lib.json        #   签名清单（由 SW 校验）
nos-tool/             # 内置工具集,任何基于 NoneOS Core 的系统都可直接使用
  file-explore/       #   文件浏览器(浏览/导入/下载 OPFS 文件)
  system-info/        #   系统信息与更新管理(版本、SW、安装)
  locale-text-tool/   #   提取 <locale-text> 文案并生成 locale-text.json
  rtc-tool/           #   管理 WebRTC 的 STUN/TURN 服务器列表
sw/                   # Service Worker(请求拦截、路由、缓存)
server/relay/         # Rust WebSocket 中继（认证、信箱、服务发现）
tests/                # 浏览器测试套件(.sb.html)
cases/                # 面向用户的交互式案例
scripts/              # 构建、签名、打包工具
.agents/skills/       # AI 代理技能定义
```

---

## 特性

### 交互式案例(`cases/`)
- [`fs-browser-open/`](cases/fs-browser-open/index.html) — 写入 OPFS 文件，再通过浏览器 GET 打开
- [`user-profile/`](cases/user-profile/index.html) — 创建本机 ECDSA 身份、查看 userId、写入/更新资料
- [`peer-chat/`](cases/peer-chat/index.html) — 两个 SharedWorker Hub、ECDSA 认证、服务发现与 E2EE 聊天

### 虚拟文件系统(`nos/fs/`)
- 基于 **OPFS** 的沙箱化文件系统(`navigator.storage.getDirectory()`)
- 文件/目录增删改查、移动、复制、监听
- 挂载真实本地目录(Chrome File System Access API)——挂载句柄通过 IndexedDB 持久化
- 文件可通过 `/$dirName/path` 风格的 HTTP URL 访问

### Peer 用户互联(`nos/peer/`)
- `PeerSession` — 与传输无关的可靠性：序号、累计 ACK、重传、乱序缓冲与去重
- `RelayMux` — 一条 WebSocket 复用多个 peer；SharedWorker 持有连接并广播到标签页
- 可选 WebRTC — leader 标签页持有 `RTCPeerConnection`；SharedWorker 代理帧，失败自动回退中继
- ECDSA P-256 身份（`userId = sha256(publicKey)`）、挑战应答认证、E2EE 与 appId 服务发现

### 中继服务器(`server/relay/`)
- WebSocket 二进制中继:按 mux 帧 `from` / `to` 路由,并校验 `from` 与连接 userId 一致
- 同一用户多连接;离线信箱(内存或 `--mailbox <file>`,TTL 1 小时)
- 公钥查询与 appId 服务发现
- ECDSA P-256 挑战应答认证 + 公钥查询;`--mailbox` 持久化离线信箱

### 键值存储(`nos/storage/`)
- 基于 IndexedDB 的异步存储,提供类 `localStorage` 接口(`setItem` / `getItem` / `removeItem` / `clear`)
- 可存储任意可结构化克隆的值(Object、Array、Date、Blob、Map、Set),也支持 `nos/fs` 句柄
- 按 id 隔离存储空间,支持代理语法(`storage.key = value`),通过 BroadcastChannel 跨标签页同步
- 本项目中的数据持久化**一律优先使用本模块**,而非原生 `localStorage`

### Service Worker 层(`sw/`)
- 虚拟 URL 前缀:`/nos/`、`/nos-lib/`、`/nos-tool/`、`/gh/`、`/npm/`、`/$/`、`/$mount-.../`
- CDN 类前缀采用 SWR + 内存 TTL 缓存;本地系统文件优先读取 OPFS
- 特殊路由:`/__config`
- `nos-lib/` 文件写入 OPFS 缓存前,会按签名的 `nos-lib/nos-lib.json` 校验

### 公共 UI(`nos-lib/`)
- `nos-lib/`——nos 官方在线库:`<nos-version>`、`<locale-text>`、`<n-icon>`,通过 `/nos-lib/{name}/{name}.html` 引用
- `nos-lib/nos-version/`——`<nos-version>` 安装/升级入口组件;`nos-lib/_install/` 是其引导(SW 注册、版本检查、完整安装、根证书信任链校验),系统信息工具同样调用——见 [`nos-lib/README.md`](nos-lib/README.md)
- `nos-lib/locale-text/`——轻量国际化:`<locale-text>` 组件与脚本用的 `getLocaleText()`
- `nos-lib/n-icon/`——内置工具通用的图标组件
- `nos-lib/nos-lib.json`——签名文件清单,SW 在缓存 `nos-lib` 文件前校验 |

### 内置便捷工具(`nos-tool/`)

**凡是基于 NoneOS Core 的系统,都可以直接使用 `nos-tool/` 下的工具。** Service Worker 会把虚拟前缀 `/nos-tool/{path}` 映射到官方源(`https://core.noneos.com/nos-tool/{path}`,开发期优先 `localhost:3002`),因此这些工具无需安装、无需构建、也无需复制到你的项目中——在 NoneOS Core 页面中直接打开对应地址即可使用。

| 工具 | 入口 | 说明 |
|---|---|---|
| **文件浏览器** | [`/nos-tool/file-explore/`](nos-tool/file-explore/) | 以面包屑导航浏览 OPFS 虚拟文件系统;支持新建目录、从本地磁盘导入文件/目录、下载与删除条目、复制当前路径,并可通过 `/$路径` 形式的 URL 直接打开文件。 |
| **系统信息** | [`/nos-tool/system-info/`](nos-tool/system-info/) | 查看本地版本 / 线上版本 / SW 版本与更新状态,查看已注册的 Service Worker 及当前控制器;可检查更新、注册或卸载 SW、仅更新 SW,以及执行带进度反馈的完整系统更新(SW → `nos.tgz` → 哈希校验 → 写入 OPFS)。 |
| **Locale Text 工具** | [`/nos-tool/locale-text-tool/`](nos-tool/locale-text-tool/) | 扫描 HTML 中的 `<locale-text>` 文案,生成 `locale-text.json` 翻译索引。 |
| **RTC 工具** | [`/nos-tool/rtc-tool/`](nos-tool/rtc-tool/) | 管理 WebRTC 的 STUN/TURN 服务器列表:测试连通性与延迟、调整顺序、临时启停。 |

---

## 快速开始

运行浏览器端模块只需任意**静态文件服务器**。这里以 Node.js 作为便捷的开发服务器,你也可以使用 Python、nginx 或任何替代方案。

### 1. 本地调试(端口 3002)

```bash
git clone https://github.com/kirakiray/noneos-core.git
cd noneos-core
npm install

# 启动开发服务器(端口 3002)+ 监听 Service Worker
npm run dev
# → 打开 http://localhost:3002
```

**3002** 是调试端口:Service Worker 会直接从本地文件读取 `/nos/` 资源(不走 OPFS 缓存),且默认握手服务器只有本地的 `ws://localhost:8081`、`ws://localhost:8082`。

### 2. 本地正式部署使用(端口 30028)

```bash
npm start
# → 打开 http://localhost:30028
```

如果你是要在本地**正式使用** NoneOS Core(而非调试),请用 `npm start`。在 3002 以外的本地端口上,默认握手服务器列表会额外包含线上中继服务器(`wss://hand3-jp1.noneos.com:4331`、`wss://hand3-us1.noneos.com:4331`、`wss://hand3-hk1.noneos.com:4331`),因此无需自建中继服务器即可与远端用户互联。

### 3. 在你自己的项目中使用

在项目根目录创建 `sw.js`:

```js
importScripts("https://core.noneos.com/sw/dist.js");
```

在入口 HTML 中安装系统,随后即可使用运行时模块:

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

安装完成后,各虚拟前缀即刻生效:`/nos/...` 访问核心模块,`/nos-lib/...` 访问公共组件与安装器,`/nos-tool/...` 访问内置工具,`/gh/...` 与 `/npm/...` 则是带缓存的 jsDelivr 简写。

---

## 文档

完整文档见 **[https://core.noneos.com](https://core.noneos.com)**(多语言:English、中文、日本語)。

核心参考:
- [虚拟文件系统 API](nos/fs/README.md)——文件操作、挂载、监听
- [键值存储](nos/storage/README.md)——异步的类 localStorage 存储
- [官方在线库](nos-lib/README.md)——`<nos-version>`、`<locale-text>`、`<n-icon>`、`_install/`
- [多语言模块](nos-lib/locale-text/README.md)——`<locale-text>`、`getLocaleText()`
- [AI 代理知识库](.agents/skills/noneos-core-docs/SKILL.md)——面向 AI 的精简文档

---

## 脚本

| 脚本 | 说明 |
|---|---|
| `npm run dev` | 启动静态服务器(端口 3002)+ 监听 Service Worker——**本地调试用** |
| `npm start` | 启动静态服务器(端口 30028)——**本地正式部署使用 / 自动化测试端口** |
| `npm run static` | 仅启动静态服务器(端口 3002) |
| `npm run watch:sw` | 监听 `sw/src/**` 变更并自动重建 Service Worker |
| `npm run build` | 完整构建:哈希 → nos.tgz → Service Worker → Skill 知识库 |
| `npm run build:sw` | 通过 Rollup 构建 Service Worker(产出 `sw/dist.js` + `sw/dist.min.js`) |
| `npm run build:hashes` | 计算并签名 `nos/` 源码哈希(供 `nos.json` 消费),同时签发 `nos-lib/` 的清单(供 `nos-lib/nos-lib.json` 消费) |
| `npm run build:skill` | 构建 `.agents/skills/noneos-core-docs` 知识库(生成 `noneos-core-docs.zip`) |
| `npm run bump` | 跨所有文件升级版本号,并重新安装依赖与构建 |
| `npm run ws` | 启动两个 Rust 中继服务器(测试模式,端口 8081 & 8082) |
| `npm run ws1` / `npm run ws2` | 单独启动一个 Rust 中继服务器(端口 8081 / 8082) |
| `npm run relay` | 启动新的 Rust 中继服务(默认 8081) |
| `npm run test:relay` | 运行 Rust 中继测试 |
| `npm run test:peer` | 运行 Stage 1/2 PeerSession 测试 |
| `npm run test` | 运行浏览器测试套件(`sb-test`) |

> **重要**:修改 `sw/src/` 下任何文件后必须重新运行 `npm run build:sw`(或保持 `npm run watch:sw` 运行),否则部署的 Service Worker 不会生效。

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
