# Overview

FileSystem (FileSystem) is a browser-based virtual file system that provides a complete set of file and directory operation APIs.

## Initialization

Before using the file system, you need to initialize a root directory：

```javascript
import { init } from "/nos/fs/main.js";

await init("my-app");
```

Subsequent tutorials assume that the initialization of `my-app` has been completed.

## Global get method

Use the global `get` method to get or create a file/directory handle:

```javascript
import { get } from "/nos/fs/main.js";

const file = await get("my-app/hello.txt", { create: "file" });
const dir = await get("my-app/path/to/dir", { create: "dir" });
```

Path format: `Root directory name/file path`, do not start with `/`.

## Core Concepts

### FileHandle and DirHandle

- **FileHandle**：Represents a file, providing file read and write operations
- **DirHandle**：Represents a directory, providing directory traversal and sub-item operations

### Basic Attributes

- `kind`: Returns `"file"` or `"dir"`, indicating the handle type
- `name`: Returns the name of the file or directory
- `path`: Returns the full path of the file or directory

## Next Chapter

Learn [File Operations](./file-operations.md) to understand how to read/write and delete files.