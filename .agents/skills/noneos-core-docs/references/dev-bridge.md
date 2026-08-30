# dev-bridge 开发模式脚本注入

> 源码位置：`sw/src/modules/dev-bridge.js`（接线于 `sw/src/main.js` 的 fetch 监听）

## 用途

开发调试时（如配合 web-bridge-mcp 等 bridge 工具），希望**每一个**通过 `text/html` 打开的静态页面都自动携带调试 script，避免真实跳转到未手动添加 script 的页面时丢失 bridge 控制。

## 开启方式

由 `nos-config/system.json`（systemConfig）中的 `devBridge` 字段驱动：

```json
{
  "devBridge": {
    "script": "http://127.0.0.1:8765/client.js",
    "async": true
  }
}
```

| 字段 | 说明 |
|------|------|
| `script` | 要注入的 script URL，**非空才启用整个注入逻辑**；生产配置中不含该字段即完全不生效 |
| `async` | 可选，注入的 `<script>` 是否带 `async` 属性，缺省 `false`（同步插入，尽早执行、可捕获早期 console） |

修改配置后访问一次 `/__config` 触发 SW 重载即可全局生效，无需重启 SW。

## 行为约定

- 仅对**同域顶层 HTML 导航**（`GET` + `request.destination === "document"`）注入；iframe、fetch/XHR 获取的 HTML 不注入。
- 注入位置：`<head>` 开标签之后（head 内最前）。**文档中没有 `<head>` 标签时不注入**（ofa.js 的页面/组件模块等无 head 文档天然绕过）。
- 对 SW 所有处理器（nos/gh/npm/host-cache fallback 及网络透传）返回的 HTML 响应统一生效。
- 读取/解析失败时原样返回原始响应，不会因注入失败破坏页面。
- 响应头的 `content-length` 会被移除（正文长度已改变）。

## 测试

- 测试文件：`tests/sw/dev-bridge.sb.html`（含 fixture `tests/sw/dev-bridge/`）
- 测试会写 OPFS `nos-config/system.json` 并独占 SW，**必须在独立 origin 运行**，一条命令即可（会自动在 3003 端口起测试服务器）：
  `npm run test:dev-bridge`
- 文件内置端口守卫：在非 3003 端口（如 3002 混跑）时所有用例自动跳过，不会污染共享 origin
- CI：`.github/workflows/browser-tests.yml` 中的 `test-dev-bridge` job（仅 Chrome）会自动运行本测试
