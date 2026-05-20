# Directory Mounting

The directory mounting feature allows you to access **real directories** in the user's local file system and persistently store them for continued use in subsequent sessions.

> **Real directory**：refers to the actual folder on your **Windows** / **macOS** / **Linux** system, as opposed to a directory in the virtual file system.

## Important Notice

### Browser Support

The `open()` method depends on the browser's `showDirectoryPicker` API, and currently **only Chrome fully supports** this functionality.

```javascript
// Detect browser support
if (!window.showDirectoryPicker) {
  console.error("Current browser does not support directory selection");
  console.log("Please use Chrome browser for full functionality");
  return;
}
```

### Core Uses

The main purpose of directory mounting is to work with `open()` to access the user's local file system:

1. **Local File Access**: Let users select a local directory and directly access file content through the browser
2. **Static Server Functionality**: After mounting, the local directory can be accessed via HTTP requests, implementing functionality similar to a local static server
3. **Persistent Access**: After mounting via `mount()`, the same local directory can be accessed in subsequent sessions without re-selection

**Note**: For virtual file system directories created via `init()`, HTTP access is already automatically supported, no need to use `mount()`.

### Typical Application Scenarios

- Local project development: Access and edit local project files directly in the browser
- Static resource service: Mount local directories as accessible static resource paths
- File management tool: Build a browser-based file management application

## Basic Concepts

### open() - Open directory selector

The `open()` method will pop up the system directory picker, allowing the user to select a local directory:

```javascript
import { open } from "/nos/fs/main.js";

const handle = await open();
```

After the user selects a directory, the system will request read and write permissions. If the user grants permission, a `DirHandle` object will be returned.

**Note**: `open()` is only used to access the user's local file system. For virtual file system directories, use `init()` to create them.

### mount() - Mount Directory

The `mount()` method saves the local directory handle so that subsequent sessions can access it again:

```javascript
import { open, mount } from "/nos/fs/main.js";

const handle = await open(); // Open directory picker, at this point path is a virtual path
await mount(handle); // After mounting, path becomes $mount-{id}>directory name

console.log(handle.path); // Output: $mount-123>directory name
```

The path format after mounting is: `$mount-{id}>directory name`

#### Advantages of the Two-Step Process

It is recommended to use a two-step process (first `open()` then `mount()`) instead of mounting all at once:

1. **Verify directory contents**: Before mounting, you can browse the directory contents to confirm it is the desired directory
2. **Avoid incorrect mounting**: Prevents users from mistakenly mounting the wrong directory into the system
3. **Flexible decision-making**: Allows deciding whether to mount based on the directory contents

```javascript
const handle = await open();

// First verify the directory contents
const packageJson = await handle.get("package.json");
const data = await packageJson.json();
if (data.somedata) {
  // Confirm it's a matching directory, then mount
  await mount(handle);
  console.log("Matching directory mounted:", handle.path);
} else {
  console.log("This is a non-matching directory, mount canceled");
}
```

**Important**：

- `mount()` is primarily used to persist local directories opened by `open()`
- For virtual file system directories created by `init()`, `mount()` is not needed

### Open and mount in one go

You can use the `mount` parameter of `open()` to automatically mount after selecting a directory:

```javascript
import { open } from "/nos/fs/main.js";

const handle = await open({ mount: true });
// Equivalent to:
// const handle = await open();
// await mount(handle);
```

## Main Purpose of mount()

`mount()` method is mainly used in conjunction with `open()` to persist the user-selected local directory. **For the virtual file system directory created via `init()`, `mount()` is not required**.

### Virtual File System Directory (No mount required)

Directories created via `init()` can already be accessed directly via HTTP:

```javascript
import { init } from "/nos/fs/main.js";

// Create virtual file system directory
const dir = await init("my-app");
await dir.get("test.txt", { create: "file" });

// Access directly via $rootdirName
const response = await fetch("/$my-app/test.txt");
const content = await response.text();
```

These directory path formats are: `$directory name`, accessible via HTTP without mounting.

### Local directory (requires mount)

Local directories opened via `open()` need to be mounted for persistent access:

```javascript
import { open, mount } from "/nos/fs/main.js";

// Open the user's local directory
const handle = await open();

// Need to mount to continue accessing in subsequent sessions
await mount(handle);

// After mounting, it can be accessed via $mount-{id}>directory name
const response = await fetch(`/${handle.path}/file.txt`);
```

