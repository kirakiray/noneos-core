# Installation

NoneOS Core is a browser-based file system that relies on Service Worker for local storage. The project itself is purely static and does not require a dynamic server.

## Prerequisites

- A static server (e.g. http-server, live-server, nginx, etc.)
- Browser support for Service Worker
- For external access, HTTPS must be used (due to API requirements)

## Steps

### 1. Create Service Worker File

Create a `sw.js` file in the project root directory and fill in the following content:

```javascript
importScripts("https://core.noneos.com/sw/dist.js");
```

### 2. Create Entry HTML

In the entry HTML file, import `ofa.js` and the `nos-version` component. After using the `nos-version` component, the `sw.js` file will be automatically registered:

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>My App</title>
    <script src="https://cdn.jsdelivr.net/gh/ofajs/ofa.js/dist/ofa.js"></script>
  </head>
  <body>
    <!-- Load nos-version component -->
    <l-m src="https://core.noneos.com/nos-tool/comps/nos-version.html"></l-m>
    <!-- Use nos-version component -->
    <nos-version auto-install></nos-version>

    <script type="module">
      // Wait for installation to complete
      $("nos-version").on("installed", () => {
        console.log("NoneOS Core installation completed, ready to use");
        // noneos-core can be used here
      });
    </script>
  </body>
</html>
```

## Installation Status

The `nos-version` component automatically detects the installation status of NoneOS Core:

- **Not installed**: Display "Install NoneOS Core" button
- **Installing**: Display installation progress bar
- **Installed**: Display current version number
- **Upgrade available**: Display upgrade button

When the system installation is completed, or has already been installed, or the upgrade is successful, the `installed` event will be triggered, after which all functions of NoneOS Core can be used normally.