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
// 创建文件后挂载，通过挂载路径重新获取
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

### 通过 Fetch 访问挂载目录 (HTTP)

配合 Service Worker 注册，挂载目录中的文件可以通过 HTTP fetch 直接访问：

```javascript
import registration from "/_install/register.js";
await registration;

// 写入文件后挂载
const testFile = await testDir.get("fetch-test.txt", { create: "file" });
await testFile.write("sample content");
const mountedHandle = await mount(testDir);

// 通过 HTTP fetch 访问
const response = await fetch(`/${mountedHandle.path}/fetch-test.txt`);
const text = await response.text(); // "sample content"
```

### 获取已挂载目录列表

`getMounted()` 返回一个数组，每项包含 `{ path, handle }`：

```javascript
import { getMounted } from "/nos/fs/main.js";

const allHandles = await getMounted();
// 例: [{ path: "$mount-my-dir-xxxxx", handle: DirHandle }, ...]

// 查找已挂载的目录
const found = allHandles.find(item => item.path === mountedHandle.path);
```

### 卸载目录

`unmount()` 可以直接传入 `mount()` 返回的句柄，也可以传入 `getMounted()` 返回列表中的 `handle`：

```javascript
import { unmount, getMounted } from "/nos/fs/main.js";

// 方式一：直接传入挂载句柄
await unmount(mountedHandle);

// 方式二：从已挂载列表中找到后卸载
const allHandles = await getMounted();
const found = allHandles.find(item => item.path === mountedHandle.path);
if (found) {
  await unmount(found.handle);
}
```

---

## 移动与复制

### 移动文件/目录

```javascript
const movedFile = await sourceFile.moveTo(targetDir);
```

### 复制文件/目录

```javascript
const copiedFile = await sourceFile.copyTo(targetDir);
```

---

## 句柄比较与信息

| 方法 | 描述 | 返回值 |
|------|------|--------|
| `isSame(target)` | 是否相同 | boolean |
| `size()` | 文件大小 | number \| null |
| `id()` | 唯一标识符 | string |
| `parent` | 获取父目录 | Promise<DirHandle> |
| `root` | 获取根目录 | DirHandle |

---

## 文件变化观察

```javascript
const unobserve = await dir.observe((event) => {
  console.log("变化:", event.type, event.path);
});
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
