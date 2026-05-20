# File Operations

This document describes file operations in the file system, including creating, writing, reading, and deleting files.

## Create a file

Use the `get` method and specify `create: "file"` to create the file:

```javascript
import { get } from "/nos/fs/main.js";

const file = await get("my-app/path/to/file.txt", { create: "file" });
```

## Write to File

Use the `write` method to write content to a file:

```javascript
const file = await get("my-app/hello.txt", { create: "file" });
await file.write("Hello, World!");
```

`write` method supports writing strings or Blob data.

## Read File

### text() method

Use the `text()` method to read the text content of the file:

```javascript
const content = await file.text();
console.log(content); // "Hello, World!"
```

### file() Method

Use the `file()` method to read the raw [File object](https://developer.mozilla.org/zh-CN/docs/Web/API/File):

```javascript
const fileObj = await file.file();
console.log(fileObj.name); // file name
console.log(fileObj.size); // file size
console.log(fileObj.lastModified); // last modified time
```

### buffer() Method

Use the `buffer()` method to read the file's [ArrayBuffer](https://developer.mozilla.org/zh-CN/docs/Web/JavaScript/Reference/Global_Objects/ArrayBuffer) data:

```javascript
const arrayBuffer = await file.buffer();
```

### read() Method

`read()` method is a low-level reading method that supports more options:

```javascript
const content = await file.read({
  type: "text",    // Return type: "text" | "file" | "buffer"
  start: 0,        // start byte
  end: 100,        // end byte
});
```

## JSON Operations

### The json() method

Use the `json()` method to directly read and parse JSON files:

```javascript
const data = await file.json();
```

### base64() Method

Use the `base64()` method to convert the file content to [base64](https://developer.mozilla.org/zh-CN/docs/Glossary/Base64) encoding):

```javascript
const base64String = await file.base64();
console.log(base64String); // "data:application/octet-stream;base64,..."
```

## Get File Information

### lastModified() method

Use `lastModified()` to get the last modified time of a file:

```javascript
const timestamp = await file.lastModified();
console.log(new Date(timestamp)); // Date object
```

### size attribute

Get file size via `file()` method:

```javascript
const fileObj = await file.file();
console.log(fileObj.size); // File size in bytes
```

## Get a file via fetch

Besides using handles, after writing the file, you can also use the browser's `fetch` API to get the file content via URL:

```javascript
const file = await get("my-app/file1.txt", { create: "file" });
const someText = "Write some text " + Math.random();
await file.write(someText);

await new Promise((resolve) => setTimeout(resolve, 300));

const content = await fetch("/$my-app/file1.txt").then((e) => e.text());
```

### Preview HTML file

If it's an HTML file, you can preview it directly in the browser:

```javascript
const htmlFile = await get("my-app/index.html", { create: "file" });
await htmlFile.write("<html><body><h1>Hello World</h1></body></html>");

// Open /$my-app/index.html in your browser to preview (remember to include the $ prefix)
```

## Delete File

Use the `remove()` method to delete a file:

```javascript
const file = await get("my-app/file1.txt", { create: "file" });
await file.remove();

const fileExists = await get("my-app/file1.txt");
// fileExists === null indicates the file has been deleted
```

## Complete Example

```javascript
import { get } from "/nos/fs/main.js";

// Create and write to a file
const file = await get("my-app/example.txt", { create: "file" });
await file.write("This is a test file.");

// Read the file
const content = await file.text();
console.log(content); // "This is a test file."

// Get file info
const fileInfo = await file.file();
console.log(`File name: ${fileInfo.name}, Size: ${fileInfo.size}`);

// Get last modified time
const modified = await file.lastModified();
console.log(`Last modified: ${new Date(modified)}`);

// Delete the file
await file.remove();
const exists = await get("my-app/example.txt");
console.log(exists); // null
```

## Next Chapter

Learn [directory operations](./directory-operations.md) to understand how to traverse and manage directories.