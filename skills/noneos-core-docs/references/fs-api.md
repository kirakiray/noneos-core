# NoneOS Core 文件系统 API 参考

NoneOS Core 是一个基于浏览器的虚拟文件系统，提供完整的文件和目录操作 API。

## 概述

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

## 初始化与获取

### init() - 初始化应用根目录

```javascript
import { init } from "/nos/fs/main.js";

const rootDir = await init("my-app");
// 返回根目录的 DirHandle
```

### get() - 获取文件或目录

```javascript
import { get } from "/nos/fs/main.js";

// 获取已有文件（不存在返回 null）
const file = await get("my-app/file.txt");
if (file === null) {
  console.log("文件不存在");
}

// 创建新文件
const file2 = await get("my-app/new.txt", { create: "file" });

// 通过父句柄获取
const dir = await get("my-app");
const childFile = await dir.get("child.txt", { create: "file" });
```

---

## 文件操作

### 创建文件

```javascript
const file = await get("my-app/path/to/file.txt", { create: "file" });
```

### 写入文件

支持字符串和 `File` 对象：

```javascript
// 写入字符串
await file.write("Hello, World!");

// 写入 File 对象
const fileObj = new File(["content"], "file.txt", { type: "text/plain" });
await file.write(fileObj);
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
const size = await file.size();          // 文件大小（字节数）
const timestamp = await file.lastModified();
const fileObj = await file.file();
console.log(fileObj.size, fileObj.type);
```

### 删除文件

删除后 `get()` 返回 `null`，可重新创建同名文件：

```javascript
await file.remove();

// 删除后检查
const exists = await dir.get("file.txt");
console.log(exists); // null

// 可重新创建同名文件
const newFile = await dir.get("file.txt", { create: "file" });
await newFile.write("new content");
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
| `some(fn)` | 条件遍历，匹配后提前终止 |

```javascript
// entries 遍历
for await (const [name, handle] of dir.entries()) {
  console.log(`${handle.kind}: ${name}`);
}

// values 遍历
for await (const handle of dir.values()) {
  console.log(handle.name, handle.kind);
}

// some 条件遍历（匹配到第三个文件时终止）
let count = 0;
let found = false;
await dir.some(async (handle, name) => {
  count++;
  if (handle.kind === "file" && count === 2) {
    found = true;
    return true; // 返回 true 提前终止
  }
  return false;
});
```

### 扁平化目录

`flat()` 递归获取目录及所有子目录中的**文件句柄**：

```javascript
const allFiles = await dir.flat();
// 返回扁平的文件句柄数组，包含所有层级

// 读取所有文件内容
const contents = await Promise.all(
  allFiles.map(async (file) => ({
    path: file.path,
    content: await file.read(),
  }))
);
```

### 删除目录

⚠️ 会递归删除目录下所有内容，无法恢复。删除后 `get()` 返回 `null`。

```javascript
await dir.remove();

// 删除后检查
const exists = await testDir.get("subDir");
console.log(exists); // null
```

---

## 目录挂载

目录挂载功能允许将虚拟目录或用户本地目录挂载到系统中，挂载后可通过 `/$mount-xxx` 路径以 HTTP 方式访问。

> ⚠️ **注意**：`open()`（打开目录选择器）仅 Chrome 浏览器支持，Safari 等其他浏览器不支持。

### open() - 打开目录选择器 (仅 Chrome)

打开系统文件选择器，让用户选择本地文件夹：

```javascript
import { open } from "/nos/fs/main.js";

const handle = await open();
```

`open()` 返回一个 `DirHandle`，可直接搭配 `mount()` 使用。

### mount() - 挂载目录

挂载一个 `DirHandle`（可以是虚拟目录或 `open()` 打开的本地目录），返回一个挂载后的句柄，其 `path` 以 `$mount-` 为前缀：

```javascript
import { init, mount } from "/nos/fs/main.js";

// 挂载虚拟目录
const testDir = await init("my-dir");
const mountedHandle = await mount(testDir);

console.log(mountedHandle.path); // 如 "$mount-my-dir-xxxxx"
```

### 通过 get() 访问挂载目录

挂载后可以通过 `get()` 传入 `mountedHandle.path` 来访问目录内容：

```javascript
await testDir.get("test.txt", { create: "file" });
const mountedHandle = await mount(testDir);

// 通过挂载路径获取目录
const retrieved = await get(mountedHandle.path);

// 比较是否为同一句柄
const isSame = await mountedHandle.isSame(retrieved); // true
```

### 访问挂载目录中的子目录和文件

```javascript
const subDir = await testDir.get("subdir", { create: "dir" });
const file = await subDir.get("test.txt", { create: "file" });
await file.write("mount test content");

const mountedHandle = await mount(testDir);

// 通过挂载路径访问子目录
const subDirHandle = await get(`${mountedHandle.path}/subdir`);
const fileHandle = await subDirHandle.get("test.txt");
const content = await fileHandle.text();
```

### 通过 Fetch 访问 (HTTP)

配合 Service Worker 注册，挂载目录中的文件可以通过 HTTP fetch 直接访问：

```javascript
import registration from "/_install/register.js";
await registration;

const testFile = await testDir.get("fetch-test.txt", { create: "file" });
await testFile.write("sample content");
const mountedHandle = await mount(testDir);

// 通过 HTTP fetch 访问
const response = await fetch(`/${mountedHandle.path}/fetch-test.txt`);
const text = await response.text(); // "sample content"
```

### 获取已挂载目录列表

```javascript
import { getMounted } from "/nos/fs/main.js";

