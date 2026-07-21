# locale-text - 多语言文本模块

`locale-text` 是 NoneOS Core 的轻量级国际化（i18n）模块，提供两种互补的多语言能力：

- **`<locale-text>` 组件**：在 HTML 模板中按语言声明多份文本，运行时只显示当前语言对应的一份。
- **`getLocaleText` 函数**：在 JavaScript 中根据当前语言从对象里取出对应文本，适合脚本中动态生成文案（如错误提示）。

两者共享同一套语言判定逻辑（`getLang`），保证组件与脚本的语言表现一致。

## 语言判定规则

当前语言由 [get-locale-text.js](./get-locale-text.js) 按以下优先级确定：

1. `setLang()` 运行时设置的值（最高优先级，见下文）
2. 模块加载时缓存的 `sessionStorage.lang` / `localStorage.lang`
3. 根据 `navigator.language` 主子标签推断：`zh*` → `cn`，`ja*` → `ja`，`en*` → `en`
4. 兜底默认 `en`

> 启动期可通过写入 `sessionStorage.setItem("lang", "cn")` 或 `localStorage.setItem("lang", "en")` 来指定初始语言（值在模块加载时缓存）。运行时切换语言应调用 `setLang()`，会自动派发 `locale-text:lang-change` 事件，所有已挂载的 `<locale-text>` 组件都会即时刷新显示。

常用语言码：`cn`（中文）、`en`（英文）、`ja`（日文）。

---

## `<locale-text>` 组件

### 引入

组件需要先加载注册，再在页面/组件中使用。

在页面顶部通过 `<l-m>` 加载（推荐）：

```html
<l-m src="/nos/locale-text/locale-text.html"></l-m>
```

或在组件的脚本中通过 `load` 加载：

```javascript
await load("/nos/locale-text/locale-text.html");
```

### 基本用法

在 `<locale-text>` 内部为每种语言放一个带 `lang` 属性的子元素，组件只会显示与当前语言匹配的那个，其余全部隐藏：

```html
<locale-text>
  <span lang="cn">开始</span>
  <span lang="en">Get Started</span>
</locale-text>
```

子元素可以是任意标签，也可以包含更复杂的结构：

```html
<locale-text>
  <div lang="cn">
    <p>抱歉，您的浏览器暂不支持选择目录，请更换为 Chrome。</p>
  </div>
  <div lang="en">
    <p>Sorry, your browser does not support directory selection. Please switch to Chrome.</p>
  </div>
</locale-text>
```

### 指定语言

不设置 `lang` 时，组件使用 `getLang()` 的判定结果。也可以显式指定语言，覆盖全局判定：

```html
<locale-text lang="en">
  <span lang="cn">开始</span>
  <span lang="en">Get Started</span>
</locale-text>
```

### 回退规则

当内部没有与目标语言匹配的子元素时，组件按以下顺序回退：

1. 目标语言（`lang` 属性或 `getLang()`）
2. **`locale-text.json` 中央翻译表**（见下文"JSON 回退"），按基准文本的 hash 查询
3. 若不存在，回退到 `en`
4. 若仍不存在，使用第一个声明的语言

### 工作原理

组件通过注入一段 `::slotted()` 样式来控制显示：默认隐藏所有 slot 子元素，仅让当前语言对应的元素 `display: revert`。因此内容始终存在于 DOM 中，仅通过 CSS 控制可见性。`:host` 使用 `display: contents`，组件本身不产生额外布局盒子。

组件在 `ready` 时计算一次样式，并通过 `MutationObserver` 监听 slot 子元素及子元素 `lang` 属性的变化，自动重新计算显示语言；同时监听全局 `locale-text:lang-change` 事件（`setLang()` 会派发该事件），在 `detached` 时统一清理监听。

### JSON 回退（`locale-text.json`）

当 slot 内没有任何子元素匹配目标语言时，组件会从站点根目录的 `/locale-text.json` 读取中央翻译表，按"基准文本 hash"查找翻译并注入 shadow 内的临时容器渲染，无需修改原 HTML。fetch 失败或文件不存在时静默降级到第 3、4 步的 slot 回退。

- **基准文本**：`cn` 的 innerHTML → 无则 `en` → 无则第一个带 `lang` 的子元素
- **hash 算法**：基准文本的 SHA-256 十六进制（与提取工具 [nos-tool/locale-text-tool](../../nos-tool/locale-text-tool/) 保持一致）
- **JSON 格式**：

