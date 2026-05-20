# 目录挂载

目录挂载功能允许你访问用户本地文件系统中的**真实目录**，并将其持久化存储，以便在后续会话中继续使用。

> **真实目录**：指您 **Windows** / **macOS** / **Linux** 系统上的实际文件夹，区别于虚拟文件系统中的目录。

## 重要说明

### 浏览器支持

`open()` 方法依赖于浏览器的 `showDirectoryPicker` API，目前**仅 Chrome 浏览器完整支持**此功能。

```javascript
// 检测浏览器是否支持
if (!window.showDirectoryPicker) {
  console.error("当前浏览器不支持目录选择功能");
  console.log("请使用 Chrome 浏览器以获得完整功能");
  return;
}
```

### 核心用途

目录挂载的主要用途是配合 `open()` 访问用户本地文件系统：

1. **本地文件访问**：让用户选择本地目录，通过浏览器直接访问文件内容
2. **静态服务器功能**：挂载后的本地目录可以通过 HTTP 请求访问，实现类似本地静态服务器的功能
3. **持久化访问**：通过 `mount()` 挂载后，可以在后续会话中继续访问同一本地目录，无需重复选择

**注意**：对于通过 `init()` 创建的虚拟文件系统目录，已经自动支持 HTTP 访问，无需使用 `mount()`。

### 典型应用场景

- 本地项目开发：直接在浏览器中访问和编辑本地项目文件
- 静态资源服务：将本地目录挂载为可访问的静态资源路径
- 文件管理工具：构建基于浏览器的文件管理应用

## 基本概念

### open() - 打开目录选择器

`open()` 方法会弹出系统的目录选择器，让用户选择一个本地目录：

```javascript
import { open } from "/nos/fs/main.js";

const handle = await open();
```

用户选择目录后，系统会请求读写权限。如果用户授予权限，将返回一个 `DirHandle` 对象。

**注意**：`open()` 仅用于访问用户本地文件系统。对于虚拟文件系统目录，请使用 `init()` 创建。

### mount() - 挂载目录

`mount()` 方法将本地目录句柄保存起来，以便后续会话可以重新访问：

```javascript
import { open, mount } from "/nos/fs/main.js";

const handle = await open(); // 打开目录选择器，此时 path 为虚拟路径
await mount(handle); // 挂载后，path 变为 $mount-{id}>目录名

console.log(handle.path); // 输出: $mount-123>目录名
```

挂载后的路径格式为：`$mount-{id}>目录名`

#### 两步流程的优势

推荐使用两步流程（先 `open()` 后 `mount()`），而不是一次性挂载：

1. **验证目录内容**：在挂载前可以先浏览目录内容，确认是否为所需目录
2. **避免错误挂载**：防止用户选错目录后，错误地挂载到系统中
3. **灵活决策**：可以根据目录内容决定是否挂载

```javascript
const handle = await open();

// 先验证目录内容
const packageJson = await handle.get("package.json");
const data = await packageJson.json();
if (data.somedata) {
  // 确认是符合条件的目录，再挂载
  await mount(handle);
  console.log("符合条件的目录已挂载:", handle.path);
} else {
  console.log("这是不符合条件的目录，取消挂载");
}
```

**重要**：

- `mount()` 主要用于持久化 `open()` 打开的本地目录
- 对于 `init()` 创建的虚拟文件系统目录，无需使用 `mount()`

### 一次性打开并挂载

你可以使用 `open()` 的 `mount` 参数，在选择目录后自动挂载：

```javascript
import { open } from "/nos/fs/main.js";

const handle = await open({ mount: true });
// 等价于：
// const handle = await open();
// await mount(handle);
```

## mount() 的主要用途

`mount()` 方法主要用于配合 `open()` 使用，将用户选择的本地目录持久化存储。**对于通过 `init()` 创建的虚拟文件系统目录，不需要使用 `mount()`**。

### 虚拟文件系统目录（不需要 mount）

通过 `init()` 创建的目录已经可以直接通过 HTTP 访问：

```javascript
import { init } from "/nos/fs/main.js";

// 创建虚拟文件系统目录
const dir = await init("my-app");
await dir.get("test.txt", { create: "file" });

// 直接通过 $rootdirName 方式访问
const response = await fetch("/$my-app/test.txt");
const content = await response.text();
```

这些目录路径格式为：`$目录名`，无需挂载即可通过 HTTP 访问。

### 本地目录（需要 mount）

通过 `open()` 打开的本地目录需要挂载才能持久化访问：

```javascript
import { open, mount } from "/nos/fs/main.js";

// 打开用户本地目录
const handle = await open();

// 需要挂载才能在后续会话中继续访问
await mount(handle);

// 挂载后可通过 $mount-{id}>目录名 方式访问
const response = await fetch(`/${handle.path}/file.txt`);
```

