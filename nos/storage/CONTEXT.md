# nos/storage 存储模块上下文

> 本文档供 AI 阅读，用于快速理解 `nos/storage` 模块的整体架构与实现细节，无需逐文件阅读源码即可进行代码更新。

## 一、整体架构

`nos/storage` 是 NoneOS 官方的异步键值存储模块，提供类 localStorage 的 API，底层基于 **IndexedDB**，容量远大于 localStorage 且支持复杂数据类型。

### 核心设计

1. **一个 id 一个数据库**：每个存储 id 对应独立的 IndexedDB 数据库 `nos-storage-${id}`，各自独立事务队列与连接，互不阻塞；`clear()` / `count()` 可直接用 store 原生能力，无需 range 过滤。
2. **Proxy 代理语法**：`storage.key = value` / `await storage.key` / `delete storage.key`，无需调用方法。Proxy 陷阱对 symbol 走 `Reflect`，避免内部私有字段被误当作存储项。
3. **实例复用**：`getStorage(id)` 按 id 缓存实例，避免同页面重复开库与重复派发事件。
4. **nos/fs 句柄支持**：句柄实例无法结构化克隆（状态在私有字段中），写入时自动转为路径引用，读取时自动还原为句柄实例。
5. **跨标签页同步**：通过 `BroadcastChannel` 广播变更，转成 window 上的 `nos-storage-change` 事件。
6. **连接自愈**：连接被关闭后，下次操作自动重开（不依赖 `db.onclose`，见下文）。

## 二、模块地图

```
nos/storage/
├── main.js       # 全部实现：NosStorage 类 + getStorage/deleteStorage/storage
├── README.md     # API 文档（人类阅读）
└── CONTEXT.md    # 本文档
```

模块无内部依赖；仅在**读取到句柄引用时**动态 `import("../fs/main.js")`。

## 三、IndexedDB 结构

| 项 | 值 |
|----|-----|
| 数据库名 | `nos-storage-${id}`（`DB_PREFIX = "nos-storage-"`） |
| 版本 | `1`（固定，`DB_VERSION`） |
| ObjectStore | `main`（`STORE_NAME`），`keyPath: "key"` |
| 记录结构 | `{ key: string, value: any }` |

默认实例 id 为 `"public"`，即数据库 `nos-storage-public`。

### 支持的值类型

值直接交给 IndexedDB 的结构化克隆算法，因此支持范围即「可结构化克隆的类型」，唯一例外是 nos/fs 句柄（模块自行转换）。

| 类型 | 支持 | 处理方 |
|------|------|--------|
| String / Number / Boolean / null / undefined | ✅ | 结构化克隆 |
| Date | ✅ | 结构化克隆 |
| ArrayBuffer / TypedArray / DataView | ✅ | 结构化克隆 |
| Blob / File | ✅ | 结构化克隆 |
| Array / 普通 Object（可嵌套） | ✅ | 结构化克隆；`toStorable` 会递归进入以查找句柄 |
| Map / Set | ✅ | 结构化克隆；`toStorable` **不递归进入**，内部的句柄不会被转换 |
| RegExp | ✅ | 结构化克隆 |
| `nos/fs` 文件/目录句柄 | ✅ | 模块转为路径引用，见第五节第 2 条 |
| 类实例（自定义 class） | ⚠️ | 可存但**丢原型与私有字段**，读回来是普通对象 |
| Function / DOM 节点 / Symbol / WeakMap / WeakSet | ❌ | 抛 `DataCloneError` |

**`toStorable` 的递归边界**：仅当 `Array.isArray(value)` 或 `value.constructor === Object` 时向内递归。因此：

- 句柄放在数组、普通对象、以及两者的任意嵌套中 → 正常转换
- 句柄放在 `Map` / `Set` / 类实例内部 → **不会被转换**，会以类实例形态进入结构化克隆，结果是丢失原型的空对象（静默失效，非报错）

这是当前实现的已知限制。若后续需要支持，应扩展 `toStorable` / `fromStorable` 的类型分支，并同步更新 README.md 与 `skills/noneos-core-docs/references/storage.md`。

## 四、关键 API

### 导出

