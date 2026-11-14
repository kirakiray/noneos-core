# sw.js 配置技巧

## 版本号控制与缓存更新

在发布新版本时，如果服务器配置了 `max-age=0` 响应头，浏览器仍可能缓存旧版本的 `sw.js` 文件，导致更新无法及时生效。通过在 URL 中添加版本参数，可以强制浏览器请求最新的文件，从而解决这一问题。

```javascript
let version = "";
if (globalThis.serviceWorker) {
  const urlParams = new URLSearchParams(
    new URL(serviceWorker.scriptURL).search,
  );
  version = urlParams.get("v") || "";
} else {
  const urlParams = new URLSearchParams(new URL(location.href).search);
  version = urlParams.get("v") || "";
}

importScripts("https://core.noneos.com/sw/dist.js?v=" + version);
```

在引用 dist.js 时加上 `?v=` 参数，每次发布新版本时更新版本号，浏览器便会请求新的文件而非使用缓存。

## 官方工具

使用 `nos-tool` 目录下的工具，可以方便地管理 NoneOS 系统。

- **file-explore** - 文件浏览器：浏览 OPFS 虚拟文件系统，支持导入/下载/删除文件与 `/$path` 访问
- **system-info** - 系统信息与更新管理：查看版本、SW 状态并执行完整系统更新
- **locale-text-tool** - 多语言文案提取：扫描 `<locale-text>` 并生成 `locale-text.json`
- **rtc-tool** - WebRTC STUN/TURN 服务器列表管理：测试连通性与延迟、排序、启停

这些工具位于 `nos-tool` 目录下，可按需引入和使用。
