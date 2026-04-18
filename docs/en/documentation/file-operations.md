# File Operations

This document introduces file operations in the file system, including creating, writing, reading, and deleting files.

## Create File

Use the `get` method and specify `create: "file"` to create a file:

```javascript
import { get } from "/nos/fs/main.js";

const file = await get("my-app/path/to/file.txt", { create: "file" });
```

## Writing Files

Using the `write` method to write content to a file:

```javascript
const file = await get("my-app/hello.txt", { create: "file" });
await file.write("Hello, World!");
```

The `write` method supports writing string or Blob data.

## Reading Files

### text() method

Read the text content of a file using the `text()` method:

```javascript
const content = await file.text();
console.log(content); // "Hello, World!"
```

### file() method

Using the `file()` method to read the original [File object](https://developer.mozilla.org/zh-CN/docs/Web/API/File):

```javascript
const fileObj = await file.file();
console.log(fileObj.name); // filename
console.log(fileObj.size); // file size
console.log(fileObj.lastModified); // last modified time
```

### buffer() method

Use the `buffer()` method to read the file's [ArrayBuffer](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/ArrayBuffer) data:

```javascript
const arrayBuffer = await file.buffer();
```

### read() Method

The `read()` method is the underlying reading method that supports more options:

```javascript
const content = await file.read({
  type: "text",    // Return type: "text" | "file" | "buffer"
  start: 0,        // Start byte
  end: 100,        // End byte
});
```

## JSON Operations

### json() method

Use the `json()` method to directly read and parse a JSON file:

```javascript
const data = await file.json();
```

### base64() Method

Use the `base64()` method to convert the file content to [base64](https://developer.mozilla.org/en-US/docs/Glossary/Base64) encoding):

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

Get the file size through the `file()` method:

```javascript
const fileObj = await file.file();
console.log(fileObj.size); // file size (bytes)
```

## Fetching files via fetch

In addition to using a handle, after writing to a file you can also use the browser’s `fetch` API to retrieve the file’s contents via its URL:

```javascript
const file = await get("my-app/file1.txt", { create: "file" });
const someText = "Write some text " + Math.random();
await file.write(someText);

await new Promise((resolve) => setTimeout(resolve, 300));

const content = await fetch("/$my-app/file1.txt").then((e) => e.text());
```

### Preview HTML Files

If the file written is an HTML file, it can be previewed directly in the browser:

```javascript
const htmlFile = await get("my-app/index.html", { create: "file" });
await htmlFile.write("<html><body><h1>Hello World</h1></body></html>");

// Open /$my-app/index.html in your browser to preview (remember to include the $ prefix)
```

## Delete Files

Using the `remove()` method to delete a file:

```javascript
const file = await get("my-app/file1.txt", { create: "file" });
await file.remove();

const fileExists = await get("my-app/file1.txt");
// fileExists === null indicates the file has been deleted
```

## Complete Example

```javascript
import { get } from "/nos/fs/main.js";

// Create and write file
const file = await get("my-app/example.txt", { create: "file" });
await file.write("This is a test file.");

// Read file
const content = await file.text();
console.log(content); // "This is a test file."

// Get file info
const fileInfo = await file.file();
console.log(`File name: ${fileInfo.name}, Size: ${fileInfo.size}`);

// Get last modified time
const modified = await file.lastModified();
console.log(`Last modified: ${new Date(modified)}`);

// Delete file
await file.remove();
const exists = await get("my-app/example.txt");
console.log(exists); // null
```

## Next Chapter

Study [Directory Operations](./directory-operations.md) to learn how to traverse and manage directories.