| 导出 | 说明 |
|------|------|
| `NosStorage` | 存储类，`new NosStorage(id)`。**推荐用 `getStorage()` 代替**，直接 new 会为同一 id 建重复连接与广播通道 |
| `getStorage(id = "public")` | 获取实例，同 id 复用 |
| `deleteStorage(id)` | 关闭该 id 下**所有活跃实例**后删除整个数据库 |
| `storage` | 默认实例，等价 `getStorage("public")` |

### NosStorage 实例方法

| 方法/属性 | 说明 |
|-----------|------|
| `id` | 只读，当前实例的存储标识符 |
| `setItem(key, value)` | 存储，返回 `Promise<true>`。先同步校验句柄来源（拒绝未 mount 的 `open()` 句柄），再读旧值、写入、派发变更事件；句柄自动转路径引用 |
| `getItem(key)` | 读取，返回 `Promise<any>`，键不存在返回 `null`；路径引用自动还原为句柄 |
| `has(key)` | 键是否存在，返回 `Promise<boolean>`。用 `count(key)` 实现，不读值，可区分"值为 null"与"键不存在" |
| `removeItem(key)` | 删除，返回 `Promise<true>` |
| `clear()` | 清空当前存储空间，返回 `Promise<true>`；事件中 key/oldValue/newValue 均为 null |
| `key(index)` | 按索引取键名，返回 `Promise<string \| undefined>`，越界返回 `undefined` |
| `length` | **异步属性**，返回 `Promise<number>`，必须 await |
| `entries()` | 异步生成器，yield `[key, value]`，每批 50 条；句柄会还原 |
| `keys()` | 异步生成器，yield 键名。**走键游标**，不读值不还原句柄 |
| `values()` | 异步生成器，yield 值；基于 `entries()`，句柄会还原 |
| `close()` | 关闭连接与广播通道。**关闭后实例仍可用**，下次操作自动重开 |

### 私有方法

| 方法 | 说明 |
|------|------|
| `_openDB(id)` | 打开数据库，`onupgradeneeded` 建 store，`onblocked` reject |
| `_initBC(id)` | 建广播通道；先 `close()` 旧通道，防重连时通道累积导致事件重复 |
| `_withStore(mode, cb, retried)` | 事务封装 + 连接自愈重试（见下文） |
| `_mutateItem(key, actionFn, newValue)` | 写操作通用流程：读旧值 → 执行 → 还原旧值 → 派发事件 → resolve |
| `_emitChange(key, oldValue, newValue, oldRaw)` | 派发 window 事件 + 跨标签页广播 |

### 模块级工具函数

| 函数 | 说明 |
|------|------|
| `isFsHandle(value)` | 鸭子类型判定是否为 nos/fs 句柄 |
| `collectHandles(value)` | 递归收集值中所有句柄，递归边界与 `toStorable` 一致 |
| `assertHandlesStorable(value)` | 同步校验，拒绝未 mount 的 `open()` 句柄（查 `FS_PICKED` 标记） |
| `toStorable(value)` | 递归把句柄转为路径引用 |
| `fromStorable(value)` | 递归把路径引用还原为句柄 |

## 五、关键实现细节

### 1. 连接自愈（重要）

**`db.onclose` 按规范只在异常终止时触发**（浏览器强制回收、存储被清理），显式 `db.close()` **不触发**。因此仅靠 `onclose` 重连是不可靠的 —— 显式关闭后 `this[IDB]` 会一直缓存已关闭的连接，下次 `transaction()` 抛 `InvalidStateError`。

本模块采用双保险：

- `db.onclose` 仍保留，负责异常终止场景的提前重连；
- `_withStore()` 在**建事务时** try/catch，捕获 `InvalidStateError` 后重开连接（同时 `_initBC` 重建广播通道）并重试一次，用 `retried` 标志防无限递归。

`entries()` / `keys()` 均通过 `_withStore()` 建事务，因此同样受自愈保护。**不要在这两个方法中直接 `await this[IDB]` 后自行 `db.transaction()`**，那样会绕过自愈逻辑。

### 2. nos/fs 句柄的序列化

句柄状态保存在私有字段（`#originHandle` / `#parent` / `#root`）中，结构化克隆会丢弃私有字段与原型 —— 直接存入会**静默变成 `{}`**。

存原生 `FileSystemHandle` 亦不可行：Chrome 可克隆，但 Firefox/Safari 抛 `DataCloneError`（见 `nos/fs/handle/mount/db.js`）。