### Comparison of Two Directory Types

| Feature                | Virtual File System Directory | Local Directory (mount)          |
| ---------------------- | ----------------------------- | --------------------------------- |
| Creation method        | `init("dir-name")`            | `open()` + `mount()`              |
| Path format            | `$dir-name`                   | `$mount-{id}>dir-name`            |
| HTTP access            | ✅ Directly supported        | ✅ Supported after mounting       |
| Persistence            | ✅ Automatic persistence     | ✅ Requires mount persistence    |
| Data location          | Browser storage               | User's local file system          |
| Mount required         | ❌ Not required               | ✅ Required                       |
| Browser support        | All modern browsers           | Chrome only                       |## Managing Mounted Directories

### Get list of mounted directories

Use `getMounted()` to get all mounted directories:

```javascript
import { getMounted } from "/nos/fs/main.js";

const mountedDirs = await getMounted();

mountedDirs.forEach((item) => {
  console.log(item.id); // Mount ID
  console.log(item.name); // Directory name
  console.log(item.path); // Mount path
  console.log(item.handle); // DirHandle object
});
```

### Uninstall directory

Use `unmount()` to remove a mounted directory. This method supports two parameter types:

#### Method 1: Uninstall by ID

```javascript
import { unmount } from "/nos/fs/main.js";

await unmount(mountId);
```

#### Method 2: Uninstall via Handle Object (Recommended)

```javascript
import { open, mount, unmount } from "/nos/fs/main.js";

const handle = await open({ mount: true });
// Use handle...

// Unmount using the handle object directly
await unmount(handle);
```

#### Unmount from the mount list

```javascript
import { getMounted, unmount } from "/nos/fs/main.js";

const mounted = await getMounted();
for (const item of mounted) {
  // Unmount using handle object
  await unmount(item.handle);

  // Or unmount using ID
  // await unmount(item.id);
}
```

After uninstallation, this directory will no longer be accessible via the mount path.

**Note**: Only mounted handles (with a path starting with `$mount-`) can be unmounted. Attempting to unmount an unmounted handle will throw an error.

## Access Files via Mount Path

### Using the get() method

The mounted directory can be accessed via the mount path:

```javascript
import { get } from "/nos/fs/main.js";

// Assuming the mounted path is $mount-123>my-project
const file = await get("$mount-123>my-project/src/index.js");
const content = await file.text();
```

### Accessing Subdirectories

```javascript
const subdir = await get("$mount-123>my-project/src");
const files = await subdir.values();

for await (const file of files) {
  console.log(file.name);
}
```

## Access mounted files via HTTP (static server functionality)

The mounted directory can access files through HTTP requests, implementing functionality similar to a local static server. This is one of the core features of directory mounting.

### Basic Usage

```javascript
import { open, mount } from "/nos/fs/main.js";

const handle = await open({ mount: true });

// Create a test file
const testFile = await handle.get("test.txt", { create: "file" });
await testFile.write("Hello, World!");

// Access via HTTP (like a static server)
const response = await fetch(`/${handle.path}/test.txt`);
const content = await response.text();
console.log(content); // Output: Hello, World!
```

### Practical Application Examples

```javascript
// Mount local project directory
const projectHandle = await open({ mount: true });

// Now any file in the project can be accessed via HTTP
const htmlResponse = await fetch(`/${projectHandle.path}/index.html`);
const htmlContent = await htmlResponse.text();

const jsResponse = await fetch(`/${projectHandle.path}/src/app.js`);
const jsContent = await jsResponse.text();

const cssResponse = await fetch(`/${projectHandle.path}/styles/main.css`);
const cssContent = await cssResponse.text();

// Just like accessing a local static server
```

### Application Scenarios

- **Local Development Server**: Access local files directly in the browser without starting a Node.js server
- **Project Preview**: Real-time preview of local HTML/CSS/JS projects
- **Resource Loading**: Load local images, fonts, and other resources in web applications

## Complete Example

### Create and Mount the Project

```javascript
import { open, mount, getMounted, unmount } from "/nos/fs/main.js";

// Open directory picker
const handle = await open();

// Check if already mounted
const mounted = await getMounted();
const existing = mounted.find((item) => item.name === handle.name);

if (existing) {
  console.log("Directory mounted:", existing.path);
} else {
  // Mount directory
  await mount(handle);
  console.log("Directory mounted:", handle.path);
}

// Use mounted directory
const packageJson = await handle.get("package.json");
if (packageJson) {
  const config = await packageJson.json();
  console.log("Project name:", config.name);
}
```

