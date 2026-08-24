# locale-text 多语言模块

`locale-text` 是 NoneOS Core 的轻量级国际化（i18n）模块，提供两种互补的多语言能力：

- **`<locale-text>` 组件**：在 HTML 模板中按语言声明多份文本，运行时只显示当前语言对应的一份。
- **`getLocaleText` 函数**：在 JavaScript 中根据当前语言从对象里取出对应文本，适合脚本中动态生成文案（如错误提示）。

两者共享同一套语言判定逻辑（`getLang`）与 `locale-text.json` 中央翻译表回退机制。

## 加载

```html
<!-- 组件 -->
<l-m src="/nos/locale-text/locale-text.html"></l-m>
```

```javascript
// 函数
import { getLocaleText, getLang, setLang } from "/nos/locale-text/get-locale-text.js";
```

## 语言判定规则

当前语言由 `getLang()` 按以下优先级确定：

1. `setLang()` 运行时设置的值（最高优先级）
2. 模块加载时缓存的 `sessionStorage.lang` / `localStorage.lang`
3. 根据 `navigator.language` 主子标签推断：`zh*` → `cn`，`ja*` → `ja`，`en*` → `en`
4. 兜底默认 `en`

常用语言码：`cn`（中文）、`en`（英文）、`ja`（日文）。

运行时切换语言调用 `setLang(lang)`，会派发 `locale-text:lang-change` 事件，所有已挂载的 `<locale-text>` 组件自动刷新。

---

## `<locale-text>` 组件

在内部为每种语言放一个带 `lang` 属性的子元素，组件只显示与当前语言匹配的那个：

```html
<locale-text>
  <span lang="cn">开始</span>
  <span lang="en">Get Started</span>
</locale-text>
```

可显式指定语言覆盖全局判定：

```html
<locale-text lang="en">
  <span lang="cn">开始</span>
  <span lang="en">Get Started</span>
</locale-text>
```

### 回退规则

当内部没有匹配目标语言的子元素时：

1. 目标语言
2. **`locale-text.json` 中央翻译表**（按基准文本 hash 查询，见下文）
3. `en`
4. 第一个声明的语言

### 动态变量（`data-*` 插值）

需要拼接动态值时，用 `data-*` 属性传值，子元素文本中用 `{key}` 占位：

```html
<locale-text attr:data-id="$data.id" attr:data-model="$data.model">
  <span lang="cn">ID: {id} | 模型: {model}</span>
  <span lang="en">ID: {id} | Model: {model}</span>
</locale-text>
```

- **不要**直接用 ofa.js 的 `{{$data.xxx}}` 模板语法：JSON 回退时不经过 ofa.js 渲染，会原样显示
- `{key}` 占位符在 slot 命中与 JSON 回退两条路径都会替换
- 提取工具拿到的基准文本稳定（如 `"ID: {id} | 模型: {model}"`），hash 不会随数据漂移

---

## `getLocaleText(obj, vars)` 函数

传入一个以语言码为 key 的对象，返回当前语言对应的文本。与 `<locale-text>` 组件共享同一套语言判定与回退逻辑。

**参数：**
- `obj` (Object) - 语言码到文本的映射，如 `{ cn: "...", en: "..." }`
- `vars` (Object, 可选) - 变量映射，用于将文本中的 `{key}` 占位符替换为 `vars[key]` 的值

**查找优先级：**
1. **`locale-text.json` 反向索引**：模块加载时自动后台拉取 `/locale-text.json` 并构建 `基准文本 → 条目` 索引（fire-and-forget，对使用者无感）。若 `obj` 的基准文本（`cn` → `en` → 第一个字段）在 JSON 中命中且含当前语言字段，则返回 JSON 的翻译。这样只需在内联对象里写 `cn`/`en`，其他语种（如 `ja`/`ko`）由 JSON 提供
2. 若 JSON 未命中，回退到内联对象：`obj[getLang()]`
3. 若为 `undefined` 且存在 `obj.en`，返回 `obj.en`
4. 若仍为 `undefined`，返回对象的第一个值
5. 最后对结果做 `{key}` 变量插值（仅当传入 `vars` 时）

