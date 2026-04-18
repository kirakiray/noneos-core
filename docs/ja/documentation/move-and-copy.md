# ファイルの移動とコピー

この文書では、ファイルやディレクトリの移動とコピーについて説明します。

## ファイルの移動

`moveTo()` メソッドを使用してファイルをターゲットディレクトリに移動します：

```javascript
import { get } from "/nos/fs/main.js";

const sourceFile = await get("my-app/source.txt", { create: "file" });
await sourceFile.write("Hello, World!");

const targetDir = await get("my-app/target", { create: "dir" });

// 第二引数はターゲットファイル名、指定しない場合は元のファイル名を使用
const movedFile = await sourceFile.moveTo(targetDir);
// sourceFile.moveTo(targetDir, "source.txt") と同等

const content = await movedFile.text();
// content === "Hello, World!"

const oldFile = await get("my-app/source.txt");
// oldFile === null は元のファイルが移動されたことを示す
```

## ディレクトリの移動

`moveTo()` メソッドはディレクトリにも適用され、ディレクトリとそのすべての内容を再帰的に移動します。2番目のパラメータはターゲットディレクトリ名で、指定しない場合は元のディレクトリ名が使用されます：

```javascript
const sourceDir = await get("my-app/sourceDir", { create: "dir" });
await sourceDir.get("file1.txt", { create: "file" });
await sourceDir.get("subDir/file2.txt", { create: "file" });

await (await sourceDir.get("file1.txt")).write("Content 1");
await (await sourceDir.get("subDir/file2.txt")).write("Content 2");

const targetDir = await get("my-app/target", { create: "dir" });
const movedDir = await sourceDir.moveTo(targetDir);
// 等同于 sourceDir.moveTo(targetDir, "sourceDir")

// movedDir 包含 file1.txt 和 subDir/file2.txt
```

## ファイルをコピーする

`copyTo()` メソッドを使用してファイルを対象ディレクトリにコピーする：

```javascript
const sourceFile = await get("my-app/source.txt", { create: "file" });
await sourceFile.write("Hello, World!");

const targetDir = await get("my-app/target", { create: "dir" });

// 第二引数はターゲットファイル名、省略時は元のファイル名を継続使用
const copiedFile = await sourceFile.copyTo(targetDir);
// sourceFile.copyTo(targetDir, "source.txt") と同等

const content = await copiedFile.text();
// content === "Hello, World!"

// 元ファイルは依然として存在
const originalFile = await get("my-app/source.txt");
// originalFile !== null
```

## ディレクトリをコピーする

`copyTo()` メソッドはディレクトリにも同様に適用され、ディレクトリとそのすべての内容を再帰的にコピーします。2番目の引数はコピー先のディレクトリ名で、指定しない場合は元のディレクトリ名が使われます：

```javascript
const sourceDir = await get("my-app/sourceDir", { create: "dir" });
await sourceDir.get("file1.txt", { create: "file" });
await sourceDir.get("subDir/file2.txt", { create: "file" });

await (await sourceDir.get("file1.txt")).write("Content 1");
await (await sourceDir.get("subDir/file2.txt")).write("Content 2");

const targetDir = await get("my-app/target", { create: "dir" });
const copiedDir = await sourceDir.copyTo(targetDir);
// sourceDir.copyTo(targetDir, "sourceDir") と同等

// copiedDir は file1.txt と subDir/file2.txt を含む
```

## 完全な例

```javascript
import { get } from "/nos/fs/main.js";

const sourceFile = await get("my-app/document.txt", { create: "file" });
await sourceFile.write("Important content");

const backupDir = await get("my-app/backup", { create: "dir" });
const archiveDir = await get("my-app/archive", { create: "dir" });

// ファイルのコピー
const backup = await sourceFile.copyTo(backupDir, "document_backup.txt");
console.log(await backup.text()); // "Important content"

// ファイルの移動
await sourceFile.moveTo(archiveDir, "document_archived.txt");

// 移動結果の検証
const original = await get("my-app/document.txt");
console.log(original); // null
```

## 次章

[ファイルハンドルの比較](./handle-comparison.md)を学び、ファイルハンドルを比較する方法を理解します。