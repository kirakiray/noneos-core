# 概述

文件系统（FileSystem）是一个基于浏览器的虚拟文件系统，提供了一套完整的文件和目录操作 API。

## 初始化

使用文件系统前，需要先初始化一个根目录：

```javascript
import { init } from "/nos/fs/main.js";

const testDir = await init("my-app-data");
```

## 获取或创建文件/目录句柄

### 通过初始化目录获取

使用 `get` 方法从已初始化的目录获取文件或目录句柄：

```javascript
const file = await testDir.get("path/to/file.txt", { create: "file" });
const dir = await testDir.get("path/to/dir", { create: "dir" });
```

### 全局 get 方法

如果目录已经初始化过，可以直接使用全局 `get` 方法，无需再次初始化：

```javascript
import { get } from "/nos/fs/main.js";

// 之后可以直接通过全局 get 获取文件
const file = await get("my-app/hello.txt");
```

路径格式：`根目录名/文件路径`，不使用 `/` 开头。

## 核心概念

### FileHandle 和 DirHandle

- **FileHandle**：代表一个文件，提供文件读写操作
- **DirHandle**：代表一个目录，提供目录遍历和子项操作

### 基本属性

- `kind`：返回 `"file"` 或 `"dir"`，表示句柄类型
- `name`：返回文件或目录的名称
- `path`：返回文件或目录的完整路径

## 使用示例

```javascript
import { init, get } from "/nos/fs/main.js";

// 初始化文件系统
const testDir = await init("my-app");

// 创建并写入文件
const file = await testDir.get("hello.txt", { create: "file" });
await file.write("Hello, World!");

// 读取文件
const content = await file.text();
console.log(content); // "Hello, World!"

// 使用全局 get 获取文件（无需再次初始化）
const file2 = await get("my-app/hello.txt");
const isSame = await file.isSame(file2); // true
```

## 下一章

学习 [文件操作](./file-operations.md)，了解如何读写文件和删除文件。