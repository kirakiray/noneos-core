# nos/fs 文件系统模块上下文

> 本文档供 AI 阅读，用于快速理解 `nos/fs` 模块的整体架构与实现细节，无需逐文件阅读源码即可进行代码更新。

## 一、整体架构

NoneOS Core 文件系统是一个基于浏览器的虚拟文件系统，底层依赖 **OPFS (Origin Private File System)** 作为存储后端，并通过混入（mixin）模式复用公共方法。

### 核心设计

1. **分层设计**：`public/` 提供与后端无关的公共方法（通过 `extend*` 混入），`handle/` 提供 OPFS 具体实现，`handle/mount/` 提供本地目录挂载能力。
2. **路径路由**：入口 `main.js` 的 `get` 根据路径前缀分发到不同后端：
   - `$mount-xxx` → 本地挂载目录（`handle/mount/mount.js`）
   - `$user-xxx:rootName/...` → 远端用户目录（通过 RTC，动态导入 `./fs-remote/main.js`）
   - 其他 → 系统 OPFS 目录（`handle/main.js`）
3. **跨标签页同步**：通过 `BroadcastChannel("nonefs-system-handle-change")` 广播文件变更，配合 `observers` Set 实现观察者通知。

## 二、模块地图

```
nos/fs/
├── main.js                  # 统一入口：聚合 get/init/open/mount/getMounted/unmount
├── download.js              # 下载句柄到本地（文件直下，目录打包 zip）
├── CONTEXT.md               # 本文档
├── handle/                  # OPFS 后端实现
│   ├── main.js              #   OPFS get/init：navigator.storage.getDirectory()
│   ├── base.js              #   BaseHandle：封装 OPFS 原生句柄
│   ├── dir.js               #   DirHandle：目录操作（get/length/keys）
│   ├── file.js              #   FileHandle：文件读写（read/write，Safari 降级）
│   ├── write-worker.js      #   Web Worker：Safari 写入降级方案
│   └── mount/               # 本地目录挂载
│       ├── db.js            #   IndexedDB 持久化 FileSystemHandle
│       └── mount.js         #   open/mount/unmount/get/getMounted
└── public/                  # 公共方法（混入到 handle 类）
    ├── base.js              #   PublicBaseHandle + notify 观察者系统
    ├── dir.js               #   PublicDirHandle：entries/values/flat/forEach/some
    └── file.js              #   PublicFileHandle：text/file/buffer/json/base64
```

## 三、类继承与混入关系

```
PublicBaseHandle (public/base.js)
  └── BaseHandle (handle/base.js)        ← 封装 OPFS 原生句柄
        ├── DirHandle (handle/dir.js)    ← 混入 PublicDirHandle 方法
        └── FileHandle (handle/file.js)  ← 混入 PublicFileHandle 方法
```

混入机制：`extendDirHandle(DirHandle)` / `extendFileHandle(FileHandle)` 在类定义后调用，将 `PublicDirHandle` / `PublicFileHandle` 原型上的方法混入目标类（跳过已存在的方法）。

## 四、关键 API

### 入口层（main.js）

| 函数 | 说明 |
|------|------|
| `get(path, options)` | 按路径获取句柄，自动路由到 mount/remote/system |
| `init(name)` | 初始化 OPFS 根目录（`navigator.storage.getDirectory()`） |
| `open(options?)` | 弹出系统目录选择器，返回 DirHandle；options：`{ mode?: "read"|"readwrite"（默认 readwrite）, id?: string, mount?: true }`；不支持 `showDirectoryPicker` 时抛错 |
| `mount(handle)` | 持久化本地目录句柄到 IndexedDB，设置 `$mount-{id}>{encodeURI(name)}` 路径；若 handle 已挂载（`RESET_PATH` 已存在）则幂等直接返回 |
| `unmount(idOrHandle)` | 从 IndexedDB 删除挂载记录 |
| `getMounted()` | 返回所有已挂载目录列表 `[{id, name, path, handle}]` |

