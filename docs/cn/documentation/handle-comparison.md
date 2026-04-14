# 文件句柄比较

本文档介绍如何比较文件句柄，获取父目录、根目录、文件大小和唯一标识符。

## 获取父目录

使用 `parent` 属性获取文件的父目录：

```javascript
const testFile = await testDir.get("a/b/c/d/test.txt", { create: "file" });
const fileParentDir = await testFile.parent;

const directoryD = await testDir.get("a/b/c/d");
const isSame = await fileParentDir.isSame(directoryD);
// isSame === true
```

## 获取根目录

使用 `root` 属性获取文件或目录所属的根目录：

```javascript
const testFile = await testDir.get("a/b/c/d/test.txt", { create: "file" });
const root1 = testFile.root;

const directoryD = await testDir.get("a/b/c/d");
const root2 = directoryD.root;

const isSame = await root1.isSame(root2);
// isSame === true
```

## 判断句柄是否相同

使用 `isSame()` 方法判断两个句柄是否指向同一个文件或目录：

```javascript
const file1 = await testDir.get("path/to/file.txt", { create: "file" });
const file2 = await testDir.get("path/to/file.txt");
const file3 = await testDir.get("path/to/other.txt", { create: "file" });

const result1 = await file1.isSame(file2);
// result1 === true

const result2 = await file1.isSame(file3);
// result2 === false
```

## 获取文件大小

使用 `size()` 方法获取文件的大小：

```javascript
const file = await testDir.get("example.txt", { create: "file" });
await file.write("Hello, World!");

const fileSize = await file.size();
console.log(fileSize); // 13 (字节)
```

对于目录，`size()` 返回 `null`。

## 获取唯一标识符

使用 `id()` 方法获取文件或目录的唯一标识符：

```javascript
const file = await testDir.get("example.txt", { create: "file" });
const id = await file.id();
console.log(id); // 唯一的哈希值字符串
```

## 句柄属性

| 属性 | 描述 | 返回值 |
|------|------|--------|
| `kind` | 句柄类型 | `"file"` 或 `"dir"` |
| `name` | 文件或目录名称 | 字符串 |
| `path` | 完整路径 | 字符串 |
| `parent` | 父目录 | DirHandle |
| `root` | 根目录 | DirHandle |

## 句柄方法

| 方法 | 描述 | 返回值 |
|------|------|--------|
| `isSame(target)` | 判断是否与目标句柄相同 | boolean |
| `size()` | 获取文件大小（文件）或 null（目录） | number \| null |
| `id()` | 获取唯一标识符 | string |
| `remove()` | 删除文件或目录 | void |
| `copyTo(target, name)` | 复制到目标目录 | FileHandle \| DirHandle |
| `moveTo(target, name)` | 移动到目标目录 | FileHandle \| DirHandle |
| `observe(func)` | 监听文件变化 | () => void |

## 完整示例

```javascript
import { init } from "/nos/fs/main.js";

const testDir = await init("my-app");

const deepFile = await testDir.get("a/b/c/deep.txt", { create: "file" });
await deepFile.write("Hello!");

// 获取父目录
const parent = await deepFile.parent;
console.log(parent.name); // "c"

// 获取根目录
const root = deepFile.root;
console.log(root.path); // "my-app"

// 获取文件大小
const size = await deepFile.size();
console.log(size); // 6

// 获取唯一标识符
const id = await deepFile.id();
console.log(id); // "abc123..."

// 通过不同路径获取同一文件
const file2 = await testDir.get("a/b/c/deep.txt");
console.log(await deepFile.isSame(file2)); // true
```

## 下一章

学习 [文件变化观察](./file-observation.md)，了解如何监听文件变化事件。