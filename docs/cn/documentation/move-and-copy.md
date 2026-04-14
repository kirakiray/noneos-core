# 文件移动与复制

本文档介绍如何移动和复制文件及目录。

## 移动文件

使用 `moveTo()` 方法将文件移动到目标目录：

```javascript
const sourceFile = await testDir.get("source.txt", { create: "file" });
await sourceFile.write("Hello, World!");

const targetDir = await testDir.get("target", { create: "dir" });

const movedFile = await sourceFile.moveTo(targetDir, "moved.txt");

const content = await movedFile.read();
// content === "Hello, World!"

const oldFile = await testDir.get("source.txt");
// oldFile === null 表示原文件已被移动
```

## 移动目录

`moveTo()` 方法同样适用于目录，会递归移动目录及其所有内容：

```javascript
const sourceDir = await testDir.get("sourceDir", { create: "dir" });
const file1 = await sourceDir.get("file1.txt", { create: "file" });
const subDir = await sourceDir.get("subDir", { create: "dir" });
const file2 = await subDir.get("file2.txt", { create: "file" });

await file1.write("Content 1");
await file2.write("Content 2");

const targetDir = await testDir.get("target", { create: "dir" });
const movedDir = await sourceDir.moveTo(targetDir, "movedSourceDir");

// movedDir 包含 file1.txt 和 subDir/file2.txt
```

## 复制文件

使用 `copyTo()` 方法将文件复制到目标目录：

```javascript
const sourceFile = await testDir.get("source.txt", { create: "file" });
await sourceFile.write("Hello, World!");

const targetDir = await testDir.get("target", { create: "dir" });

const copiedFile = await sourceFile.copyTo(targetDir, "copied.txt");

const content = await copiedFile.text();
// content === "Hello, World!"

// 原文件仍然存在
const originalFile = await testDir.get("source.txt");
// originalFile !== null
```

## 复制目录

`copyTo()` 方法同样适用于目录，会递归复制目录及其所有内容：

```javascript
const sourceDir = await testDir.get("sourceDir", { create: "dir" });
const file1 = await sourceDir.get("file1.txt", { create: "file" });
const subDir = await sourceDir.get("subDir", { create: "dir" });
const file2 = await subDir.get("file2.txt", { create: "file" });

await file1.write("Content 1");
await file2.write("Content 2");

const targetDir = await testDir.get("target", { create: "dir" });
const copiedDir = await sourceDir.copyTo(targetDir, "copiedSourceDir");

// copiedDir 包含 file1.txt 和 subDir/file2.txt
```

## 完整示例

```javascript
import { init } from "/nos/fs/main.js";

const testDir = await init("my-app");

// 创建源文件
const sourceFile = await testDir.get("document.txt", { create: "file" });
await sourceFile.write("Important content");

// 创建目标目录
await testDir.get("backup", { create: "dir" });

// 复制文件
const backup = await sourceFile.copyTo(await testDir.get("backup"), "document_backup.txt");
console.log(await backup.text()); // "Important content"

// 移动文件
await sourceFile.moveTo(await testDir.get("archive"), "document_archived.txt");

// 验证移动结果
const original = await testDir.get("document.txt");
console.log(original); // null
```

## 下一章

学习 [文件句柄比较](./handle-comparison.md)，了解如何比较文件句柄。