### 句柄通用方法（PublicBaseHandle）

| 方法/属性 | 说明 |
|-----------|------|
| `kind` | `"file"` 或 `"dir"` |
| `name` | 名称（来自原生句柄） |
| `path` | 完整路径（递归拼接 parent，或 `RESET_PATH` 覆盖） |
| `parent` / `root` | 父句柄 / 根句柄 |
| `isSame(target)` | 是否同一句柄（`isSameEntry`） |
| `id()` | 唯一标识（优先 `getUniqueId`，否则 path 哈希） |
| `size()` | 文件大小（目录返回 null） |
| `remove()` | 删除（递归），触发 `notify` |
| `copyTo(target, name?)` | 递归复制；首参数可为字符串（视为新名，target 自动取 `self.parent`）；禁止把目录复制到自身子目录（抛错） |
| `moveTo(target, name?)` | 递归移动（复制后删除原）；首参数同样可为字符串；与自身同一对象直接返回 self；同样禁止移入子目录 |
| `observe(func)` | 监听变化，返回取消函数 |
| `toJSON()` | 序列化为 `{name, path, kind}` |

### 目录方法（PublicDirHandle + DirHandle）

| 方法 | 说明 |
|------|------|
| `get(name, options?)` | 获取子项，`options.create` 可为 `"file"`/`"dir"` |
| `_getByMultiPath(name, options)` | 多级路径获取（自动创建中间目录） |
| `length()` | 子项数量 |
| `keys()` / `entries()` / `values()` | 异步迭代器 |
| `forEach(fn)` / `some(fn)` | 遍历 |
| `flat()` | 递归获取所有子孙文件句柄 |

### 文件方法（PublicFileHandle + FileHandle）

| 方法 | 说明 |
|------|------|
| `read({type, start, end})` | 底层读取，type: `text`/`file`/`buffer` |
| `text()` / `file()` / `buffer()` | 便捷读取 |
| `json()` | 读取并 JSON.parse |
| `base64()` | 读取为 DataURL |
| `write(data, options?)` | 写入（Safari 降级到 Worker） |
| `lastModified()` | 最后修改时间戳 |

## 五、关键实现细节

### 1. 路径系统与 RESET_PATH

- `PublicBaseHandle.path` 默认递归拼接 `parent.path + "/" + name`。
- 挂载目录通过 `RESET_PATH` Symbol 覆盖路径为 `$mount-{id}>{encodeURI(name)}`，使挂载句柄的路径与 OPFS 路径解耦。
- 远端用户路径格式：`$user-{userId}:{rootName}/sub/path`，在 `main.js` 中解析后交给 `fs-remote/main.js`。

### 2. 挂载机制（handle/mount/）

- `open()` 调用 `window.showDirectoryPicker()` 获取真实目录句柄。
- `mount()` 通过 `saveHandle()` 将原生 `FileSystemHandle` 存入 IndexedDB（`handles-db` 数据库，`handles` store，keyPath 为 `id`）。
- ID 生成：先生成候选 id `{kind}-{Date.now()}`，再遍历已有句柄用 `isSameEntry` 去重 —— 找到相同项则复用已有 id，没找到才使用候选 id；`saveHandle` 写入时会附带 `time: Date.now()` 字段。
- `get("$mount-xxx>name/path")` 从 IndexedDB 加载句柄，重建 DirHandle 并设置 `RESET_PATH`；**每次 `get` 都会调用 `checkPermission(_handle)`**（readwrite 模式）。
- Safari 不支持在 IndexedDB 存储 `FileSystemHandle`（`DataCloneError`），会抛出明确错误。
- 所有挂载操作前会 `checkPermission`（`queryPermission` + `requestPermission`，readwrite 模式）。

### 3. Safari 写入降级（handle/file.js + write-worker.js）

