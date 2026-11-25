# 交互式案例

面向使用者的递进式演示，每个案例一个独立目录与页面，所有步骤都可以在浏览器里点击运行。

| 案例 | 演示内容 |
|---|---|
| `fs-browser-open/` | 写入 OPFS 文件，再通过 `/$cases-demo/hello.html` GET 打开、更新 |
| `user-profile/` | 创建/加载 ECDSA 用户，查看 `userId`，用 `nos/storage` 写入并更新资料 |
| `peer-chat/` | 两个 SharedWorker Hub、ECDSA 认证、服务发现、PeerSession + E2EE 聊天 |

## 本地运行

```bash
npm run static
```

打开：

```text
http://localhost:3002/cases/fs-browser-open/index.html
http://localhost:3002/cases/user-profile/index.html
http://localhost:3002/cases/peer-chat/index.html
```

案例 03 还需要本机 Relay：

```bash
npm run relay
```

默认地址 `ws://localhost:8081`，可在页面里修改。

## 说明

- 案例 01 依赖 Service Worker 的 `/$` 路由；首次打开时 `nos-version` 会自动安装。
- 案例 02 的身份来自 `nos/peer/identity-store.js`，资料属于应用数据，由 `nos/storage` 保存。
- 案例 03 使用模块化 SharedWorker，建议 Chrome / Edge；两个用户在同一页面中用两个独立 SharedWorker 模拟。
