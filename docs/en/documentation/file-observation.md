# File Changes Observation

This document introduces how to use the `observe` method to listen for change events of files or directories.

## Basic Usage

Use the `observe()` method to monitor changes in files or directories:

```javascript
import { get } from "/nos/fs/main.js";

const dir = await get("my-app");

const events = [];
const unobserve = await dir.observe((event) => {
  console.log("Received file change event:", event);
  events.push(event);
});

// Create file
const file = await dir.get("test.txt", { create: "file" });
await file.write("Hello");

// Delete file
await file.remove();

// Cancel observation
unobserve();
```

Files and directories can both be monitored for changes, for example, monitoring a single file:

```javascript
const file = await get("my-app/test.txt", { create: "file" });

const unobserve = await file.observe((event) => {
  console.log("File modified:", event.type);
});

await file.write("new content");

unobserve();
```

## observe Return Value

`observe()` returns a Promise that resolves to a function to cancel observation. Calling this function stops the listening:

```javascript
const unobserve = await dir.observe((event) => {
  // Handle event
});

// Unobserve later
unobserve();
```

## Event Object

The event object received by the observation callback contains the following properties:

| Property | Description |
|------|------|
| `type` | Event type, such as `"create"`, `"remove"`, `"write"` |
| `path` | Path of the file that changed |## Complete Example

```javascript
import { get } from "/nos/fs/main.js";

const dir = await get("my-app");

console.log("Starting file change observation test");

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

console.log(`Total events received: ${events.length}`);
```

## Important Notes

1. The observer starts monitoring only after it is created; file operations prior to that will not be captured.
2. After the observer is canceled, newly occurring file changes will not be recorded.
3. File change events are triggered asynchronously and may experience some delay.