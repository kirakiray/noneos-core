# File Moving and Copying

This document describes how to move and copy files and directories.

## Moving Files

Use the `moveTo()` method to move the file to the target directory:

```javascript
import { get } from "/nos/fs/main.js";

const sourceFile = await get("my-app/source.txt", { create: "file" });
await sourceFile.write("Hello, World!");

const targetDir = await get("my-app/target", { create: "dir" });

// The second parameter is the target file name; omit it to keep the original name
const movedFile = await sourceFile.moveTo(targetDir);
// Equivalent to sourceFile.moveTo(targetDir, "source.txt")

const content = await movedFile.text();
// content === "Hello, World!"

const oldFile = await get("my-app/source.txt");
// oldFile === null means the original file has been moved
```

## Move Directory

The `moveTo()` method also applies to directories, recursively moving the directory and all its contents. The second parameter is the target directory name; if not provided, the original directory name is used:

```javascript
const sourceDir = await get("my-app/sourceDir", { create: "dir" });
await sourceDir.get("file1.txt", { create: "file" });
await sourceDir.get("subDir/file2.txt", { create: "file" });

await (await sourceDir.get("file1.txt")).write("Content 1");
await (await sourceDir.get("subDir/file2.txt")).write("Content 2");

const targetDir = await get("my-app/target", { create: "dir" });
const movedDir = await sourceDir.moveTo(targetDir);
// Equivalent to sourceDir.moveTo(targetDir, "sourceDir")

// movedDir contains file1.txt and subDir/file2.txt
```

## Copy File

Use the `copyTo()` method to copy the file to the target directory:

```javascript
const sourceFile = await get("my-app/source.txt", { create: "file" });
await sourceFile.write("Hello, World!");

const targetDir = await get("my-app/target", { create: "dir" });

// The second parameter is the target file name; if not provided, the original file name is used.
const copiedFile = await sourceFile.copyTo(targetDir);
// Equivalent to sourceFile.copyTo(targetDir, "source.txt")

const content = await copiedFile.text();
// content === "Hello, World!"

// The original file still exists
const originalFile = await get("my-app/source.txt");
// originalFile !== null
```

## Copy Directory

The `copyTo()` method is also applicable to directories, recursively copying the directory and all its contents. The second parameter is the target directory name; if not provided, the original directory name is used:

```javascript
const sourceDir = await get("my-app/sourceDir", { create: "dir" });
await sourceDir.get("file1.txt", { create: "file" });
await sourceDir.get("subDir/file2.txt", { create: "file" });

await (await sourceDir.get("file1.txt")).write("Content 1");
await (await sourceDir.get("subDir/file2.txt")).write("Content 2");

const targetDir = await get("my-app/target", { create: "dir" });
const copiedDir = await sourceDir.copyTo(targetDir);
// Same as sourceDir.copyTo(targetDir, "sourceDir")

// copiedDir contains file1.txt and subDir/file2.txt
```

## Complete Example

```javascript
import { get } from "/nos/fs/main.js";

const sourceFile = await get("my-app/document.txt", { create: "file" });
await sourceFile.write("Important content");

const backupDir = await get("my-app/backup", { create: "dir" });
const archiveDir = await get("my-app/archive", { create: "dir" });

// Copy file
const backup = await sourceFile.copyTo(backupDir, "document_backup.txt");
console.log(await backup.text()); // "Important content"

// Move file
await sourceFile.moveTo(archiveDir, "document_archived.txt");

// Verify move result
const original = await get("my-app/document.txt");
console.log(original); // null
```

## Next Chapter

Study [File Handle Comparison](./handle-comparison.md) to learn how to compare file handles.