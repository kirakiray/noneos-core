# nos/fs 文件系统模块

> NoneOS Core 基于浏览器 OPFS (Origin Private File System) 的虚拟文件系统。

## 快速开始

```js
import { init, get } from "/nos/fs/main.js";

// 初始化一个存储空间（根目录）
const rootDir = await init("my-app");

// 创建文件并写入
const file = await rootDir.get("hello.txt", { create: "file" });
await file.write("Hello, World!");

// 读取文件
const content = await file.text();
console.log(content); // "Hello, World!"

// 通过路径获取文件
const sameFile = await get("my-app/hello.txt");
console.log(await sameFile.text()); // "Hello, World!"
```

## 入口 API (main.js)

| 函数 | 说明 |
|------|------|
| `init(name)` | 初始化/获取一个 OPFS 根目录存储空间，返回 `DirHandle` |
| `get(path, options?)` | 按路径获取句柄，自动路由到 system / mount / remote |
| `open(options?)` | 弹出系统目录选择器，返回本地目录的 `DirHandle` |
| `mount(handle)` | 将目录句柄挂载到虚拟文件系统，返回带 `$mount-` 路径的句柄 |
| `unmount(idOrHandle)` | 卸载已挂载的目录（支持 id 字符串或 handle 对象） |
| `getMounted()` | 获取所有已挂载的目录列表 |

### init(name)

初始化一个 OPFS 根目录空间。如果已存在则直接返回。

```js
import { init } from "/nos/fs/main.js";

const dir = await init("my-app");
// dir 是一个 DirHandle
```

### get(path, options?)

通过路径获取文件或目录句柄。路径格式：

- 普通路径：`"my-app/path/to/file.txt"` — 访问 OPFS 存储空间
- 挂载路径：`"$mount-{id}>name/path"` — 访问已挂载的本地目录
- 远端路径：`"$user-{userId}:rootName/path"` — 访问远端用户目录

```js
import { get } from "/nos/fs/main.js";

// 获取文件
const file = await get("my-app/file.txt");
// 文件不存在时返回 null

// 获取目录
const dir = await get("my-app/subdir");

// 创建文件
const newFile = await get("my-app/new.txt", { create: "file" });

// 创建目录
const newDir = await get("my-app/newdir", { create: "dir" });

// 多级路径自动创建中间目录
const deepFile = await get("my-app/a/b/c/deep.txt", { create: "file" });
```

### open(options?)

弹出系统目录选择器，让用户选择本地目录。

```js
import { open } from "/nos/fs/main.js";

// 选择目录
const dir = await open();

// 选择目录并直接挂载
const mountedDir = await open({ mount: true });
```

### mount(handle)

将本地目录句柄挂载到虚拟文件系统。挂载后可通过 `$mount-{id}>name` 路径访问。

```js
import { init, mount, getMounted, unmount, get } from "/nos/fs/main.js";

const dir = await init("my-app");
const mounted = await mount(dir);

console.log(mounted.path); // "$mount-xxx>my-app"

// 通过挂载路径访问
const retrieved = await get(mounted.path);
const isSame = await mounted.isSame(retrieved); // true

// 访问挂载目录下的子路径
const subDir = await get(`${mounted.path}/subdir`);
const file = await subDir.get("test.txt");
```

### unmount(idOrHandle)

卸载已挂载的目录。

```js
import { mount, unmount, getMounted } from "/nos/fs/main.js";

const dir = await init("my-app");
const mounted = await mount(dir);

// 通过 handle 对象卸载
await unmount(mounted);

// 或通过 id 字符串卸载
await unmount("xxx");
```

### getMounted()

获取所有已挂载的目录列表。

```js
import { getMounted } from "/nos/fs/main.js";

const list = await getMounted();
// 返回 [{ id, name, path, handle }]
```

## DirHandle（目录句柄）

通过 `init()`、`get()` 或 `dir.get()` 获取。

### get(name, options?)

获取子项。`options.create` 可设为 `"file"` 或 `"dir"` 以创建新项。

