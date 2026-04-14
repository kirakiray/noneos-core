---
name: "noneos-core-docs"
description: "Provides NoneOS Core filesystem documentation covering installation, file/directory operations, handle comparison, and file observation. Invoke when user asks about NoneOS Core usage or needs help with filesystem operations."
---

# NoneOS Core 文件系统文档

NoneOS Core 是一个基于浏览器的虚拟文件系统，提供完整的文件和目录操作 API。

## 安装

### 前提条件

- 静态服务器（如 http-server、live-server、nginx 等）
- 浏览器支持 Service Worker
- 外网访问必须使用 HTTPS

### 1. 创建 Service Worker 文件

根目录创建 `sw.js`：

```javascript
importScripts("https://core.noneos.com/sw/dist.js");
```

### 2. 入口 HTML

```html
<!DOCTYPE html>
<html>
  <head>
    <script src="https://cdn.jsdelivr.net/gh/ofajs/ofa.js"></script>
  </head>
  <body>
    <l-m src="https://core.noneos.com/nos-tool/comps/nos-version.html"></l-m>
    <nos-version auto-install></nos-version>

    <script type="module">
      $("nos-version").on("installed", () => {
        console.log("NoneOS Core 安装完成");
      });
    </script>
  </body>
</html>
```

`nos-version` 组件会自动注册 `sw.js`。

### 安装状态

- **未安装**：显示 "Install NoneOS Core" 按钮
- **安装中**：显示进度条
- **已安装**：显示版本号
- **可升级**：显示升级按钮

触发 `installed` 事件后即可使用 NoneOS Core。

---

## 概述

### 全局 get 方法

```javascript
import { get } from "/nos/fs/main.js";

const file = await get("my-app/hello.txt", { create: "file" });
const dir = await get("my-app/path/to/dir", { create: "dir" });
```

路径格式：`根目录名/文件路径`，不使用 `/` 开头。

### 句柄类型

- **FileHandle**：文件，提供读写操作
- **DirHandle**：目录，提供遍历和子项操作

### 基本属性

| 属性 | 描述 | 返回值 |
|------|------|--------|
| `kind` | 句柄类型 | `"file"` 或 `"dir"` |
| `name` | 名称 | 字符串 |
| `path` | 完整路径 | 字符串 |

---

## 文件操作

### 创建文件

```javascript
const file = await get("my-app/path/to/file.txt", { create: "file" });
```

### 写入文件

```javascript
await file.write("Hello, World!");
```

### 读取文件

| 方法 | 描述 |
|------|------|
| `text()` | 读取文本内容 |
| `file()` | 返回 File 对象 |
| `buffer()` | 返回 ArrayBuffer |
| `read({type, start, end})` | 底层读取 |

### JSON 操作

```javascript
const data = await file.json();
const base64String = await file.base64();
```

### 文件信息

```javascript
const timestamp = await file.lastModified();
const fileObj = await file.file();
console.log(fileObj.size);
```

### 通过 fetch 获取文件

```javascript
const content = await fetch("/$my-app/file1.txt").then((e) => e.text());
```

### 预览 HTML

```javascript
const htmlFile = await get("my-app/index.html", { create: "file" });
await htmlFile.write("<html><body><h1>Hello</h1></body></html>");
// 浏览器打开 /$my-app/index.html 预览
```

### 删除文件

```javascript
await file.remove();
```

---

## 目录操作

### 创建目录

```javascript
const dir = await get("my-app/path/to/dir", { create: "dir" });
```

### 获取子项数量

```javascript
const count = await dir.length();
```

### 遍历目录

| 方法 | 描述 |
|------|------|
| `keys()` | 遍历名称 |
| `values()` | 遍历句柄 |
| `entries()` | 遍历 [名称, 句柄] |
| `forEach(fn)` | 遍历 |
| `some(fn)` | 查找满足条件的第一个 |

```javascript
for await (const [name, handle] of dir.entries()) {
  console.log(`${handle.kind}: ${name}`);
}
```

### 扁平化目录

`flat()` 获取目录及所有子目录中的**文件句柄**：

```javascript
const allFiles = await dir.flat();
```

### 删除目录

⚠️ 会递归删除目录下所有内容，无法恢复。

```javascript
await dir.remove();
```

---

## 移动与复制

### 移动文件

```javascript
const movedFile = await sourceFile.moveTo(targetDir);
// 或指定新名称
const movedFile = await sourceFile.moveTo(targetDir, "newName.txt");
```

### 移动目录

递归移动目录及其所有内容。

### 复制文件

```javascript
const copiedFile = await sourceFile.copyTo(targetDir);
```

### 复制目录

递归复制目录及其所有内容。

---

## 句柄比较

### 获取父目录

```javascript
const parent = await file.parent;
```

### 获取根目录

```javascript
const root = file.root;
```

### 判断是否相同

```javascript
const isSame = await file1.isSame(file2);
```

### 获取文件大小

```javascript
const size = await file.size();
```

### 获取唯一标识符

```javascript
const id = await file.id();
```

### 句柄方法表

| 方法 | 描述 | 返回值 |
|------|------|--------|
| `isSame(target)` | 是否相同 | boolean |
| `size()` | 文件大小 | number \| null |
| `id()` | 唯一标识符 | string |
| `remove()` | 删除 | void |
| `copyTo(target, name)` | 复制 | FileHandle \| DirHandle |
| `moveTo(target, name)` | 移动 | FileHandle \| DirHandle |
| `observe(func)` | 监听变化 | () => void |

---

## 文件变化观察

文件和目录都可以监听变化。

### 基本用法

```javascript
const unobserve = await dir.observe((event) => {
  console.log("变化:", event.type, event.path);
});

await file.write("new content");
await file.remove();

unobserve();
```

### observe 返回值

返回取消观察的函数。

### 事件对象

| 属性 | 描述 |
|------|------|
| `type` | 事件类型：`"create"`, `"remove"`, `"write"` |
| `path` | 变化的文件路径 |

### 注意事项

1. 观察创建后才会开始监听
2. 取消观察后不再接收事件
3. 事件异步触发，可能有延迟

---

## 代码风格规范

1. **已有父句柄时**：使用 `parentDir.get("child.txt")`
2. **没有父句柄时**：使用全局 `await get("my-app/path/to/file.txt")`

```javascript
// 正确：用父句柄获取子项
const dir = await get("my-app/subDir");
await dir.get("file1.txt", { create: "file" });

// 正确：用全局 get 获取独立路径
const file = await get("my-app/other.txt", { create: "file" });
```