### Managing Multiple Mount Directories

```javascript
import { getMounted, unmount } from "/nos/fs/main.js";

// Get all mounts
const allMounts = await getMounted();

// Filter specific projects
const projects = allMounts.filter((item) => item.name.includes("project"));

// Unmount old projects
for (const project of projects) {
  if (project.time < Date.now() - 30 * 24 * 60 * 60 * 1000) {
    await unmount(project.handle);
    console.log("Unmounted:", project.name);
  }
}
```

## Permission Management

### Check and Request Permissions

The browser will request permission on first access. If denied or expired, you need to request it again:

```javascript
import { get } from "/nos/fs/main.js";

try {
  const handle = await get("$mount-123>my-project");
  // Use handle
} catch (error) {
  if (error.message.includes("Permission denied")) {
    console.log("Re-authorization required");
    // Prompt user to re-select directory
  }
}
```

## Browser Compatibility

### Support Status

- ✅ Chrome 86+ / Edge 86+  - **Full Support** (Recommended)
- ⚠️ Firefox 111+ - **Does not support** `showDirectoryPicker`, but can mount virtual directories
- ❌ Safari - **Does not support** `showDirectoryPicker`, and also does not support mounting virtual directories

### Core Functionality Description

**`open()` method** relies on the `showDirectoryPicker` API, which is currently a Chrome-only feature:

- **Chrome**: Full support, can pop up a directory picker, and persistently store the handle
- **Other browsers**: Do not support the directory selection feature, cannot use the `open()` method

### Recommended Usage

```javascript
import { open, mount } from "/nos/fs/main.js";

// Check browser support
if (!window.showDirectoryPicker) {
  alert("This feature requires Chrome browser support");
  return;
}

// Usage in Chrome
const handle = await open({ mount: true });
console.log("Local directory mounted:", handle.path);

// Access local files via HTTP
const response = await fetch(`/${handle.path}/index.html`);
const content = await response.text();
```

### Safari Does Not Support Completely

Safari neither supports the `showDirectoryPicker` API nor supports storing `FileSystemHandle` in IndexedDB:

```javascript
// Not supported in Safari
const handle = await open(); // ❌ Error: showDirectoryPicker is not supported
```

### Detect Browser Support

```javascript
const isFileSystemSupported = !!window.showDirectoryPicker;

if (!isFileSystemSupported) {
  console.log("The current browser does not support directory selection.");
  console.log("Please use Chrome browser to get full functionality.");
}
```

## Best Practices

1. **Browser Detection**: Detect whether the browser supports `showDirectoryPicker` before use
2. **User Prompt**: Clearly inform users that this feature requires Chrome browser
3. **Error Handling**: Handle cases of permission denial and non-existent directories
4. **Clean Up Old Mounts**: Periodically clean up mount directories that are no longer needed
5. **Static Server Functionality**: Fully utilize HTTP access features to implement a local file server

### Recommended Full Implementation

```javascript
import { open, mount, getMounted, unmount } from "/nos/fs/main.js";

async function setupLocalProject() {
  // 1. Check browser support
  if (!window.showDirectoryPicker) {
    alert(
      "This function requires Chrome browser support.\n\nPlease use Chrome browser to get full local file access capabilities.",
    );
    return null;
  }

  try {
    // 2. Open and mount the directory
    const handle = await open({ mount: true });

    // 3. Verify if it's a valid project
    const packageJson = await handle.get("package.json");
    if (!packageJson) {
      console.warn("The selected directory is not a valid project");
    }

    console.log("Local project mounted:", handle.path);
    console.log("Accessible via HTTP:", `/${handle.path}/`);

    return handle;
  } catch (error) {
    if (error.message.includes("Permission denied")) {
      alert("Directory access permission is required to use this feature");
    } else {
      console.error("Mount failed:", error);
    }
    return null;
  }
}

// Usage example
const projectHandle = await setupLocalProject();
if (projectHandle) {
  // Access local files via HTTP
  const response = await fetch(`/${projectHandle.path}/README.md`);
  const readme = await response.text();
  console.log(readme);
}
```

## Next Chapter

Learn about [file operations](./file-operations.md), including how to read, write, and delete files.