# File Change Observation

This document describes how to use the `observe` method to monitor file or directory change events.

## Basic Usage

Use the `observe()` method to monitor changes in files or directories:

```javascript
import { get } from "/nos/fs/main.js";

const dir = await get("my-app");

const events = [];
const unobserve = await dir.observe((event) => {
  console.log("File change event received:", event);
  events.push(event);
});

// Create file
const file = await dir.get("test.txt", { create: "file" });
await file.write("Hello");

// Delete file
await file.remove();

// Stop observing
unobserve();
```

Both files and directories can be monitored for changes, for example, monitoring a single file:

```javascript
const file = await get("my-app/test.txt", { create: "file" });

const unobserve = await file.observe((event) => {
  console.log("File modified:", event.type);
});

await file.write("new content");

unobserve();
```

## observe return value

`observe()` returns a Promise that resolves to a function to cancel the observation. Calling that function can stop the listening:

```javascript
const unobserve = await dir.observe((event) => {
  // Handle event
});

// Unobserve later
unobserve();
```

## Event Object

Observed event object received by the callback contains the following attributes:

| Property | Description |
|------|------|
| `type` | Event type, e.g. `"create"`, `"remove"`, `"write"` |
| `path` | Path of the file that changed |## Complete Example

```javascript
import { get } from "/nos/fs/main.js";

const dir = await get("my-app");

console.log("Start file change observation test");

const events = [];
const unobserve = await dir.observe((event) => {
  console.log("File change:", event.type, event.path);
  events.push(event);
});

// Perform some file operations
await dir.get("file1.txt", { create: "file" });
await (await dir.get("file1.txt")).write("content");

await new Promise((resolve) => setTimeout(resolve, 100));

await (await dir.get("file1.txt")).remove();

await new Promise((resolve) => setTimeout(resolve, 100));

unobserve();

console.log(`Received ${events.length} events in total`);
```

## Notes

1. The observer will only start monitoring after it is created, and previous file operations will not be captured
2. After canceling the observation, newly occurring file changes will not be recorded
3. File change events are triggered asynchronously and may have a certain delay