# 目录操作

本文档介绍文件系统中的目录操作，包括创建目录、遍历、查找、扁平化和删除。

## 创建目录

使用 `get` 方法并指定 `create: "dir"` 来创建目录：

```javascript
const dir = await testDir.get("path/to/dir", { create: "dir" });
```

## 获取子项数量

使用 `length()` 方法获取目录中子文件/目录的总数量：

```javascript
const dir = await testDir.get("subDir", { create: "dir" });
await dir.get("file1.txt", { create: "file" });
await dir.get("file2.txt", { create: "file" });

const count = await dir.length();
console.log(count); // 2
```

## 遍历目录

### keys() 方法

使用 `keys()` 方法遍历目录中所有项的名称：

```javascript
for await (const key of testDir.keys()) {
  console.log(key);
}
```

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

### entries() 方法

使用 `entries()` 方法遍历目录中的所有项，返回 [名称, 句柄] 对：

```javascript
for await (const [name, handle] of testDir.entries()) {
  console.log(`${handle.kind}: ${name}`);
}
```

### forEach() 方法

使用 `forEach()` 方法遍历目录：

```javascript
await testDir.forEach(async (handle, name) => {
  console.log(`${handle.kind}: ${name}`);
});
```

### some() 方法

使用 `some()` 方法查找满足条件的第一个文件或目录，找到后自动停止遍历：

```javascript
let foundTarget = false;
let count = 0;

await testDir.some(async (handle, name) => {
  count++;
  if (handle.kind === "file") {
    if (count === 2) {
      foundTarget = true;
      return true; // 返回 true 停止遍历
    }
  }
  return false;
});
```

## 扁平化目录

使用 `flat()` 方法获取目录及其所有子目录中的所有**文件句柄**（不包括目录）：

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

使用 `remove()` 方法删除目录（会递归删除目录下所有内容）：

```javascript
const subDir = await testDir.get("subDir", { create: "dir" });
const file2 = await subDir.get("file2.txt", { create: "file" });

await subDir.remove();
const subDirExists = await testDir.get("subDir");
// subDirExists === null 表示目录已被删除
```

⚠️ 警告：删除操作会立即执行，即使目录下有子文件或子目录也会被一并删除，且无法恢复。请谨慎操作。


## 完整示例

```javascript
import { init } from "/nos/fs/main.js";

const testDir = await init("my-app");

// 创建目录结构
await testDir.get("docs", { create: "dir" });
await testDir.get("docs/guide.md", { create: "file" });
await testDir.get("docs/api.md", { create: "file" });
await testDir.get("images", { create: "dir" });

// 获取子项数量
const count = await testDir.length();
console.log(`子项数量: ${count}`); // 2

// 遍历根目录
for await (const [name, handle] of testDir.entries()) {
  console.log(`${handle.kind}: ${name}`);
}
// 输出: dir: docs, dir: images

// 扁平化获取所有文件
const allFiles = await testDir.flat();
console.log(allFiles.map(f => f.path));
// 输出: ["docs/guide.md", "docs/api.md"]
```

## 下一章

学习 [文件移动与复制](./move-and-copy.md)，了解如何移动和复制文件。