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

目录挂载功能允许访问用户本地文件系统中的**真实目录**，并将其持久化存储。

### open() - 打开目录选择器

```javascript
import { open } from "/nos/fs/main.js";

const handle = await open();
```

### mount() - 挂载目录

```javascript
import { open, mount } from "/nos/fs/main.js";

const handle = await open();
await mount(handle);
```

### 获取已挂载目录列表

```javascript
import { getMounted } from "/nos/fs/main.js";

const mountedDirs = await getMounted();
```

### 卸载目录

```javascript
import { unmount } from "/nos/fs/main.js";

await unmount(handle);
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
