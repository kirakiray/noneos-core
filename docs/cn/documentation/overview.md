# 概述

文件系统（FileSystem）是一个基于浏览器的虚拟文件系统，提供了一套完整的文件和目录操作 API。

## 初始化

使用文件系统前，需要先初始化一个根目录：

```javascript
import { init } from "/nos/fs/main.js";

await init("my-app");
```

后续教程均假设已完成 `my-app` 的初始化。

## 全局 get 方法

使用全局 `get` 方法获取或创建文件/目录句柄：

```javascript
import { get } from "/nos/fs/main.js";

const file = await get("my-app/hello.txt", { create: "file" });
const dir = await get("my-app/path/to/dir", { create: "dir" });
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

## 下一章

学习 [文件操作](./file-operations.md)，了解如何读写文件和删除文件。