```js
const dir = await init("my-app");

// 获取子文件
const file = await dir.get("file.txt");

// 获取子目录
const subDir = await dir.get("subdir");

// 创建文件
const newFile = await dir.get("new.txt", { create: "file" });

// 创建目录
const newDir = await dir.get("newdir", { create: "dir" });

// 多级路径（自动创建中间目录）
const deep = await dir.get("a/b/c/file.txt", { create: "file" });

// 不存在的项返回 null
const missing = await dir.get("nonexistent.txt");
console.log(missing); // null
```

### length()

返回子项数量。

```js
const dir = await init("my-app");
const count = await dir.length();
console.log(count); // 子文件+子目录的数量
```

### keys()

异步迭代器，遍历子项名称。

```js
for await (const name of dir.keys()) {
  console.log(name);
}
```

### entries()

异步迭代器，遍历 `[name, handle]` 对。

```js
for await (const [name, handle] of dir.entries()) {
  console.log(name, handle.kind);
}
```

### values()

异步迭代器，遍历子项句柄。

```js
const handles = [];
for await (const handle of dir.values()) {
  handles.push({ kind: handle.kind, name: handle.name });
}
```

### forEach(fn)

遍历所有子项。

```js
await dir.forEach(async (handle, name) => {
  console.log(name, handle.kind);
});
```

### some(fn)

遍历子项，回调返回 `true` 时提前终止。

```js
let found = false;
await dir.some(async (handle, name) => {
  if (name === "target.txt") {
    found = true;
    return true; // 提前终止
  }
  return false;
});
```

### flat()

递归获取所有子孙文件句柄（只返回文件，不返回目录）。

```js
const dir = await init("my-app");

// 创建多级结构
await dir.get("a/b/c/file.txt", { create: "file" });

const allFiles = await dir.flat();
// 返回所有文件句柄的数组
```

## FileHandle（文件句柄）

通过 `dir.get()` 获取文件后使用。

### read(options?)

底层读取方法。`options.type` 支持 `"text"`（默认）、`"file"`、`"buffer"`。

```js
const content = await file.read();               // text 模式
const content = await file.read({ type: "text" });
const fileObj = await file.read({ type: "file" });
const buffer = await file.read({ type: "buffer" });
```

### text()

读取为文本字符串。

```js
const content = await file.text();
```

### file()

读取为 `File` 对象。

```js
const fileObj = await file.file();
console.log(fileObj.size, fileObj.type);
```

### buffer()

读取为 `ArrayBuffer`。

```js
const buf = await file.buffer();
```

### json()

读取并解析为 JSON。

```js
const data = await file.json();
```

### base64()

读取为 DataURL（base64 编码）。

```js
const dataUrl = await file.base64();
```

### write(data, options?)

写入数据。支持字符串、Blob、File、ArrayBuffer。

```js
// 写入字符串
await file.write("Hello, World!");

// 写入 File 对象
const fileObj = new File(["content"], "test.txt", { type: "text/plain" });
await file.write(fileObj);
```

### size()

获取文件大小（字节）。

```js
const size = await file.size();
console.log(size); // 字节数
```

### lastModified()

获取最后修改时间戳。

```js
const timestamp = await file.lastModified();
```

## 通用方法（DirHandle 和 FileHandle 共有）

### kind

返回 `"file"` 或 `"dir"`。

```js
console.log(handle.kind);
```

### name

返回名称（来自底层 OPFS 句柄）。

```js
console.log(handle.name);
```

### path

返回完整路径。

```js
console.log(handle.path); // "my-app/subdir/file.txt"
```

### parent

返回父句柄。

```js
const parent = await file.parent;
const isSame = await parent.isSame(dir); // true
```

### root

返回根句柄。

```js
const root = file.root;
const isSame = await root.isSame(dir); // true
```

### isSame(target)

判断两个句柄是否指向同一资源（基于 `isSameEntry`）。

```js
const a = await get("my-app/file.txt");
const b = await get("my-app/file.txt");
const same = await a.isSame(b); // true
```

### id()

返回唯一标识符。优先使用 `getUniqueId()`，否则基于路径哈希。

```js
const id = await file.id();
```

### remove()

删除文件或目录（目录递归删除）。触发观察者通知。

```js
// 删除文件
await file.remove();

// 删除目录（递归删除所有子项）
await dir.remove();

// 删除后重新创建
const newFile = await dir.get("file.txt", { create: "file" });
await newFile.write("new content");
```

