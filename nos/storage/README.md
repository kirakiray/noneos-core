# nos/storage 存储模块

> NoneOS Core 官方的异步键值存储模块，基于 IndexedDB，提供类 `localStorage` 的接口。

涉及本地数据持久化时，应优先使用本模块，而非原生 `localStorage`。

## 特性

- **类 localStorage 接口**：`setItem` / `getItem` / `removeItem` / `clear` / `key` / `length`，迁移成本低
- **大容量 + 复杂类型**：基于 IndexedDB，可存 Object、Array、Date、Blob、Map、Set 等所有可结构化克隆的值
- **代理语法**：支持 `storage.key = value` / `await storage.key` / `delete storage.key`
- **独立存储空间**：每个 id 对应独立的 IndexedDB 数据库，互不阻塞；同 id 自动复用实例
- **nos/fs 句柄支持**：可直接存取文件/目录句柄，读回来仍是可用的句柄实例
- **跨标签页同步**：通过 BroadcastChannel 自动广播变更
- **连接自愈**：连接被关闭后，下次操作自动重连

## 快速开始

```js
import { storage } from "/nos/storage/main.js";

// 存储
await storage.setItem("user-settings", { theme: "dark", language: "cn" });

// 读取（键不存在返回 null）
const settings = await storage.getItem("user-settings");

// 删除
await storage.removeItem("user-settings");
```

## 独立存储空间

不同业务应使用独立的存储空间，避免键名冲突：

```js
import { getStorage } from "/nos/storage/main.js";

const appStore = getStorage("my-app");
const cacheStore = getStorage("my-app-cache");

await appStore.setItem("token", "abc");
await cacheStore.setItem("token", "xyz"); // 互不影响
```

`getStorage(id)` 对同一 id 返回同一个实例，可在多处放心调用。默认导出的 `storage` 等价于 `getStorage("public")`。

> 推荐用 `getStorage(id)` 而非 `new NosStorage(id)`。直接 `new` 会为同一 id 建立重复的数据库连接与广播通道。

## 导出 API

| 导出 | 说明 |
|------|------|
| `storage` | 默认实例，等价 `getStorage("public")` |
| `getStorage(id?)` | 获取指定 id 的实例，同 id 复用；默认 id 为 `"public"` |
| `deleteStorage(id)` | 删除指定 id 的整个数据库（先关闭该 id 下所有活跃实例） |
| `NosStorage` | 存储类，一般无需直接使用 |

## 实例方法

| 方法/属性 | 返回 | 说明 |
|-----------|------|------|
| `setItem(key, value)` | `Promise<true>` | 存储数据 |
| `getItem(key)` | `Promise<any>` | 读取数据，键不存在返回 `null` |
| `has(key)` | `Promise<boolean>` | 键是否存在，不读取值 |
| `removeItem(key)` | `Promise<true>` | 删除数据 |
| `clear()` | `Promise<true>` | 清空当前存储空间 |
| `key(index)` | `Promise<string \| undefined>` | 按索引取键名，越界返回 `undefined` |
| `length` | `Promise<number>` | 数量，**异步属性，必须 await** |
| `entries()` | 异步生成器 | 遍历 `[key, value]`，每批 50 条 |
| `keys()` | 异步生成器 | 遍历键名，走键游标不读值 |
| `values()` | 异步生成器 | 遍历值 |
| `close()` | `Promise<void>` | 关闭连接，之后仍可继续使用 |
| `id` | `string` | 当前实例的存储标识符 |

### has(key)

不读取值，因此比 `getItem` 更快，且能区分「值本身就是 null」与「键不存在」：

```js
await storage.setItem("k", null);

await storage.has("k");         // true
await storage.has("not-exist"); // false
await storage.getItem("k");     // null（无法区分两种情况）
```

### length

这是异步属性，必须 await：

```js
const count = await storage.length;
```

### 遍历

内部分批读取，适合大数据量：

```js
for await (const [key, value] of storage.entries()) {
  console.log(key, value);
}

for await (const key of storage.keys()) {
  console.log(key);
}
```

> 只需要键名时用 `keys()`，它走键游标不读取值，比 `entries()` 快得多。

## 代理语法

支持像普通对象一样直接读写：

