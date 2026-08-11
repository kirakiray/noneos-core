# storage 存储模块

`storage` 是 NoneOS Core 官方的异步键值存储模块，提供类似 `localStorage` 的接口，底层基于 IndexedDB，容量远大于 localStorage，支持复杂数据类型与跨标签页同步。

**涉及本地数据持久化时，应优先使用本模块，而非原生 `localStorage`。**

## 加载

```javascript
import { storage, getStorage, deleteStorage, NosStorage } from "/nos/storage/main.js";
```

## 快速开始

```javascript
import { storage } from "/nos/storage/main.js";

// 存储（支持对象、数组、Date、Blob 等复杂类型）
await storage.setItem("user-settings", { theme: "dark", language: "cn" });

// 读取（键不存在返回 null）
const settings = await storage.getItem("user-settings");

// 删除
await storage.removeItem("user-settings");
```

## 独立存储空间

不同业务应使用独立的存储空间，避免键名冲突。每个 id 对应一份完全隔离的数据：

```javascript
import { getStorage } from "/nos/storage/main.js";

const appStore = getStorage("my-app");
const cacheStore = getStorage("my-app-cache");

await appStore.setItem("token", "abc");
await cacheStore.setItem("token", "xyz"); // 互不影响
```

`getStorage(id)` 对同一 id 返回**同一个实例**，可在多处放心调用，不会重复建立连接。

> 推荐用 `getStorage(id)` 而非 `new NosStorage(id)`。直接 `new` 会为同一 id 建立重复的数据库连接与广播通道。

默认导出的 `storage` 等价于 `getStorage("public")`。

## API

### setItem(key, value)

存储数据，返回 `Promise<true>`。

```javascript
await storage.setItem("myKey", { name: "John", age: 30 });
```

### getItem(key)

读取数据，返回 `Promise<any>`；键不存在时返回 `null`。

```javascript
const data = await storage.getItem("myKey");
```

### has(key)

判断键是否存在，返回 `Promise<boolean>`。

不读取值，因此比 `getItem` 更快，且能区分「值本身就是 null」与「键不存在」：

```javascript
await storage.setItem("k", null);

await storage.has("k");         // true
await storage.has("not-exist"); // false
await storage.getItem("k");     // null（无法区分两种情况）
```

### removeItem(key)

删除数据，返回 `Promise<true>`。

### clear()

清空当前存储空间的所有数据，返回 `Promise<true>`。

### key(index)

按索引获取键名，返回 `Promise<string | undefined>`，越界返回 `undefined`。

### length

键值对数量。**这是异步属性，必须 await**：

```javascript
const count = await storage.length;
```

### entries() / keys() / values()

异步生成器，用于遍历。内部分批读取（每批 50 条），适合大数据量：

```javascript
for await (const [key, value] of storage.entries()) {
  console.log(key, value);
}

for await (const key of storage.keys()) {
  console.log(key);
}
```

> 只需要键名时用 `keys()`，它走键游标不读取值，比 `entries()` 快得多。

### close()

关闭数据库连接与广播通道。关闭后实例**仍可继续使用**，下次操作会自动重新连接。

### deleteStorage(id)

删除指定 id 的整个数据库（会先关闭该 id 下所有活跃实例）：

```javascript
import { deleteStorage } from "/nos/storage/main.js";

await deleteStorage("my-app-cache");
```

## 代理语法

支持像普通对象一样直接读写：

```javascript
// 写入
storage.myKey = { name: "John" };

// 读取（返回 Promise）
const data = await storage.myKey;

// 删除
delete storage.myKey;
```

⚠️ **代理语法中的错误会被静默忽略**，且写入是异步的（赋值后不保证立即落库）。需要错误处理或确定时序时，请使用方法调用：

```javascript
try {
  await storage.setItem("key", value);
} catch (error) {
  console.error("保存失败:", error);
}
```

## 存储 nos/fs 句柄

本模块可直接存储 `nos/fs` 的文件/目录句柄，读取时自动还原为可用的句柄实例：

```javascript
import { storage } from "/nos/storage/main.js";
import { init } from "/nos/fs/main.js";

const root = await init("my-app");
const file = await root.get("data.txt", { create: "file" });

// 直接存句柄
await storage.setItem("last-opened", file);

// 读回来仍是句柄实例，方法可直接调用
const handle = await storage.getItem("last-opened");
console.log(await handle.text());
```

句柄也可以嵌在对象、数组等结构中，会被递归处理：

```javascript
await storage.setItem("project", {
  title: "demo",
  entry: file,
  files: [file1, file2],
  meta: { nested: { handle: file3 } },
});

const project = await storage.getItem("project");
await project.entry.text();            // 可用
await project.files[0].text();         // 可用
await project.meta.nested.handle.text(); // 可用
```

### 实现方式与注意事项

句柄以**路径引用**形式存储（记录 `path` 与 `kind`），读取时通过 `fs.get(path)` 重新获取。因此：

