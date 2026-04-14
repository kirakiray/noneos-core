# 文件操作

本文档介绍文件系统中的文件操作，包括创建、写入、读取和删除文件。

## 创建文件

使用 `get` 方法并指定 `create: "file"` 来创建文件：

```javascript
import { get } from "/nos/fs/main.js";

const file = await get("my-app/path/to/file.txt", { create: "file" });
```

## 写入文件

使用 `write` 方法向文件写入内容：

```javascript
const file = await get("my-app/hello.txt", { create: "file" });
await file.write("Hello, World!");
```

`write` 方法支持写入字符串或 Blob 数据。

## 读取文件

### text() 方法

使用 `text()` 方法读取文件的文本内容：

```javascript
const content = await file.text();
console.log(content); // "Hello, World!"
```

### file() 方法

使用 `file()` 方法读取原始 [File 对象](https://developer.mozilla.org/zh-CN/docs/Web/API/File)：

```javascript
const fileObj = await file.file();
console.log(fileObj.name); // 文件名
console.log(fileObj.size); // 文件大小
console.log(fileObj.lastModified); // 最后修改时间
```

### buffer() 方法

使用 `buffer()` 方法读取文件的 [ArrayBuffer](https://developer.mozilla.org/zh-CN/docs/Web/JavaScript/Reference/Global_Objects/ArrayBuffer) 数据：

```javascript
const arrayBuffer = await file.buffer();
```

### read() 方法

`read()` 方法是底层读取方法，支持更多选项：

```javascript
const content = await file.read({
  type: "text",    // 返回类型: "text" | "file" | "buffer"
  start: 0,        // 起始字节
  end: 100,        // 结束字节
});
```

## JSON 操作

### json() 方法

使用 `json()` 方法直接读取并解析 JSON 文件：

```javascript
const data = await file.json();
```

### base64() 方法

使用 `base64()` 方法将文件内容转为 [base64](https://developer.mozilla.org/zh-CN/docs/Glossary/Base64) 编码)：

```javascript
const base64String = await file.base64();
console.log(base64String); // "data:application/octet-stream;base64,..."
```

## 获取文件信息

### lastModified() 方法

使用 `lastModified()` 获取文件的最后修改时间：

```javascript
const timestamp = await file.lastModified();
console.log(new Date(timestamp)); // Date 对象
```

### size 属性

通过 `file()` 方法获取文件大小：

```javascript
const fileObj = await file.file();
console.log(fileObj.size); // 文件大小（字节）
```

## 通过 fetch 获取文件

除了使用句柄，写入文件后，还可以使用浏览器的 `fetch` API 通过 URL 获取文件内容：

```javascript
const file = await get("my-app/file1.txt", { create: "file" });
const someText = "Write some text " + Math.random();
await file.write(someText);

await new Promise((resolve) => setTimeout(resolve, 300));

const content = await fetch("/$my-app/file1.txt").then((e) => e.text());
```

## 删除文件

使用 `remove()` 方法删除文件：

```javascript
const file = await get("my-app/file1.txt", { create: "file" });
await file.remove();

const fileExists = await get("my-app/file1.txt");
// fileExists === null 表示文件已被删除
```

## 完整示例

```javascript
import { get } from "/nos/fs/main.js";

// 创建并写入文件
const file = await get("my-app/example.txt", { create: "file" });
await file.write("This is a test file.");

// 读取文件
const content = await file.text();
console.log(content); // "This is a test file."

// 获取文件信息
const fileInfo = await file.file();
console.log(`文件名: ${fileInfo.name}, 大小: ${fileInfo.size}`);

// 获取最后修改时间
const modified = await file.lastModified();
console.log(`最后修改: ${new Date(modified)}`);

// 删除文件
await file.remove();
const exists = await get("my-app/example.txt");
console.log(exists); // null
```

## 下一章

学习 [目录操作](./directory-operations.md)，了解如何遍历和管理目录。