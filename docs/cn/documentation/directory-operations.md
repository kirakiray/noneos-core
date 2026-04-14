# 目录操作

本文档介绍文件系统中的目录操作，包括创建目录、遍历、查找、扁平化和删除。

## 创建目录

使用 `get` 方法并指定 `create: "dir"` 来创建目录：

```javascript
const dir = await testDir.get("path/to/dir", { create: "dir" });
```

## 遍历目录

### values() 方法

使用 `values()` 方法遍历目录中的所有文件和子目录：

```javascript
const handles = [];
for await (const handle of testDir.values()) {
  handles.push({
    kind: handle.kind,
    name: handle.name,
  });
}
```

### some() 方法

使用 `some()` 方法查找满足条件的第一个文件或目录：

```javascript
let foundTarget = false;
let count = 0;

await testDir.some(async (handle, name) => {
  count++;
  if (handle.kind === "file") {
    if (count === 2) {
      foundTarget = true;
      return true; // 停止遍历
    }
  }
  return false;
});
```

## 扁平化目录

使用 `flat()` 方法获取目录及其所有子目录中的所有文件：

```javascript
const allFiles = await testDir.flat();

const fileContents = await Promise.all(
  allFiles.map(async (file) => ({
    path: file.path,
    content: await file.read(),
  }))
);
```

示例：

```javascript
const file1 = await testDir.get("file1.txt", { create: "file" });
const subDir1 = await testDir.get("subDir1", { create: "dir" });
const file2 = await testDir.get("subDir1/file2.txt", { create: "file" });
const subDir2 = await testDir.get("subDir1/subDir2", { create: "dir" });
const file3 = await testDir.get("subDir1/subDir2/file3.txt", { create: "file" });

await file1.write("root file");
await file2.write("level 1 file");
await file3.write("level 2 file");

const allFiles = await testDir.flat();
// 返回: [file1.txt, subDir1/file2.txt, subDir1/subDir2/file3.txt]
```

## 删除目录

使用 `remove()` 方法删除目录：

```javascript
const subDir = await testDir.get("subDir", { create: "dir" });
const file2 = await subDir.get("file2.txt", { create: "file" });

await subDir.remove();
const subDirExists = await testDir.get("subDir");
// subDirExists === null 表示目录已被删除
```

## 完整示例

```javascript
import { init } from "/nos/fs/main.js";

const testDir = await init("my-app");

// 创建目录结构
await testDir.get("docs", { create: "dir" });
await testDir.get("docs/guide.md", { create: "file" });
await testDir.get("docs/api.md", { create: "file" });
await testDir.get("images", { create: "dir" });

// 遍历根目录
for await (const handle of testDir.values()) {
  console.log(`${handle.kind}: ${handle.name}`);
}
// 输出: dir: docs, file: images

// 扁平化获取所有文件
const allFiles = await testDir.flat();
console.log(allFiles.map(f => f.path));
// 输出: ["docs/guide.md", "docs/api.md"]
```

## 下一章

学习 [文件移动与复制](./move-and-copy.md)，了解如何移动和复制文件。