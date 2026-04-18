# 文件变化观察

本文档介绍如何使用 `observe` 方法监听文件或目录的变化事件。

## 基本用法

使用 `observe()` 方法监听文件或目录中的变化：

```javascript
import { get } from "/nos/fs/main.js";

const dir = await get("my-app");

const events = [];
const unobserve = await dir.observe((event) => {
  console.log("收到文件变化事件:", event);
  events.push(event);
});

// 创建文件
const file = await dir.get("test.txt", { create: "file" });
await file.write("Hello");

// 删除文件
await file.remove();

// 取消观察
unobserve();
```

文件和目录都可以监听变化，例如监听单个文件：

```javascript
const file = await get("my-app/test.txt", { create: "file" });

const unobserve = await file.observe((event) => {
  console.log("文件被修改:", event.type);
});

await file.write("new content");

unobserve();
```

## observe 返回值

`observe()` 返回一个 Promise，解析为取消观察的函数。调用该函数可以停止监听：

```javascript
const unobserve = await dir.observe((event) => {
  // 处理事件
});

// 稍后取消观察
unobserve();
```

## 事件对象

观察回调接收到的事件对象包含以下属性：

| 属性 | 描述 |
|------|------|
| `type` | 事件类型，如 `"create"`, `"remove"`, `"write"` |
| `path` | 发生变化的文件路径 |

## 完整示例

```javascript
import { get } from "/nos/fs/main.js";

const dir = await get("my-app");

console.log("开始文件变化观察测试");

const events = [];
const unobserve = await dir.observe((event) => {
  console.log("文件变化:", event.type, event.path);
  events.push(event);
});

// 执行一些文件操作
await dir.get("file1.txt", { create: "file" });
await (await dir.get("file1.txt")).write("content");

await new Promise((resolve) => setTimeout(resolve, 100));

await (await dir.get("file1.txt")).remove();

await new Promise((resolve) => setTimeout(resolve, 100));

unobserve();

console.log(`共收到 ${events.length} 个事件`);
```

## 注意事项

1. 观察者创建后才会开始监听，之前的文件操作不会被捕获
2. 取消观察后，新发生的文件变化不会被记录
3. 文件变化事件是异步触发的，可能存在一定延迟