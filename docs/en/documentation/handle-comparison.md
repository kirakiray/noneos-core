# File Handle Comparison

This document describes how to compare file handles and obtain the parent directory, root directory, file size, and unique identifier.

## Get Parent Directory

Use the `parent` attribute to get the parent directory of the file:

```javascript
import { get } from "/nos/fs/main.js";

const testDir = await get("my-app/a/b/c/d");
const testFile = await testDir.get("test.txt", { create: "file" });
const fileParentDir = await testFile.parent;

const isSame = await fileParentDir.isSame(testDir);
// isSame === true
```

## Get Root Directory

Use the `root` attribute to get the root directory of a file or directory:

```javascript
const testDir = await get("my-app/a/b/c/d");
const testFile = await testDir.get("test.txt", { create: "file" });
const root = testFile.root;

const isSame = await root.isSame(await get("my-app"));
// isSame === true
```

## Determine if handles are the same

Use the `isSame()` method to determine whether two handles point to the same file or directory:

```javascript
const dir = await get("my-app/path/to");
await dir.get("file.txt", { create: "file" });
await dir.get("other.txt", { create: "file" });

const file1 = await dir.get("file.txt");
const file2 = await dir.get("file.txt");
const file3 = await dir.get("other.txt");

const result1 = await file1.isSame(file2);
// result1 === true

const result2 = await file1.isSame(file3);
// result2 === false
```

## Get File Size

Use the `size()` method to get the file size:

```javascript
const file = await get("my-app/example.txt", { create: "file" });
await file.write("Hello, World!");

const fileSize = await file.size();
console.log(fileSize); // 13 (bytes)
```

For directories, `size()` returns `null`.

## Get Unique Identifier

Use the `id()` method to get the unique identifier of a file or directory:

```javascript
const file = await get("my-app/example.txt", { create: "file" });
const id = await file.id();
console.log(id); // unique hash string
```

## Handle Attributes

| Property | Description | Return Value |
|------|------|--------|
| `kind` | Handle type | `"file"` or `"dir"` |
| `name` | Name of the file or directory | string |
| `path` | Full path | string |
| `parent` | Parent directory | DirHandle |
| `root` | Root directory | DirHandle |## Complete Example

```javascript
import { get } from "/nos/fs/main.js";

const deepDir = await get("my-app/a/b/c");
const deepFile = await deepDir.get("deep.txt", { create: "file" });
await deepFile.write("Hello!");

// Get parent directory
const parent = await deepFile.parent;
console.log(parent.name); // "c"

// Get root directory
const root = deepFile.root;
console.log(root.path); // "my-app"

// Get file size
const size = await deepFile.size();
console.log(size); // 6

// Get unique identifier
const id = await deepFile.id();
console.log(id); // "abc123..."

// Get the same file through different paths
const file2 = await deepDir.get("deep.txt");
console.log(await deepFile.isSame(file2)); // true
```

## Next Chapter

Learn [File Observation](./file-observation.md) to understand how to listen for file change events.