```js
storage.myKey = { name: "John" };   // 写入
const data = await storage.myKey;   // 读取
delete storage.myKey;               // 删除
```

⚠️ 代理语法中的错误会被**静默忽略**，且写入是异步的（赋值后不保证立即落库）。需要错误处理或确定时序时，请使用方法调用：

```js
try {
  await storage.setItem("key", value);
} catch (error) {
  console.error("保存失败:", error);
}
```

## 存储 nos/fs 句柄

可直接存储文件/目录句柄，读取时自动还原为可用的句柄实例：

```js
import { storage } from "/nos/storage/main.js";
import { init } from "/nos/fs/main.js";

const root = await init("my-app");
const file = await root.get("data.txt", { create: "file" });

await storage.setItem("last-opened", file);

const handle = await storage.getItem("last-opened");
console.log(await handle.text()); // 句柄方法可直接调用
```

句柄也可嵌在对象、数组等结构中，会被递归处理：

```js
await storage.setItem("project", {
  title: "demo",
  entry: file1,
  files: [file1, file2],
  meta: { nested: { handle: file3 } },
});

const project = await storage.getItem("project");
await project.entry.text();
await project.files[0].text();
await project.meta.nested.handle.text();
```

### 注意事项

句柄以**路径引用**形式存储（记录 `path` 与 `kind`），读取时通过 `fs.get(path)` 重新获取。因此：

- ⚠️ **`open()` 打开的本地目录必须先 `mount()`** 才能存储。未挂载的句柄 `path` 只是光秃秃的目录名，无法还原，`setItem` 会直接抛错：

  ```js
  import { open, mount } from "/nos/fs/main.js";

  const handle = await open();
  await storage.setItem("ws", handle);
  // ❌ Error: nos-storage: cannot store fs handle "MyFolder" — it comes from
  //    open() and is not mounted yet. Call mount(handle) first...

  await mount(handle);            // 或 open({ mount: true })
  await storage.setItem("ws", handle); // ✅
  ```

  该限制同样作用于**子孙句柄** —— 从未挂载目录往下 `get("sub/f.txt")` 得到的句柄也会被拒绝。

  注意 `mount()` 依赖 IndexedDB 持久化 `FileSystemHandle`，**仅 Chrome 支持**。

- ⚠️ **存储的是路径而非文件内容**。若目标文件/目录之后被删除或移动，读取会抛错：

  ```js
  try {
    const handle = await storage.getItem("last-opened");
  } catch (err) {
    // nos-storage: fs handle "my-app/data.txt" no longer exists
  }
  ```

- `keys()` 不读取值，因此即使句柄已失效也能正常列出键名。

- ⚠️ **句柄只在普通对象与数组中被识别**。放在 `Map`、`Set` 或自定义类实例内部的句柄**不会被转换**，读回来是丢失原型的空对象（静默失效，不报错）：

  ```js
  // ✅ 正常：普通对象、数组及其嵌套
  await storage.setItem("ok", { h: file, list: [file] });

  // ❌ 失效：Map / Set / 类实例内部的句柄
  await storage.setItem("bad", new Map([["h", file]]));
  const m = await storage.getItem("bad");
  m.get("h").text; // undefined —— 已退化为空对象
  ```

## 跨标签页同步

数据变化会自动同步到其他标签页，并在 `window` 上派发 `nos-storage-change` 事件：

```js
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

```js
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

## 存储结构

| 项 | 值 |
|----|-----|
| 数据库名 | `nos-storage-${id}` |
| 版本 | `1` |
| ObjectStore | `main`，`keyPath: "key"` |
| 记录结构 | `{ key: string, value: any }` |

## 浏览器兼容性

| 特性 | Chrome | Firefox | Edge | Safari |
|------|--------|---------|------|--------|
| IndexedDB | 23+ | 10+ | 12+ | 10+ |
| BroadcastChannel | 54+ | 38+ | 79+ | 15.4+ |

不支持 BroadcastChannel 时，跨标签页同步不可用，但存储功能正常。

## 相关文档

- [CONTEXT.md](CONTEXT.md) — 模块架构与实现细节（供 AI 阅读）
- `.agents/skills/noneos-core-docs/references/storage.md` — Skill 知识库文档
- `tests/storage/storage.sb.html` — 测试用例
