# locale-text - 多语言文本模块

`locale-text` 是 NoneOS Core 的轻量级国际化（i18n）模块，提供两种互补的多语言能力：

- **`<locale-text>` 组件**：在 HTML 模板中按语言声明多份文本，运行时只显示当前语言对应的一份。
- **`getLocaleText` 函数**：在 JavaScript 中根据当前语言从对象里取出对应文本，适合脚本中动态生成文案（如错误提示）。

两者共享同一套语言判定逻辑（`getLang`），保证组件与脚本的语言表现一致。

## 语言判定规则

当前语言由 [get-locale-text.js](./get-locale-text.js) 按以下优先级确定，判定结果在模块加载时计算一次并缓存：

1. `sessionStorage` 中的 `lang`
2. `localStorage` 中的 `lang`
3. 根据 `navigator.language` 推断：包含 `zh` → `cn`，包含 `ja` → `ja`
4. 兜底默认 `en`

> 应用层可通过写入 `sessionStorage.setItem("lang", "cn")` 或 `localStorage.setItem("lang", "en")` 来指定语言。注意判定值是模块加载时缓存的，切换语言后通常需要刷新页面或对 `<locale-text>` 重新设置 `lang` 属性才会生效。

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
2. 若不存在，回退到 `en`
3. 若仍不存在，使用第一个声明的语言

### 工作原理

组件通过注入一段 `::slotted()` 样式来控制显示：默认隐藏所有 slot 子元素，仅让当前语言对应的元素 `display: revert`。因此内容始终存在于 DOM 中，仅通过 CSS 控制可见性。`:host` 使用 `display: contents`，组件本身不产生额外布局盒子。

---

## `getLocaleText` 函数

### 引入

```javascript
import { getLocaleText, getLang } from "/nos/locale-text/get-locale-text.js";
// 或使用默认导出
import getLocaleText from "/nos/locale-text/get-locale-text.js";
```

### `getLocaleText(obj)`

传入一个以语言码为 key 的对象，返回当前语言对应的文本。

**参数：**
- `obj` (Object) - 语言码到文本的映射，如 `{ cn: "...", en: "..." }`

**返回值：** 当前语言对应的文本；找不到时按下述回退规则取值。

**回退规则：**
1. 返回 `obj[getLang()]`
2. 若为 `undefined` 且存在 `obj.en`，返回 `obj.en`
3. 若仍为 `undefined`，返回对象的第一个值

**示例：**

```javascript
getLocaleText({ cn: "没有可用的 API Key", en: "No available API Key" });
// 当前语言为 cn 时返回 "没有可用的 API Key"

// 常用于动态生成错误提示
throw new Error(
  getLocaleText({
    cn: `网络请求失败: ${err.message}`,
    en: `Network failed: ${err.message}`,
  })
);
```

### `getLang()`

返回当前判定的语言码（如 `"cn"` / `"en"` / `"ja"`）。

```javascript
const lang = getLang(); // "cn"
```

---

## 何时用哪个

| 场景 | 推荐方式 |
|------|----------|
| 在 HTML 模板中展示静态多语言文案 | `<locale-text>` 组件 |
| 在 JS 中动态拼接文案 / 抛错提示 / 传参给函数 | `getLocaleText` 函数 |
| 只需要知道当前语言码 | `getLang` 函数 |

---

## 文件说明

| 文件 | 说明 |
|------|------|
| [get-locale-text.js](./get-locale-text.js) | 语言判定逻辑，导出 `getLang` 与 `getLocaleText` |
| [locale-text.html](./locale-text.html) | `<locale-text>` 组件定义，依赖 `get-locale-text.js` 的 `getLang` |