```json
{
  "<sha256-of-base-text>": {
    "cn": "中文文本",
    "en": "English text",
    "ja": "日本語テキスト"
  }
}
```

> 修改源 HTML 中 `cn` 文本会让旧 hash 失效，连带丢失该条目下的其他语种翻译；推荐固定 `cn` 文本，只新增/修改其他语种字段。

### 动态变量（`data-*` 插值）

当 `<locale-text>` 内的文本需要拼接动态值时（如 `ID`、`数量` 等），**不要**直接使用 ofa.js 的 `{{$data.xxx}}` 模板语法：

```html
<!-- ❌ 不推荐：JSON 回退失效 -->
<locale-text>
  <span lang="cn">ID: {{$data.id}} | 模型: {{$data.model}}</span>
  <span lang="en">ID: {{$data.id}} | Model: {{$data.model}}</span>
</locale-text>
```

原因：`{{$data.xxx}}` 只有在 **slot 命中目标语言** 时才会被 ofa.js 正确渲染（因为 slot 子元素由 ofa.js 接管）。但是当目标语言走 **JSON 回退** 时，翻译文本会被注入到 shadow DOM 的临时容器里，**不经过 ofa.js 模板渲染**，`{{$data.xxx}}` 会作为字面文本原样显示。

**正确做法**：用 `data-*` 属性传值，子元素文本中用 `{key}` 占位：

```html
<!-- ✅ 推荐：slot 与 JSON 回退都生效 -->
<locale-text attr:data-id="$data.id" attr:data-model="$data.model">
  <span lang="cn">ID: {id} | 模型: {model}</span>
  <span lang="en">ID: {id} | Model: {model}</span>
</locale-text>
```

- ofa.js 的 `attr:data-id="$data.id"` 会把实际值绑定到 `data-id` 属性
- 组件内部的 `{key}` 占位符会被替换为宿主元素 `data-key` 属性的值
- **slot 命中** 和 **JSON 回退** 两条路径都会做替换
- `data-*` 属性变化时组件会自动重新替换（无需手动刷新）
- 提取工具拿到的基准文本是 `ID: {id} | 模型: {model}`，是稳定文本，hash 不会随数据变化而漂移

> `{key}` 与 ofa.js 的 `{{key}}` 互不冲突，可以放心混用。未提供对应 `data-key` 时，`{key}` 会原样保留。

---

## `getLocaleText` 函数

### 引入

```javascript
import { getLocaleText, getLang } from "/nos/locale-text/get-locale-text.js";
// 或使用默认导出
import getLocaleText from "/nos/locale-text/get-locale-text.js";
```

### `getLocaleText(obj, vars)`

传入一个以语言码为 key 的对象，返回当前语言对应的文本。与 `<locale-text>` 组件共享同一套语言判定与回退逻辑，无需额外配置即可命中 `locale-text.json` 中的扩展语种翻译。

**参数：**
- `obj` (Object) - 语言码到文本的映射，如 `{ cn: "...", en: "..." }`
- `vars` (Object, 可选) - 变量映射，用于将文本中的 `{key}` 占位符替换为 `vars[key]` 的值；不传则保留占位符原文

**返回值：** 当前语言对应的文本；找不到时按下述回退规则取值。

**查找优先级：**
1. **`locale-text.json` 反向索引**：模块加载时自动后台拉取 `/locale-text.json` 并构建 `基准文本 → 条目` 的索引（无需手动调用预加载函数）。若 `obj` 的基准文本（`cn` → `en` → 第一个字段）在 JSON 中命中且含当前语言字段，则返回 JSON 的翻译。这样只需在内联对象里写 `cn`/`en`，其他语种（如 `ja`/`ko`）由 JSON 提供
2. 若 JSON 未命中，回退到内联对象：`obj[getLang()]`
3. 若为 `undefined` 且存在 `obj.en`，返回 `obj.en`
4. 若仍为 `undefined`，返回对象的第一个值
5. 最后对结果做 `{key}` 变量插值（仅当传入 `vars` 时）

**示例：**

