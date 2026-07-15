# ncomp 公共组件目录上下文

> 本文档供 AI 阅读，用于快速理解 `ncomp` 目录的用途、组件规范及使用方式。

## 一、目录定位

`ncomp`（NoneOS Components）是 NoneOS Core 的公共组件目录，存放与 `nos` 能力直接相关的可复用 UI 组件。基于 `nos` 的上层项目可以通过 `/ncomp/{component}/{component}.html` 路径直接引用这些组件。

## 二、目录结构

```
ncomp/
├── CONTEXT.md                  # 本文档
└── user-name/
    ├── user-name.html          # 组件实现
    └── user-name.sb.html       # sibyl-test 测试用例
```

## 三、现有组件

### `user-name`

- **路径**：`ncomp/user-name/user-name.html`
- **标签**：`<user-name>`
- **依赖**：`/nos/user/main.js`
- **功能**：根据 `user-id` 显示对应用户的用户名。
  - 若本地用户就是自己，直接读取 `user.getInfo().username`。
  - 否则读取本地名片缓存 `user.card.get(uid)` 中的 `username`。
  - 当设置 `force` 属性时，会尝试主动连接目标用户并刷新名片缓存，再显示最新名称。
- **属性**：
  - `user-id`：目标用户 ID。
  - `force`：存在时强制触发在线名片刷新。
  - `namespace`：指定用户命名空间，默认为 `"default"`。
- **回退行为**：名片获取失败时保持显示 `user-id`。

## 四、使用方式

在 ofa.js 页面中通过 `l-m` 引用：

```html
<l-m src="/ncomp/user-name/user-name.html"></l-m>
<user-name user-id="{targetUserId}"></user-name>
```

## 五、资源加载与缓存

`/ncomp/` 下的资源由 Service Worker（`sw/src/modules/ncomp-handle.js`）统一代理：

- **`localhost:3002`**：直接请求本地调试服务器，不写入 OPFS 缓存。
- **其他 `localhost:*`**：优先代理到 `localhost:3002`；成功后写入 OPFS `/ncomp/` 缓存；3002 不可用时回退 OPFS 缓存，再未命中则请求官方源。
- **非本地环境**：优先读取 OPFS `/ncomp/` 缓存；未命中时请求 `https://core.noneos.com/` 对应路径，成功后写入缓存。

因此，组件文件首次被请求后会自动缓存到 OPFS，后续访问可离线使用。

## 六、开发规范

1. 每个组件独占一个子目录，目录名与组件标签名保持一致。
2. 组件入口文件命名为 `{tag-name}.html`。
3. 建议为每个组件编写同名的 `{tag-name}.sb.html` 测试文件，使用 `sibyl-test` 框架验证。
4. 组件内部引用 `nos` 能力时，使用绝对路径 `/nos/...`，确保在不同项目中路径一致。
5. 新增或修改组件后，若 Service Worker 路由或缓存策略有变化，需同步更新 `sw/CONTEXT.md`。