const allHandles = await getMounted();
// 例: [{ path: "$mount-my-dir-xxxxx", handle: DirHandle }, ...]

// 查找已挂载的目录
const found = allHandles.find(item => item.path === mountedHandle.path);
```

### 卸载目录

```javascript
import { unmount } from "/nos/fs/main.js";

// 方式一：直接传入挂载句柄
await unmount(mountedHandle);

// 方式二：从已挂载列表中找到后卸载
const found = allHandles.find(item => item.path === mountedHandle.path);
if (found) {
  await unmount(found.handle);
}
```

---

## 移动与复制

### 移动文件/目录

支持三种场景：

```javascript
// 1. 移动文件到其他目录（可选重命名）
const movedFile = await sourceFile.moveTo(targetDir, "new-name.txt");
// 原文件不再存在

// 2. 移动整个目录
const movedDir = await sourceDir.moveTo(targetDir);
// 子目录和文件结构完整保留

// 3. 同目录重命名
const renamedFile = await sourceFile.moveTo("new-name.txt");
// 原文件不再存在
```

移动后原位置的文件/目录消失，内容完整迁移：

```javascript
const content = await movedFile.read();
const oldFile = await dir.get("source.txt");
console.log(oldFile); // null — 原文件已不存在
```

### 复制文件/目录

```javascript
// 1. 复制文件到其他目录（可选重命名）
const copiedFile = await sourceFile.copyTo(targetDir, "copy.txt");

// 2. 复制整个目录
const copiedDir = await sourceDir.copyTo(targetDir);

// 3. 同目录复制重命名
const renamedCopy = await sourceFile.copyTo("renamed.txt");
```

### 错误场景

不能将目录移动/复制到其自身的子目录中：

```javascript
const sourceDir = await dir.get("source", { create: "dir" });
const childDir = await dir.get("source/child", { create: "dir" });

try {
  await sourceDir.moveTo(childDir); // 错误
} catch (error) {
  console.log(error.message); // 包含 "Cannot move"
}

try {
  await sourceDir.copyTo(childDir); // 错误
} catch (error) {
  console.log(error.message); // 包含 "Cannot copy"
}
```

---

## 句柄比较与信息

| 方法 | 描述 | 返回值 |
|------|------|--------|
| `isSame(target)` | 是否指向同一文件/目录 | boolean |
| `id()` | 唯一标识符 | string |
| `parent` | 获取父目录 | Promise<DirHandle> |
| `root` | 获取根目录 | DirHandle |

### parent - 获取父目录

```javascript
const testFile = await testDir.get("a/b/c/d/test.txt", { create: "file" });
const parentDir = await testFile.parent;

const directoryD = await testDir.get("a/b/c/d");
const isSame = await parentDir.isSame(directoryD);
// true — 文件的父目录即 a/b/c/d
```

### root - 获取根目录

文件或目录的 `root` 属性都指向同一个根目录：

```javascript
const root1 = testFile.root;
const root2 = directoryD.root;
const isSame = await root1.isSame(root2);
// true
```

---

## 通过 Fetch 访问文件 (HTTP)

配合 Service Worker，初始化后的目录可以通过 HTTP 直接访问文件内容：

```javascript
import { init } from "/nos/fs/main.js";
import registration from "/_install/register.js";
await registration;

const testDir = await init("test-dir");

// 写入文件
const file = await testDir.get("file.txt", { create: "file" });
await file.write("some text");

await new Promise(resolve => setTimeout(resolve, 300)); // 等待缓存

// 通过 fetch 访问
const content = await fetch("/$test-dir/file.txt").then(r => r.text());
console.log(content); // "some text"
```

访问路径格式：`/$目录名/文件路径`

---

## 文件变化观察

### 基本观察

观察目录中的文件变更（创建、修改、删除）：

```javascript
const unobserve = await dir.observe((event) => {
  console.log("变化类型:", event.type);
  console.log("变化路径:", event.path);
});

// 触发事件
const file = await dir.get("test.txt", { create: "file" }); // 触发事件
await file.write("content");                                 // 可能触发事件
await file.remove();                                         // 触发事件

// 取消观察
unobserve();
```

### 子目录观察

在父目录上观察，子目录中的变化也会被捕获：

```javascript
const parentDir = await testDir.get("parent", { create: "dir" });
const subDir = await parentDir.get("sub", { create: "dir" });

const unobserve = await parentDir.observe((event) => {
  console.log(event.type, event.path); // 子目录变更也会触发
});

const file = await subDir.get("test.txt", { create: "file" });
await file.write("Hello");
await file.remove();

unobserve();
```

### 多个观察者

同一目录支持多个同时观察：

```javascript
const events1 = [];
const events2 = [];

const unobserve1 = await dir.observe((event) => events1.push(event));
const unobserve2 = await dir.observe((event) => events2.push(event));

// 两个观察者都会收到相同的事件
const file = await dir.get("test.txt", { create: "file" });
await file.remove();

await new Promise(resolve => setTimeout(resolve, 100));
console.log(events1.length === events2.length); // true

unobserve1();
unobserve2();
```

### 跨标签页观察

不同标签页（或 iframe）中的文件变更也会被观察到：

```javascript
// 主页面
const testDir = await init("test-dir-cross-tab");
const events = [];

const unobserve = await testDir.observe((event) => {
  events.push(event);
});

// 其他标签页/iframe 中创建文件后，events 会收到对应事件
// events: [{ type: "create", path: "..." }, { type: "delete", path: "..." }]

unobserve();
```

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