```javascript
// 基础用法
getLocaleText({ cn: "没有可用的 API Key", en: "No available API Key" });
// 当前语言为 cn 时返回 "没有可用的 API Key"

// 带变量的文本：用 {key} 占位符保持基准文本稳定，便于进 JSON
throw new Error(
  getLocaleText(
    { cn: "网络请求失败: {msg}", en: "Network failed: {msg}" },
    { msg: err.message },
  )
);
// 当前语言为 cn、msg 为 "timeout" 时返回 "网络请求失败: timeout"
```

> **关于动态变量**：旧写法 `` `网络请求失败: ${err.message}` `` 会让每次错误都生成不同的基准文本，无法进入 `locale-text.json`。改用 `{msg}` 占位符后，基准文本固定为 `"网络请求失败: {msg}"`，可被提取工具收录，后续在 JSON 里补充 `ja`/`ko` 等翻译即可，无需改 JS 源码。`{key}` 语法与 `<locale-text>` 组件的 `data-*` 插值完全一致。

### `getLang()`

返回当前判定的语言码（如 `"cn"` / `"en"` / `"ja"`）。

```javascript
const lang = getLang(); // "cn"
```

### `setLang(lang)`

运行时切换当前语言，并派发 `locale-text:lang-change` 事件，所有已挂载的 `<locale-text>` 组件会自动刷新。

**参数：**
- `lang` (string | falsy) - 目标语言码；传入 `null` / `undefined` / `""` 等 falsy 值时，恢复为模块加载时缓存的初始判定值

```javascript
import { setLang } from "/nos/locale-text/get-locale-text.js";

setLang("en");   // 切换到英文，<locale-text> 立即重新渲染
setLang(null);   // 恢复到启动期判定的语言
```

---

## 何时用哪个

| 场景 | 推荐方式 |
|------|----------|
| 在 HTML 模板中展示静态多语言文案 | `<locale-text>` 组件 |
| 在 JS 中动态拼接文案 / 抛错提示 / 传参给函数 | `getLocaleText` 函数 |
| 只需要知道当前语言码 | `getLang` 函数 |
| 为整个项目集中补充/维护翻译 | 配合 [locale-text-tool](../../nos-tool/locale-text-tool/) 生成 `locale-text.json` |

---

## 翻译提取工具（`locale-text-tool`）

配套的 ofa.js 应用 [nos-tool/locale-text-tool/](../../nos-tool/locale-text-tool/) 用于离线生成和维护 `locale-text.json`。

### 使用步骤

1. 在支持 `showDirectoryPicker` 的浏览器（推荐 Chrome）中打开 `/nos-tool/locale-text-tool/index.html`
2. 点击"选择项目目录"，授权待翻译项目（需包含 `.gitignore`，否则会跳过 `.git` 外的所有文件）
3. 点击"生成 locale-text.json"
4. 工具会：
   - 按完整 `.gitignore` 规则跳过匹配文件/目录
   - 递归扫描所有 `.html` / `.js` / `.mjs` 源码文件
   - HTML 文件：提取 `<locale-text>` 节点（含 `<template page>` / `<template component>` 内嵌的）
   - JS/MJS 文件：正则提取 `getLocaleText({...})` 调用里的语言字段
   - 取每个节点的基准文本（`cn` → `en` → 第一个带 `lang` 的子元素）并计算 SHA-256
   - 与项目根目录已有的 `locale-text.json` 增量合并：旧条目的非基准语言字段保留，仅追加新条目
5. 生成结果直接写入项目根目录的 `locale-text.json`，UI 同时提供预览

### 工作流

- 初始提取：HTML 内只写 `cn`/`en` 两语，工具生成 JSON
- 补充语种：直接在 `locale-text.json` 里为对应 hash 添加 `ja`/`ko`/... 字段，无需回到 HTML
- 部署：将 `locale-text.json` 放到站点根目录，组件运行时会自动回退读取

### 已知限制

- 同一基准文本在不同位置出现会合并为同一条；需保证语义一致
- 修改源 HTML 中 `cn` 文本会让旧 hash 失效（该条目的其他语种翻译不会自动迁移）
- 仅 Chrome 系浏览器支持目录选择；运行时回退则对所有浏览器透明

---

## 文件说明

| 文件 | 说明 |
|------|------|
| [get-locale-text.js](./get-locale-text.js) | 语言判定逻辑，导出 `getLang`、`setLang` 与 `getLocaleText` |
| [locale-text.html](./locale-text.html) | `<locale-text>` 组件定义，依赖 `get-locale-text.js` 的 `getLang`，含 JSON 回退层 |