### 两种目录对比

| 特性           | 虚拟文件系统目录   | 本地目录（mount）      |
| -------------- | ------------------ | ---------------------- |
| 创建方式       | `init("dir-name")` | `open()` + `mount()`   |
| 路径格式       | `$dir-name`        | `$mount-{id}>dir-name` |
| HTTP 访问      | ✅ 直接支持        | ✅ 需要挂载后支持      |
| 持久化         | ✅ 自动持久化      | ✅ 需要 mount 持久化   |
| 数据位置       | 浏览器存储         | 用户本地文件系统       |
| 是否需要 mount | ❌ 不需要          | ✅ 需要                |
| 浏览器支持     | 所有现代浏览器     | 仅 Chrome              |

## 管理已挂载的目录

### 获取已挂载目录列表

使用 `getMounted()` 获取所有已挂载的目录：

```javascript
import { getMounted } from "/nos/fs/main.js";

const mountedDirs = await getMounted();

mountedDirs.forEach((item) => {
  console.log(item.id); // 挂载ID
  console.log(item.name); // 目录名称
  console.log(item.path); // 挂载路径
  console.log(item.handle); // DirHandle 对象
});
```

### 卸载目录

使用 `unmount()` 移除已挂载的目录。该方法支持两种参数类型：

#### 方式 1：通过 ID 卸载

```javascript
import { unmount } from "/nos/fs/main.js";

await unmount(mountId);
```

#### 方式 2：通过 Handle 对象卸载（推荐）

```javascript
import { open, mount, unmount } from "/nos/fs/main.js";

const handle = await open({ mount: true });
// 使用 handle...

// 直接使用 handle 对象卸载
await unmount(handle);
```

#### 从挂载列表中卸载

```javascript
import { getMounted, unmount } from "/nos/fs/main.js";

const mounted = await getMounted();
for (const item of mounted) {
  // 使用 handle 对象卸载
  await unmount(item.handle);

  // 或者使用 ID 卸载
  // await unmount(item.id);
}
```

卸载后，该目录将无法通过挂载路径访问。

**注意**：只能卸载已挂载的 handle（路径以 `$mount-` 开头）。尝试卸载未挂载的 handle 会抛出错误。

## 通过挂载路径访问文件

### 使用 get() 方法

挂载后的目录可以通过挂载路径访问：

```javascript
import { get } from "/nos/fs/main.js";

// 假设已挂载的路径是 $mount-123>my-project
const file = await get("$mount-123>my-project/src/index.js");
const content = await file.text();
```

### 访问子目录

```javascript
const subdir = await get("$mount-123>my-project/src");
const files = await subdir.values();

for await (const file of files) {
  console.log(file.name);
}
```

## 通过 HTTP 访问挂载文件（静态服务器功能）

挂载后的目录可以通过 HTTP 请求访问文件，实现类似本地静态服务器的功能。这是目录挂载的核心特性之一。

### 基本用法

```javascript
import { open, mount } from "/nos/fs/main.js";

const handle = await open({ mount: true });

// 创建测试文件
const testFile = await handle.get("test.txt", { create: "file" });
await testFile.write("Hello, World!");

// 通过 HTTP 访问（类似静态服务器）
const response = await fetch(`/${handle.path}/test.txt`);
const content = await response.text();
console.log(content); // 输出: Hello, World!
```

### 实际应用示例

```javascript
// 挂载本地项目目录
const projectHandle = await open({ mount: true });

// 现在可以通过 HTTP 访问项目中的任何文件
const htmlResponse = await fetch(`/${projectHandle.path}/index.html`);
const htmlContent = await htmlResponse.text();

const jsResponse = await fetch(`/${projectHandle.path}/src/app.js`);
const jsContent = await jsResponse.text();

const cssResponse = await fetch(`/${projectHandle.path}/styles/main.css`);
const cssContent = await cssResponse.text();

// 就像访问本地静态服务器一样
```

### 应用场景

- **本地开发服务器**：无需启动 Node.js 服务器，直接在浏览器中访问本地文件
- **项目预览**：实时预览本地 HTML/CSS/JS 项目
- **资源加载**：在 Web 应用中加载本地图片、字体等资源

## 完整示例

### 创建项目并挂载

```javascript
import { open, mount, getMounted, unmount } from "/nos/fs/main.js";

// 打开目录选择器
const handle = await open();

// 检查是否已挂载
const mounted = await getMounted();
const existing = mounted.find((item) => item.name === handle.name);

if (existing) {
  console.log("目录已挂载:", existing.path);
} else {
  // 挂载目录
  await mount(handle);
  console.log("目录已挂载:", handle.path);
}

// 使用挂载的目录
const packageJson = await handle.get("package.json");
if (packageJson) {
  const config = await packageJson.json();
  console.log("项目名称:", config.name);
}
```