### copyTo(target, name?)

复制文件或目录到目标位置。

```js
// 复制文件到另一个目录
const targetDir = await dir.get("backup", { create: "dir" });
const copied = await file.copyTo(targetDir, "copied.txt");

// 复制目录（递归复制所有内容）
const copiedDir = await sourceDir.copyTo(targetDir);

// 在同一目录下重命名复制
const renamed = await file.copyTo("renamed.txt");

// 错误：不能复制到自己的子目录中
try {
  await sourceDir.copyTo(subDir);
} catch (e) {
  console.log(e.message); // "Cannot copy a directory into its subdirectory"
}
```

### moveTo(target, name?)

移动文件或目录到目标位置（复制后删除原位置）。

```js
// 移动文件到另一个目录
const targetDir = await dir.get("backup", { create: "dir" });
const moved = await file.moveTo(targetDir, "moved.txt");
// 原文件已不存在

// 移动目录（递归移动所有内容）
const movedDir = await sourceDir.moveTo(targetDir);
// 原目录已不存在

// 在同一目录下重命名
const renamed = await file.moveTo("renamed.txt");

// 错误：不能移动到自己的子目录中
try {
  await sourceDir.moveTo(subDir);
} catch (e) {
  console.log(e.message); // "Cannot move a directory into its subdirectory"
}
```

### observe(func)

监听文件系统变化。返回取消函数。

```js
const events = [];
const unobserve = await dir.observe((event) => {
  console.log(event.type); // "create" | "remove" | "write"
  console.log(event.path); // 发生变化的文件路径
  events.push(event);
});

// 触发事件
const file = await dir.get("test.txt", { create: "file" }); // create
await file.write("hello"); // write
await file.remove(); // remove

// 取消监听
unobserve();

// 多个观察者
const unsub1 = await dir.observe(callback1);
const unsub2 = await dir.observe(callback2);
// 两个观察者都会收到事件
```

### toJSON()

序列化为 `{ name, path, kind }`。

```js
console.log(JSON.stringify(file));
// {"name":"file.txt","path":"my-app/file.txt","kind":"file"}
```

## HTTP Fetch 支持

写入文件后，可以通过 HTTP fetch 访问。

```js
import { init } from "/nos/fs/main.js";
import registration from "/_install/register.js";
await registration;

const dir = await init("my-app");
const file = await dir.get("data.json", { create: "file" });
await file.write(JSON.stringify({ hello: "world" }));

// 等待 Service Worker 注册完成
await new Promise((resolve) => setTimeout(resolve, 300));

// 通过 fetch 访问
const res = await fetch("/my-app/data.json");
const data = await res.json();
console.log(data); // { hello: "world" }
```

挂载目录同样支持 fetch：

```js
const dir = await init("my-app");
const mounted = await mount(dir);
await new Promise((resolve) => setTimeout(resolve, 300));

const res = await fetch(`/${mounted.path}/file.txt`);
```

## 下载

将文件或目录下载到本地。

```js
import download from "/nos/fs/download.js";

// 下载单个文件
await download(fileHandle);

// 下载整个目录（多个文件打包为 zip，单个文件直接下载）
await download(dirHandle);
```

## 跨标签页同步

文件系统的变更会通过 `BroadcastChannel("nonefs-system-handle-change")` 广播到同一源的其他标签页。通过 `observe()` 可以收到跨标签页的变更事件。

```js
// 标签页 A：监听变化
const dir = await init("shared-dir");
dir.observe((event) => {
  console.log(event.type, event.path);
});

// 标签页 B（或 iframe）：操作文件
const dir = await init("shared-dir");
const file = await dir.get("test.txt", { create: "file" });
await file.write("hello");
await file.remove();
// 标签页 A 会收到 create / write / remove 事件
```

## 浏览器兼容性

| 特性 | Chrome 86+ | Firefox 111+ | Safari |
|------|-----------|-------------|--------|
| OPFS 虚拟文件系统 | ✅ | ✅ | ✅ |
| `createWritable` 写入 | ✅ | ✅ | ❌（降级 Worker） |
| 本地目录挂载 | ✅ | ⚠️ 不支持存储 | ❌ |
| `FileSystemObserver` | 实验性 | ❌ | ❌ |