**示例：**

```javascript
// 基础用法
getLocaleText({ cn: "没有可用的 API Key", en: "No available API Key" });

// 带变量：用 {key} 占位符保持基准文本稳定
throw new Error(
  getLocaleText(
    { cn: "网络请求失败: {msg}", en: "Network failed: {msg}" },
    { msg: err.message },
  )
);
```

### 动态变量：用 `{key}` 占位符，不要用模板字符串插值

需要拼接动态值时，**不要**直接用 JS 模板字符串 `` `${}` `` 插值：

```javascript
// ❌ 不推荐：基准文本随变量变化，无法进入 locale-text.json
getLocaleText({
  cn: `网络请求失败: ${err.message}`,
  en: `Network failed: ${err.message}`,
});
```

原因：每次变量值不同都会生成不同的基准文本，SHA-256 hash 漂移，提取工具无法稳定收录。

**正确做法**：文本里写 `{key}` 占位符，动态值通过 `vars` 传入：

```javascript
// ✅ 推荐：基准文本固定，可进 JSON，其他语种在 JSON 里补充即可
getLocaleText(
  { cn: "网络请求失败: {msg}", en: "Network failed: {msg}" },
  { msg: err.message },
);
```

---

## `locale-text.json` 中央翻译表

放置在站点根目录 `/locale-text.json`，用于在不修改源码的前提下补充扩展语种翻译。

**格式**（key 为基准文本的 SHA-256 hex）：

```json
{
  "<sha256-of-base-text>": {
    "cn": "中文文本",
    "en": "English text",
    "ja": "日本語テキスト"
  }
}
```

- **基准文本**：`cn` → 无则 `en` → 无则第一个字段
- `<locale-text>` 组件与 `getLocaleText` 函数都会自动读取该文件做回退
- fetch 失败或文件不存在时静默降级到内联回退
- 推荐固定 `cn` 文本，只新增/修改其他语种字段；修改 `cn` 会让旧 hash 失效

---

## 翻译提取工具

配套的 ofa.js 应用 `nos-tool/locale-text-tool/` 用于离线生成和维护 `locale-text.json`：

1. 在支持 `showDirectoryPicker` 的浏览器（推荐 Chrome）中打开 `/nos-tool/locale-text-tool/index.html`
2. 选择项目目录（需包含 `.gitignore`）
3. 工具会：
   - 按 `.gitignore` 规则跳过匹配文件/目录
   - 递归扫描所有 `.html` / `.js` / `.mjs` 源码文件
   - HTML 文件：提取 `<locale-text>` 节点（含 `<template page>` / `<template component>` 内嵌的）
   - JS/MJS 文件：正则提取 `getLocaleText({...})` 调用里的语言字段
   - 计算基准文本的 SHA-256，与已有 JSON 增量合并
4. 生成结果写入项目根目录 `locale-text.json`

### 工作流

- 初始提取：源码内只写 `cn`/`en` 两语，工具生成 JSON
- 补充语种：直接在 `locale-text.json` 里为对应 hash 添加 `ja`/`ko`/... 字段，无需改源码
- 部署：将 `locale-text.json` 放到站点根目录，运行时自动回退读取

---

## 相关 API

| API | 说明 |
|-----|------|
| `getLang()` | 返回当前判定的语言码（如 `"cn"` / `"en"` / `"ja"`） |
| `setLang(lang)` | 运行时切换语言，派发 `locale-text:lang-change` 事件；传入 falsy 值恢复初始判定 |
| `getLocaleText(obj, vars)` | 从语言对象取当前语言文本，支持 `{key}` 变量插值与 JSON 回退 |
