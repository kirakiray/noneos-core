# 文件变化观察

本文档介绍如何使用 `observe` 方法监听文件系统的变化事件。

## 基本用法

使用 `observe()` 方法监听目录中的文件变化：

```javascript
const testDir = await init("test-dir-observe");

const events = [];

const unobserve = await testDir.observe((event) => {
  console.log("收到文件变化事件:", event);
  events.push(event);
});

// 创建文件
const file = await testDir.get("test.txt", { create: "file" });
await file.write("Hello");

// 删除文件
await file.remove();

// 取消观察
unobserve();
```

## observe 返回值

`observe()` 返回一个 Promise，解析为取消观察的函数。调用该函数可以停止监听：

```javascript
const unobserve = await testDir.observe((event) => {
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
| `target` | 触发事件的目标句柄 |

## 跨标签页观察

`observe` 方法支持跨标签页观察文件系统变化。当在另一个标签页或 iframe 中修改文件时，当前页面可以收到通知：

```javascript
const testDir = await init("test-dir-cross-tab");

const events = [];

const unobserve = await testDir.observe((event) => {
  events.push(event);
});
```

### iframe 示例

父页面监听变化：

```javascript
const testDir = await init("test-dir-cross-tab");

const events = [];
const unobserve = await testDir.observe((event) => {
  events.push(event);
});

const iframe = document.getElementById("testFrame");
iframe.src = "./observe-frame.html";

await new Promise((resolve) => setTimeout(resolve, 500));

unobserve();

// events 中包含来自 iframe 的文件操作事件
```

iframe 中执行操作：

```javascript
import { init } from "/nos/fs/main.js";

const testDir = await init("test-dir-cross-tab");

const file = await testDir.get("test-from-iframe.txt", {
  create: "file",
});
await file.write("Hello from iframe!");
await file.remove();
```

## 完整示例

```javascript
import { init } from "/nos/fs/main.js";

const testDir = await init("my-app");

console.log("开始文件变化观察测试");

const events = [];
const unobserve = await testDir.observe((event) => {
  console.log("文件变化:", event.type, event.path);
  events.push(event);
});

// 执行一些文件操作
await testDir.get("file1.txt", { create: "file" });
await (await testDir.get("file1.txt")).write("content");

await new Promise((resolve) => setTimeout(resolve, 100));

await (await testDir.get("file1.txt")).remove();

await new Promise((resolve) => setTimeout(resolve, 100));

unobserve();

console.log(`共收到 ${events.length} 个事件`);
```

## 注意事项

1. 观察者创建后才会开始监听，之前的文件操作不会被捕获
2. 取消观察后，新发生的文件变化不会被记录
3. 文件变化事件是异步触发的，可能存在一定延迟