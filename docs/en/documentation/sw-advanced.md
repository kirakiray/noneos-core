# sw.js Configuration Tips

## Version Number Control and Cache Update

When releasing a new version, if the server is configured with a `max-age=0` response header, the browser may still cache the old version of the `sw.js` file, preventing updates from taking effect promptly. By adding a version parameter to the URL, you can force the browser to request the latest file, thereby resolving this issue.

```javascript
let version = "";
if (globalThis.serviceWorker) {
  const urlParams = new URLSearchParams(
    new URL(serviceWorker.scriptURL).search,
  );
  version = urlParams.get("v") || "";
} else {
  const urlParams = new URLSearchParams(new URL(location.href).search);
  version = urlParams.get("v") || "";
}

importScripts("https://core.noneos.com/sw/dist.js?v=" + version);
```

When referencing dist.js, add the `?v=` parameter and update the version number each time a new version is released. The browser will then request the new file instead of using the cached one.

## Official Tools

Using the tools in the `nos-tool` directory, you can conveniently manage the NoneOS system.

- **ai** - AI model management, including chat, configuration, and key management
- **editor** - Monaco editor integration, supporting syntax highlighting, formatting, and AI completion
- **file-explore** - File explorer
- **file-list** - File list view and handle management
- **studio** - Development studio, providing file management, color tools, theme editing, and more

These tools are located in the `nos-tool` directory and can be imported and used as needed.