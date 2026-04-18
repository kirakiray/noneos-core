# 安装

NoneOS Core 是一个基于浏览器的文件系统，需要通过 Service Worker 实现本地存储。项目本身是纯静态的，不需要动态服务器。

## 前提条件

- 一个静态服务器（如 http-server、live-server、nginx 等）
- 浏览器支持 Service Worker
- 如果是外网访问，必须使用 HTTPS（因为 API 需求）

## 步骤

### 1. 创建 Service Worker 文件

在项目根目录下创建 `sw.js` 文件，填入以下内容：

```javascript
importScripts("https://core.noneos.com/sw/dist.js");
```

### 2. 创建入口 HTML

在入口 HTML 文件中引入 `ofa.js` 和 `nos-version` 组件。使用 `nos-version` 组件后，会自动注册 `sw.js` 文件：

```html
<!DOCTYPE html>
<html lang="zh">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>My App</title>
    <script src="https://cdn.jsdelivr.net/gh/ofajs/ofa.js/dist/ofa.js"></script>
  </head>
  <body>
    <!-- 加载 nos-version 组件 -->
    <l-m src="https://core.noneos.com/nos-tool/comps/nos-version.html"></l-m>
    <!-- 使用 nos-version 组件 -->
    <nos-version auto-install></nos-version>

    <script type="module">
      // 等待安装完成
      $("nos-version").on("installed", () => {
        console.log("NoneOS Core 安装完成，可以开始使用了");
        // 这里可以使用 noneos-core
      });
    </script>
  </body>
</html>
```

## 安装状态

`nos-version` 组件会自动检测 NoneOS Core 的安装状态：

- **未安装**：显示 "Install NoneOS Core" 按钮
- **安装中**：显示安装进度条
- **已安装**：显示当前版本号
- **可升级**：显示升级按钮

当系统安装完成、或已安装过、或升级成功时，会触发 `installed` 事件，之后就可以正常使用 NoneOS Core 的所有功能了。