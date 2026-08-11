# sw.js configuration tips

## Version Number Control and Cache Update

When releasing a new version, if the server is configured with a `max-age=0` response header, the browser may still cache the old version of the `sw.js` file, causing the update to not take effect in a timely manner. By adding a version parameter to the URL, you can force the browser to request the latest file, thus solving this problem.

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

When referencing dist.js, add the `?v=` parameter and update the version number each time a new version is released, so that the browser will request the new file instead of using the cache.

## Official Tools

Using `nos-tool` directorytools,caneasilymanage NoneOS system.

- **editor** - Monaco editor integration, supporting code highlighting, formatting, and AI completion
- **file-explore** - File explorer
- **file-list** - File list view and handle management
- **studio** - Development studio, providing file management, color tools, theme editing, and other features

These tools are located in the `nos-tool` directory and can be imported and used as needed.