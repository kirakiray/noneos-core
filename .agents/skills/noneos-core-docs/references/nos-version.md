# nos-version

NoneOS Core 版本管理组件，用于检测当前安装版本、提示升级、执行安装/升级操作。

## 标签

`<nos-version>`

## 属性 (attrs)

| 属性名 | 默认值 | 说明 |
|--------|--------|------|
| `auto-install` | `null` | 设置时，组件挂载后自动执行安装或升级，无需用户手动点击按钮 |

## 数据 (data)

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `version` | string | `""` | 当前已安装的 NoneOS Core 版本号 |
| `loading` | boolean | `true` | 正在检测版本状态 |
| `installing` | boolean | `false` | 正在执行安装/升级 |
| `installed` | boolean | `false` | 是否已安装 |
| `installDesc` | string | `""` | 当前安装步骤的文字描述 |
| `installStep` | number | `0` | 当前安装进度步数 |
| `installStepTotal` | number | `0` | 安装总步数 |
| `upgradable` | boolean | `false` | 是否存在可升级的新版本 |
| `lastVersion` | string | `""` | 可升级到的线上最新版本号 |

## 方法 (proto)

### installNoneOSCore()

执行安装或升级流程。内部调用 `install()` 并实时更新进度，完成后自动调用 `refreshData()` 刷新状态。

### refreshData()

重新检测版本状态。内部调用 `check()` 获取当前状态，根据结果自动调整 UI：
- `uninstalled` → 显示安装按钮（或触发自动安装）
- `upgradable` → 显示升级按钮（或触发自动升级）
- 正常已安装 → 显示版本号

## 事件 (events)

组件通过 `emit` 触发自定义事件，所有事件默认冒泡（bubbles: true），外部可通过 `on()` 方法监听。

| 事件名 | detail 结构 | 触发时机 |
|--------|-------------|----------|
| `check-start` | 无 | 开始检测版本状态时 |
| `uninstalled` | 无 | 检测到系统未安装时 |
| `upgradable` | `{ data: { version, lastVersion } }` | 检测到可升级到新版本时 |
| `install-start` | 无 | 开始安装/升级时 |
| `install-progress` | `{ data: { step, desc, total } }` | 安装进度更新时 |
| `install-complete` | 无 | 安装/升级完成时 |
| `installed` | `{ data: { version } }` | 确认已安装且版本正常时 |
| `error` | `{ data: { message, phase } }` | check 或 install 过程中发生错误时 |

## 状态机

组件内部状态流转如下：

```
attached
  └→ refreshData() ──→ emit("check-start")
       ├→ state === "uninstalled" ──→ emit("uninstalled")
       │      └→ [autoInstall?] ──→ emit("install-start")
       │                              └→ emit("install-progress") (多次)
       │                                  └→ emit("install-complete")
       │                                      └→ refreshData() (回到起点)
       ├→ state === "upgradable" ──→ emit("upgradable")
       │      └→ [autoInstall?] ──→ (同上安装流程)
       └→ state === "installed" ──→ emit("installed")
```

UI 表现对应关系：
- `loading = true` → spinner 显示
- `installing = true` → 进度条 + 描述文字显示
- `installed = true` → 版本号显示（`upgradable` 时额外显示升级按钮）
- 以上皆否 → 安装按钮显示

## 使用示例

### 基本使用

```html
<nos-version></nos-version>
```

### 自动安装模式

设置 `auto-install` 属性后，组件挂载时会自动检测并执行安装或升级：

```html
<nos-version auto-install></nos-version>
```

### 外部事件监听

通过 `on()` 方法监听组件事件，事件数据通过 `e.detail` 获取：

```html
<nos-version id="nv"></nos-version>
<script>
  $("#nv").on("install-progress", (e) => {
    console.log(e.detail.data); // { step: 2, desc: "downloading", total: 5 }
  });

  $("#nv").on("installed", (e) => {
    console.log("当前版本:", e.detail.data.version);
  });

  $("#nv").on("upgradable", (e) => {
    console.log("可升级:", e.detail.data.version, "→", e.detail.data.lastVersion);
  });

  $("#nv").on("error", (e) => {
    console.error("出错:", e.detail.data.message, "阶段:", e.detail.data.phase);
  });
</script>
```

## 依赖

`../_install/main.js` — 提供 `check()` 和 `install()` 两个异步方法。