- ⚠️ **`open()` 打开的本地目录必须先 `mount()`** 才能存储。未挂载的句柄 `path` 只是光秃秃的目录名，无法还原，`setItem` 会直接抛错：

  ```javascript
  import { open, mount } from "/nos/fs/main.js";
  import { storage } from "/nos/storage/main.js";

  const handle = await open();
  await storage.setItem("ws", handle);
  // ❌ Error: nos-storage: cannot store fs handle "MyFolder" — it comes from
  //    open() and is not mounted yet. Call mount(handle) first...

  await mount(handle);                 // 或 open({ mount: true })
  await storage.setItem("ws", handle); // ✅ 挂载后 path 变为 $mount-xxx>MyFolder
  ```

  该限制同样作用于**子孙句柄** —— 从未挂载目录往下 `get("sub/f.txt")` 得到的句柄也会被拒绝。

  挂载后的句柄可跨会话还原。注意 `mount()` 依赖 IndexedDB 持久化 `FileSystemHandle`，**仅 Chrome 支持**。

- ⚠️ **存储的是路径而非文件内容**。若目标文件/目录之后被删除或移动，读取会抛出错误：

  ```javascript
  try {
    const handle = await storage.getItem("last-opened");
  } catch (err) {
    // nos-storage: fs handle "my-app/data.txt" no longer exists
  }
  ```

  需要判断有效性时用 try-catch 包裹，或改存路径字符串自行处理。

- `keys()` 不读取值，因此即使句柄已失效也能正常列出键名。

- ⚠️ **句柄只在普通对象与数组中被识别**。放在 `Map`、`Set` 或自定义类实例内部的句柄**不会被转换**，读回来是丢失原型的空对象（静默失效，不报错）：

  ```javascript
  // ✅ 正常：普通对象、数组及其嵌套
  await storage.setItem("ok", { h: file, list: [file] });

  // ❌ 失效：Map / Set / 类实例内部的句柄
  await storage.setItem("bad", new Map([["h", file]]));
  const m = await storage.getItem("bad");
  m.get("h").text; // undefined —— 已退化为空对象
  ```

  需要在这类容器中保存句柄时，请改存 `handle.path` 字符串，读取后自行 `fs.get(path)`。

## 跨标签页同步

数据变化会通过 `BroadcastChannel` 自动同步到其他标签页，并在 `window` 上派发 `nos-storage-change` 事件：

```javascript
window.addEventListener("nos-storage-change", (e) => {
  const { key, oldValue, newValue, storageId } = e.detail;
  console.log(`[${storageId}] ${key}: ${oldValue} -> ${newValue}`);
});
```

**事件 detail 结构**：

| 字段 | 说明 |
|------|------|
| `key` | 变更的键名；`clear()` 时为 `null` |
| `oldValue` | 旧值；键原本不存在时为 `null` |
| `newValue` | 新值；`removeItem` / `clear` 时为 `null` |
| `storageId` | 发生变更的存储空间 id |

触发场景：`setItem`、`removeItem`、`clear`，以及其他标签页的数据变化。

> 需要区分存储空间时，请判断 `e.detail.storageId`，否则会收到所有存储空间的事件。

## 支持的数据类型

支持所有可结构化克隆的类型：

- **基本类型**：String、Number、Boolean、null、undefined
- **日期**：Date
- **二进制**：ArrayBuffer、TypedArray、Blob、File
- **集合**：Array、Object（可嵌套）、Map、Set
- **NoneOS 扩展**：`nos/fs` 文件/目录句柄（见上文）

**不支持**：函数、DOM 节点、Symbol 等不可序列化的值。

## 性能建议

- 遍历大量数据用 `entries()`，不要在循环中反复 `getItem()`
- 只需键名时用 `keys()`，避免读取和还原值
- 只需判断存在性时用 `has()`，而非 `getItem() !== null`
- 每次操作是独立事务，批量写入量大时注意性能开销

```javascript
// 推荐：一次遍历取全部
const all = {};
for await (const [key, value] of storage.entries()) {
  all[key] = value;
}

// 避免：循环中多次 getItem，会创建大量独立事务
for (let i = 0; i < 100; i++) {
  await storage.getItem(`item-${i}`);
}
```

## 浏览器兼容性

| 特性 | Chrome | Firefox | Edge | Safari |
|------|--------|---------|------|--------|
| IndexedDB | 23+ | 10+ | 12+ | 10+ |
| BroadcastChannel | 54+ | 38+ | 79+ | 15.4+ |

不支持 BroadcastChannel 时，跨标签页同步不可用，但存储功能正常。

## 相关 API 一览

| API | 说明 |
|-----|------|
| `storage` | 默认实例，等价 `getStorage("public")` |
| `getStorage(id)` | 获取指定 id 的实例，同 id 复用 |
| `deleteStorage(id)` | 删除指定 id 的整个数据库 |
| `NosStorage` | 存储类，一般无需直接使用 |
| `setItem(key, value)` | 存储数据 |
| `getItem(key)` | 读取数据，不存在返回 `null` |
| `has(key)` | 键是否存在 |
| `removeItem(key)` | 删除数据 |
| `clear()` | 清空当前存储空间 |
| `key(index)` | 按索引取键名 |
| `length` | 数量（异步属性，需 await） |
| `entries()` / `keys()` / `values()` | 异步遍历 |
| `close()` | 关闭连接（之后仍可继续使用） |
| `id` | 当前实例的存储标识符 |
