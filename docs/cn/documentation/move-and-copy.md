# 文件移动与复制

本文档介绍如何移动和复制文件及目录。

## 移动文件

使用 `moveTo()` 方法将文件移动到目标目录：

```javascript
import { get } from "/nos/fs/main.js";

const sourceFile = await get("my-app/source.txt", { create: "file" });
await sourceFile.write("Hello, World!");

const targetDir = await get("my-app/target", { create: "dir" });

// 第二个参数为目标文件名，不传则沿用原文件名
const movedFile = await sourceFile.moveTo(targetDir);
// 等同于 sourceFile.moveTo(targetDir, "source.txt")

const content = await movedFile.text();
// content === "Hello, World!"

const oldFile = await get("my-app/source.txt");
// oldFile === null 表示原文件已被移动
```

## 移动目录

`moveTo()` 方法同样适用于目录，会递归移动目录及其所有内容。第二个参数为目标目录名，不传则沿用原目录名：

```javascript
const sourceDir = await get("my-app/sourceDir", { create: "dir" });
await sourceDir.get("file1.txt", { create: "file" });
await sourceDir.get("subDir/file2.txt", { create: "file" });

await (await sourceDir.get("file1.txt")).write("Content 1");
await (await sourceDir.get("subDir/file2.txt")).write("Content 2");

const targetDir = await get("my-app/target", { create: "dir" });
const movedDir = await sourceDir.moveTo(targetDir);
// 等同于 sourceDir.moveTo(targetDir, "sourceDir")

// movedDir 包含 file1.txt 和 subDir/file2.txt
```

## 复制文件

使用 `copyTo()` 方法将文件复制到目标目录：

```javascript
const sourceFile = await get("my-app/source.txt", { create: "file" });
await sourceFile.write("Hello, World!");

const targetDir = await get("my-app/target", { create: "dir" });

// 第二个参数为目标文件名，不传则沿用原文件名
const copiedFile = await sourceFile.copyTo(targetDir);
// 等同于 sourceFile.copyTo(targetDir, "source.txt")

const content = await copiedFile.text();
// content === "Hello, World!"

// 原文件仍然存在
const originalFile = await get("my-app/source.txt");
// originalFile !== null
```

## 复制目录

`copyTo()` 方法同样适用于目录，会递归复制目录及其所有内容。第二个参数为目标目录名，不传则沿用原目录名：

```javascript
const sourceDir = await get("my-app/sourceDir", { create: "dir" });
await sourceDir.get("file1.txt", { create: "file" });
await sourceDir.get("subDir/file2.txt", { create: "file" });

await (await sourceDir.get("file1.txt")).write("Content 1");
await (await sourceDir.get("subDir/file2.txt")).write("Content 2");

const targetDir = await get("my-app/target", { create: "dir" });
const copiedDir = await sourceDir.copyTo(targetDir);
// 等同于 sourceDir.copyTo(targetDir, "sourceDir")

// copiedDir 包含 file1.txt 和 subDir/file2.txt
```

## 完整示例

```javascript
import { get } from "/nos/fs/main.js";

const sourceFile = await get("my-app/document.txt", { create: "file" });
await sourceFile.write("Important content");

const backupDir = await get("my-app/backup", { create: "dir" });
const archiveDir = await get("my-app/archive", { create: "dir" });

// 复制文件
const backup = await sourceFile.copyTo(backupDir, "document_backup.txt");
console.log(await backup.text()); // "Important content"

// 移动文件
await sourceFile.moveTo(archiveDir, "document_archived.txt");

// 验证移动结果
const original = await get("my-app/document.txt");
console.log(original); // null
```

## 下一章

学习 [文件句柄比较](./handle-comparison.md)，了解如何比较文件句柄。