### 管理多个挂载目录

```javascript
import { getMounted, unmount } from "/nos/fs/main.js";

// 获取所有挂载
const allMounts = await getMounted();

// 过滤特定项目
const projects = allMounts.filter((item) => item.name.includes("project"));

// 卸载旧项目
for (const project of projects) {
  if (project.time < Date.now() - 30 * 24 * 60 * 60 * 1000) {
    await unmount(project.handle);
    console.log("已卸载:", project.name);
  }
}
```

## 权限管理

### 检查和请求权限

浏览器会在首次访问时请求权限。如果权限被拒绝或过期，需要重新请求：

```javascript
import { get } from "/nos/fs/main.js";

try {
  const handle = await get("$mount-123>my-project");
  // 使用 handle
} catch (error) {
  if (error.message.includes("Permission denied")) {
    console.log("需要重新授权");
    // 提示用户重新选择目录
  }
}
```

## 浏览器兼容性

### 支持情况

- ✅ Chrome 86+ / Edge 86+  - **完整支持**（推荐使用）
- ⚠️ Firefox 111+ - **不支持** `showDirectoryPicker`，但可挂载虚拟目录
- ❌ Safari - **不支持** `showDirectoryPicker`，也不支持挂载虚拟目录

### 核心功能说明

**`open()` 方法**依赖于 `showDirectoryPicker` API，暂时是 Chrome 独有的功能：

- **Chrome**：完整支持，可以弹出目录选择器，并持久化存储句柄
- **其他浏览器**：不支持目录选择功能，无法使用 `open()` 方法

### 推荐使用方式

```javascript
import { open, mount } from "/nos/fs/main.js";

// 检测浏览器支持
if (!window.showDirectoryPicker) {
  alert("此功能需要 Chrome 浏览器支持");
  return;
}

// Chrome 中使用
const handle = await open({ mount: true });
console.log("已挂载本地目录:", handle.path);

// 通过 HTTP 访问本地文件
const response = await fetch(`/${handle.path}/index.html`);
const content = await response.text();
```

### Safari 完全不支持

Safari 既不支持 `showDirectoryPicker` API，也不支持将 `FileSystemHandle` 存储到 IndexedDB：

```javascript
// Safari 中无法使用
const handle = await open(); // ❌ 报错: showDirectoryPicker is not supported
```

### 检测浏览器支持

```javascript
const isFileSystemSupported = !!window.showDirectoryPicker;

if (!isFileSystemSupported) {
  console.log("当前浏览器不支持目录选择功能");
  console.log("请使用 Chrome 浏览器以获得完整功能");
}
```

## 最佳实践

1. **浏览器检测**：在使用前检测浏览器是否支持 `showDirectoryPicker`
2. **用户提示**：明确告知用户此功能需要 Chrome 浏览器
3. **错误处理**：处理权限拒绝和目录不存在的情况
4. **清理旧挂载**：定期清理不再需要的挂载目录
5. **静态服务器功能**：充分利用 HTTP 访问特性，实现本地文件服务

### 推荐的完整实现

```javascript
import { open, mount, getMounted, unmount } from "/nos/fs/main.js";

async function setupLocalProject() {
  // 1. 检测浏览器支持
  if (!window.showDirectoryPicker) {
    alert(
      "此功能需要 Chrome 浏览器支持。\n\n请使用 Chrome 浏览器以获得完整的本地文件访问功能。",
    );
    return null;
  }

  try {
    // 2. 打开并挂载目录
    const handle = await open({ mount: true });

    // 3. 验证是否为有效项目
    const packageJson = await handle.get("package.json");
    if (!packageJson) {
      console.warn("选择的目录不是一个有效的项目");
    }

    console.log("本地项目已挂载:", handle.path);
    console.log("可通过 HTTP 访问:", `/${handle.path}/`);

    return handle;
  } catch (error) {
    if (error.message.includes("Permission denied")) {
      alert("需要授予目录访问权限才能使用此功能");
    } else {
      console.error("挂载失败:", error);
    }
    return null;
  }
}

// 使用示例
const projectHandle = await setupLocalProject();
if (projectHandle) {
  // 通过 HTTP 访问本地文件
  const response = await fetch(`/${projectHandle.path}/README.md`);
  const readme = await response.text();
  console.log(readme);
}
```

## 下一章

学习 [文件操作](./file-operations.md)，了解如何读写文件和删除文件。