- Safari 不支持 `FileSystemFileHandle.createWritable()`，降级为 Web Worker。
- Worker 内通过 `createSyncAccessHandle()` 同步写入：`truncate(0)` → `write(data, {at:0})` → `flush()` → `close()`。
- Worker 通过 `postMessage` 传递 `{path, content}`，path 用于在 Worker 内**逐级 `getDirectoryHandle` + 末段 `getFileHandle`** 重新定位 OPFS 文件（因此 **Worker 仅适用于 OPFS 系统路径，对挂载路径 `$mount-xxx>name` 无效**——这是已知限制）。
- 主线程会把 Blob 通过 `await data.arrayBuffer()` 转成 ArrayBuffer 后发给 Worker；Worker 内部对 string 类型 content 会用 `new TextEncoder().encode(content)` 编码。
- 主线程 `worker.onmessage` 收到成功消息后通过 `setTimeout(resolve, 1)` 延时 resolve，否则文件会丢失（已知 BUG）；成功后调用 `notify({path, type:"write", data, remark})`，失败则 `reject(error)` 并 `worker.terminate()`。

### 4. 观察者系统（public/base.js）

- 优先使用实验性 `FileSystemObserver` API（监听 `disappeared`→remove、`modified`→write）。
- 降级为自定义观察者：`observers` Set 存储 `{func, handle}`，`notify()` 遍历并匹配路径前缀触发回调。
- `notify()` 同时通过 `BroadcastChannel` 跨标签页广播（`isCast` 参数避免循环广播）。
- 回调签名：`func({type: "remove"|"write", path, ...others})`。**注意**：源码中 `appeared → "create"` 的分支被注释，自定义 `notify()` 只会发出 `remove` 与 `write` 两种类型。
- **已知设计缺陷**：观察者路径匹配使用 `path.includes(observer.handle.path)` **子串匹配**（非前缀匹配），存在 `/foo` 误匹配 `/foobar/x` 的边界情况。

### 5. 目录 get 的冲突处理（handle/dir.js）

- 先尝试 `getFileHandle`，再尝试 `getDirectoryHandle`，检测同名冲突。
- `create` 参数与已存在句柄类型不符时抛错（如 `create:"file"` 但存在同名目录）。
- 不存在且未指定 `create` 时返回 `null`（非抛错）。

### 6. 下载（download.js）

- 文件：`URL.createObjectURL` + `<a download>` 触发下载。
- 目录：`flat()` 获取所有文件，单个直接下载，多个用 `../util/zip.js` 打包为 zip。

## 六、依赖关系

- `../util/zip.js` — 目录下载打包
- `../util/hash/get-hash.js` — `id()` 的路径哈希降级方案
- `/packages/user/main.js` — **运行时 URL**（由 Service Worker 映射到本仓库 `nos/user/main.js`），动态导入用于远端用户目录
- `./fs-remote/main.js` — **运行时动态加载的远端 FS 模块，本仓库内未提供源码**，需通过 Service Worker 或外部包解析；期望导出 `createGet({remoteUser})`，返回 `remoteGet(path, options)` 句柄获取函数
- 浏览器 API：`Worker`（Safari 写入降级）、`BroadcastChannel`（跨标签页同步）、`IndexedDB`（挂载句柄持久化）、`showDirectoryPicker`、实验性 `FileSystemObserver`

## 七、浏览器兼容性

| 特性 | Chrome 102+ | Firefox 111+ | Safari |
|------|-----------|-------------|--------|
| OPFS 虚拟文件系统（`navigator.storage.getDirectory`） | ✅ | ✅ | ✅ |
| `createWritable` 写入 | ✅ | ✅（仅 OPFS） | ❌（降级 Worker，**且 Worker 不支持挂载路径**） |
| 本地目录挂载（`showDirectoryPicker`） | ✅（Chrome 86+） | ❌（默认禁用） | ❌ |
| IndexedDB 持久化 FileSystemHandle | ✅ | ❌（DataCloneError） | ❌（DataCloneError） |
| `FileSystemObserver` | 实验性 | ❌ | ❌ |