因此采用**路径引用**方案：

| 环节 | 处理 |
|------|------|
| 识别 | `isFsHandle(value)` 用**鸭子类型**（`path` 为 string + `kind` 为 `file`/`dir` + `copyTo` 为函数），而非 `instanceof`，以兼容系统句柄、挂载句柄与远端句柄，且无需导入 fs 模块 |
| 写入前校验 | `assertHandlesStorable()` 用 `collectHandles()` 收集所有句柄，拒绝未 mount 的 `open()` 句柄（见下文） |
| 写入 | `toStorable()` 递归替换为 `{ __nos_fs_handle__: true, path, kind }`（`HANDLE_MARK`） |
| 读取 | `fromStorable()` 递归还原，动态 `import("../fs/main.js")` 后 `get(path)` |
| 边界 | 仅递归普通对象与数组（`constructor === Object` 或 `Array.isArray`），`Date`/`Blob`/`Map`/`Set` 等交给结构化克隆；`WeakMap` 记录防循环引用 |

#### 拒绝未 mount 的 open() 句柄

`open()` 返回的本地目录句柄若未 `mount()`，其 `path` 只是**光秃秃的目录名**（无 parent、无 `RESET_PATH`）。这类路径进入 `fs.get()` 会走 `systemHandleGet` 当作 OPFS 路径处理：

- OPFS 无同名根目录 → 读取时抛「根目录不存在」，错误信息误导
- OPFS **恰好有**同名根目录 → **静默返回完全不同的目录**（更危险）

因此 `nos/fs/public/base.js` 导出 `PICKED` 符号：`open()` 在返回的句柄上置 `handle[PICKED] = true`，`mount()` 成功后 `delete handle[PICKED]`。`setItem` 通过 `assertHandlesStorable()` 检测该标记并抛错。

**关键点**：

1. **子孙句柄靠 `root` 继承判定**。从 `open()` 的目录往下 `get("sub/f.txt")` 得到的子句柄自身没有标记，但 `root` 指向最初那个句柄，因此校验条件是 `handle[PICKED] || handle.root?.[PICKED]`。
2. **`PICKED` 用 `Symbol.for("nos-fs-picked")` 注册为全局符号**。这样 `nos/storage` 只需 `Symbol.for()` 取同一个符号，**无需 import `nos/fs`** —— 否则为读一个常量就会牵连加载整个 fs 模块（`public/base.js` 顶层会创建 `BroadcastChannel`），破坏 storage 的按需加载设计。
3. **校验是同步的**，`setItem` 无需为此变成 async；只在值中含句柄时才有开销（先 `collectHandles` 扫描）。

> 早期曾尝试用 `fs.get(path)` + `isSame()` 验证路径可还原性，已废弃：需要额外 IO，且对 `$mount-` 路径会触发挂载授权弹窗。也验证过 `queryPermission` 与 `path` 形态均无法区分句柄来源（OPFS 句柄同样具备 `queryPermission`，根目录 `path` 也是单段名）。

**已知行为**：目标文件/目录已被删除时，`getItem` 抛 `nos-storage: fs handle "<path>" no longer exists`，而非返回空对象。路径引用方案的固有特性 —— 明确报错优于静默拿到坏对象。

`keys()` 因此刻意不走 `entries()`：不读值即不触发还原，遍历大量句柄时更快，且句柄失效时仍能正常列出键名。

### 3. 变更事件

| 通道 | 内容 |
|------|------|
| window 事件 `nos-storage-change` | `detail: { key, oldValue, newValue, storageId }`，其中句柄为**已还原的实例** |
| BroadcastChannel `nos-storage-${id}` | 只发**路径引用**（`toStorable` 后的形态）—— 句柄实例过不了 `postMessage` 的结构化克隆 |

`_emitChange` 的第 4 参 `oldRaw` 用于传入旧值的可克隆形态；缺省时对 `oldValue` 现场 `toStorable`。

`_mutateItem` 中 `resolve(true)` 排在事件派发**之后**，保证 `await setItem()` 返回时事件已触发（时序确定，测试可依赖）。

事件触发场景：`setItem`、`removeItem`、`clear`、跨标签页数据变化。

### 4. 实例缓存的两级结构

