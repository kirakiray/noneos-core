# dev-bridge 开发模式脚本注入

> 源码位置：`sw/src/modules/dev-bridge.js`（接线于 `sw/src/main.js` 的 fetch 监听）

## 用途

开发调试时（如配合 web-bridge-mcp 等 bridge 工具），希望**每一个**通过 `text/html` 打开的静态页面都自动携带调试 script，避免真实跳转到未手动添加 script 的页面时丢失 bridge 控制。

## 开启方式

**双重开关，缺一不可**：

1. **宿主总开关**：宿主项目在自己的 `sw.js` 中声明（必须在 `importScripts("/sw/dist.js")` 的同一文件、同一全局作用域）：
   ```javascript
   globalThis.DEV_BRIDGE_ENABLED = true;
   importScripts("/sw/dist.js");
   ```
   不声明该开关时，无论配置怎么写注入都不生效（noneos-core 根目录的 `sw.js` 已自带此声明）。
2. **systemConfig 配置**（`nos-config/system.json` 中的 `devBridge` 字段）：

```json
{
  "devBridge": {
    "script": "http://127.0.0.1:8765/client.js",
    "async": true,
    "banner": true
  }
}
```

| 字段 | 说明 |
|------|------|
| `script` | 要注入的 script URL，**非空才启用注入**；还需宿主 `sw.js` 声明 `DEV_BRIDGE_ENABLED` 总开关 |
| `async` | 可选，注入的 `<script>` 是否带 `async` 属性，缺省 `false`（同步插入，尽早执行、可捕获早期 console） |
| `banner` | 可选，是否注入开发模式警告横幅，缺省 `true`（不建议关闭） |

修改配置后访问一次 `/__config` 触发 SW 重载即可全局生效，无需重启 SW。

## 行为约定

- 仅对**同域顶层 HTML 导航**（`GET` + `request.destination === "document"`）注入；iframe、fetch/XHR 获取的 HTML 不注入。
- 注入位置：`<head>` 开标签之后（head 内最前）。注入顺序：① 防篡改警告横幅守卫脚本（同步内联，先于页面所有脚本执行）；② 配置的 bridge script。
- **文档中没有 `<head>` 开标签时不注入**（ofa.js 的页面/组件模块等无 head 文档天然绕过；注意正则匹配的是原文第一个 head 开标签，出现在注释/脚本里会被误判）。
- **警告横幅（默认开启）**：每个被注入页面顶部显示半透明警示色横幅，文案告知处于开发者模式、勿输入敏感数据。**多语言**：跟随浏览器语言（`navigator.language` 以 `zh` 开头 → 中文，其余 → 英文）。**可拖拽**：横幅可拖到不遮挡内容的位置，位置持久化到 `localStorage`（键 `__noneos-dev-banner-pos`），跨页面生效。**绝对置顶**：z-index 恒为 2147483647，且守卫会在每次文档变化时把横幅保持为 documentElement 的最后子元素（同级 z-index 下 DOM 靠后者在上），防止被页面元素覆盖。
- **防篡改保护**：横幅被移除，或被「不删除但隐藏」（`display:none`、`visibility:hidden`、`opacity<0.3`、`filter` 透明/大模糊、`clip-path` 裁剪、宽高压扁、transform 移出视口、背景与文字同时全透明）时，整页立即替换为红底「疑似恶意程序」警告页；告警页本身同样被守护，被移除会自动恢复。守卫脚本通过闭包固化 MutationObserver/setInterval 引用 + 1s 轮询兜底。注意：这是 best-effort 级防御（页面脚本与守卫同上下文运行），非绝对不可绕过。
- 对 SW 所有处理器（nos/gh/npm/host-cache fallback 及网络透传）返回的 HTML 响应统一生效。
- 读取/解析失败时原样返回原始响应，不会因注入失败破坏页面。
- 响应头的 `content-length` 会被移除（正文长度已改变）。

## 测试

- 测试文件：`tests/sw/dev-bridge.sb.html`（含 fixture `tests/sw/dev-bridge/`）
- 测试会写 OPFS `nos-config/system.json` 并独占 SW，**必须在独立 origin 运行**，一条命令即可（会自动在 3003 端口起测试服务器）：
  `npm run test:dev-bridge`
- 文件内置端口守卫：在非 3003 端口（如 3002 混跑）时所有用例自动跳过，不会污染共享 origin
- CI：`.github/workflows/browser-tests.yml` 中的 `test-dev-bridge` job（仅 Chrome）会自动运行本测试
