# Directory Operations

This document describes directory operations in the file system, including creating directories, traversing, searching, flattening, and deleting.

## Create Directory

Use the `get` method with `create: "dir"` to create a directory:

```javascript
import { get } from "/nos/fs/main.js";

const dir = await get("my-app/path/to/dir", { create: "dir" });
```

## Get Number of Children

Use the `length()` method to get the total number of sub-files/directories in the directory:

```javascript
const dir = await get("my-app/subDir", { create: "dir" });
await dir.get("file1.txt", { create: "file" });
await dir.get("file2.txt", { create: "file" });

const count = await dir.length();
console.log(count); // 2
```

## Traversing Directories

### keys() method

Use the `keys()` method to iterate over the names of all items in the directory:

```javascript
for await (const key of dir.keys()) {
  console.log(key);
}
```

### values() method

Use the `values()` method to iterate over all files and subdirectories in the directory:

```javascript
const handles = [];
for await (const handle of dir.values()) {
  handles.push({
    kind: handle.kind,
    name: handle.name,
  });
}
```

### entries() method

Use the `entries()` method to iterate through all items in the directory, returning [name, handle] pairs:

```javascript
for await (const [name, handle] of dir.entries()) {
  console.log(`${handle.kind}: ${name}`);
}
```

### forEach() Method

Using the `forEach()` method to traverse a directory:

```javascript
await dir.forEach(async (handle, name) => {
  console.log(`${handle.kind}: ${name}`);
});
```

### some() method

Use the `some()` method to find the first file or directory that meets the condition; traversal stops automatically once it is found:

```javascript
let foundTarget = false;
let count = 0;

await dir.some(async (handle, name) => {
  count++;
  if (handle.kind === "file") {
    if (count === 2) {
      foundTarget = true;
      return true; // return true to stop iteration
    }
  }
  return false;
});
```

## Flatten Directory

Use the `flat()` method to get all **file handles** in the directory and all its subdirectories (excluding directories):

```javascript
const allFiles = await dir.flat();

const fileContents = await Promise.all(
  allFiles.map(async (file) => ({
    path: file.path,
    content: await file.read(),
  }))
);
```

Example:

```javascript
const rootDir = await get("my-app");
await rootDir.get("file1.txt", { create: "file" });
await rootDir.get("subDir1", { create: "dir" });
await rootDir.get("subDir1/file2.txt", { create: "file" });
await rootDir.get("subDir1/subDir2", { create: "dir" });
await rootDir.get("subDir1/subDir2/file3.txt", { create: "file" });

await (await rootDir.get("file1.txt")).write("root file");
await (await rootDir.get("subDir1/file2.txt")).write("level 1 file");
await (await rootDir.get("subDir1/subDir2/file3.txt")).write("level 2 file");

const allFiles = await rootDir.flat();
// Returns: [file1.txt, subDir1/file2.txt, subDir1/subDir2/file3.txt]
```

## Delete Directory

Use the `remove()` method to delete a directory (this will recursively delete all contents under the directory):

```javascript
const subDir = await get("my-app/subDir", { create: "dir" });
await subDir.get("file2.txt", { create: "file" });

await subDir.remove();
const subDirExists = await get("my-app/subDir");
// subDirExists === null indicates the directory has been deleted
```

⚠️ Warning: The deletion will be executed immediately. Even if there are sub-files or sub-directories under the directory, they will be deleted together and cannot be recovered. Please proceed with caution.

## Complete Example

```javascript
import { get } from "/nos/fs/main.js";

const rootDir = await get("my-app");

// Create directory structure
await rootDir.get("docs", { create: "dir" });
await rootDir.get("docs/guide.md", { create: "file" });
await rootDir.get("docs/api.md", { create: "file" });
await rootDir.get("images", { create: "dir" });

// Get number of children
const count = await rootDir.length();
console.log(`Number of children: ${count}`); // 2

// Iterate root directory
for await (const [name, handle] of rootDir.entries()) {
  console.log(`${handle.kind}: ${name}`);
}
// Output: dir: docs, dir: images

// Flatten to get all files
const allFiles = await rootDir.flat();
console.log(allFiles.map(f => f.path));
// Output: ["docs/guide.md", "docs/api.md"]
```

## Next Chapter

Learn [File Moving and Copying](./move-and-copy.md) to understand how to move and copy files.