| 容器 | 用途 |
|------|------|
| `instances: Map<id, NosStorage>` | `getStorage()` 的复用缓存，一个 id 只存一个 |
| `liveInstances: Map<id, Set<NosStorage>>` | 登记该 id 下**所有**活跃实例（含直接 `new` 的） |

`deleteStorage(id)` 必须关闭 `liveInstances` 中的全部实例，否则残留连接会导致 `deleteDatabase` 迟迟无法完成。

`deleteDatabase` 的 `onblocked` **只警告不 reject**。按规范 `blocked` 表示删除被延后而非失败 —— 待其余连接关闭后仍会走 `onsuccess`。WebKit 的 `db.close()` 在后端异步生效，紧随其后的 `deleteDatabase` 必然先触发一次 `blocked`（Chrome 关得快才不暴露）。**不要把它改回 reject**，那会让 Safari/WebKit 下的每次 `deleteStorage` 都失败。

职责划分：`close()` 只管连接与通道，**不动缓存**；缓存增删归 `getStorage` / `deleteStorage`。

### 5. Proxy 陷阱

| 陷阱 | 行为 |
|------|------|
| `get` | key 在实例上、为 symbol、或为 `"then"` 时走 `Reflect`；否则 `getItem(key)` |
| `set` | **symbol 走 `Reflect`**；否则 `setItem` 并静默 catch |
| `deleteProperty` | **symbol 走 `Reflect`**；否则 `removeItem` 并静默 catch |

symbol 放行是必须的：重连时 `this[IDB] = this._openDB(id)` 若被当作 `setItem` 处理，重连将失效。

`"then"` 放行是为了避免实例被误当作 thenable 而在 `await` 时挂起。

代理语法中错误被**静默忽略**，需要错误处理时改用方法调用。

## 六、注意事项

- 所有操作基于 Promise，必须 `await` 或 `.then()`
- `length` 是异步属性，必须 await
- 浏览器需支持 IndexedDB；BroadcastChannel 缺失时跨标签页同步不可用，但存储功能正常
- 值类型支持范围与 `toStorable` 的递归边界见第三节「支持的值类型」
- 每次操作为独立事务，批量写入量大时注意性能

## 七、浏览器兼容性

| 特性 | Chrome | Firefox | Edge | Safari |
|------|--------|---------|------|--------|
| IndexedDB | 23+ | 10+ | 12+ | 10+ |
| BroadcastChannel | 54+ | 38+ | 79+ | 15.4+ |

## 八、测试

`tests/storage/storage.sb.html`（16 个用例）覆盖：基础读写、Proxy 语法、`has` 边界、删除/清空/length、`key` 索引、跨批次遍历 120 条、实例复用与隔离、变更事件、连接关闭后自愈、复杂数据类型、`deleteStorage`，以及 nos/fs 句柄的存取（文件/目录、嵌套结构与数组、遍历与文件已删除、Map/Set 内句柄的已知限制、拒绝未 mount 的 open 句柄）。

句柄用例共用测试根目录 `storage-test`，各用例在其下建独立子目录（`handle-basic` / `handle-nested` / `handle-missing` / `handle-limit` / `handle-picked`），清理时删子目录。**不要直接对 OPFS 根目录调用 `handle.remove()`** —— 根目录没有 parent，`remove()` 内部访问 `this.parent.#originHandle` 会抛错。

`PICKED` 用例通过 `new DirHandle(nativeHandle)` + 手动置 `[PICKED] = true` 模拟 `open()` 的返回（避免真实弹窗），并覆盖目录自身、子孙句柄、嵌套结构三种拒绝场景，以及真实 `mount()` 后可正常存储。**模拟时必须走真实 `mount()`**，不能只 `delete handle[PICKED]` —— 那样 `RESET_PATH` 未设置，`path` 仍不可还原，读取会失败。

该用例的 mount 部分在 Safari/WebKit 下跳过（`isSafari` 判定）：`mount()` 依赖把 `FileSystemHandle` 存入 IndexedDB，Safari 会抛 `DataCloneError`。前三步拒绝校验与浏览器无关，照常执行。

运行：`npx sb-test -f tests/storage/storage.sb.html --browsers chrome`（需先 `npm start`）。已在 chrome / firefox / webkit 三端验证 16/16 通过。
