# ファイルの移動とコピー

このドキュメントでは、ファイルとディレクトリの移動とコピーの方法を説明します。

## ファイルの移動

`moveTo()` メソッドを使用してファイルをターゲットディレクトリに移動します。

```javascript
import { get } from "/nos/fs/main.js";

const sourceFile = await get("my-app/source.txt", { create: "file" });
await sourceFile.write("Hello, World!");

const targetDir = await get("my-app/target", { create: "dir" });

// 第2引数はターゲットファイル名です。指定しない場合は元のファイル名が使用されます
const movedFile = await sourceFile.moveTo(targetDir);
// sourceFile.moveTo(targetDir, "source.txt") と同等

const content = await movedFile.text();
// content === "Hello, World!"

const oldFile = await get("my-app/source.txt");
// oldFile === null は元のファイルが移動されたことを示します
```

## ディレクトリの移動

`moveTo()` メソッドはディレクトリにも同様に適用され、ディレクトリとそのすべての内容を再帰的に移動します。2番目のパラメータは移動先のディレクトリ名で、指定しない場合は元のディレクトリ名が使用されます：

```javascript
const sourceDir = await get("my-app/sourceDir", { create: "dir" });
await sourceDir.get("file1.txt", { create: "file" });
await sourceDir.get("subDir/file2.txt", { create: "file" });

await (await sourceDir.get("file1.txt")).write("Content 1");
await (await sourceDir.get("subDir/file2.txt")).write("Content 2");

const targetDir = await get("my-app/target", { create: "dir" });
const movedDir = await sourceDir.moveTo(targetDir);
// sourceDir.moveTo(targetDir, "sourceDir") と同等

// movedDir には file1.txt と subDir/file2.txt が含まれている
```

## ファイルのコピー

`copyTo()` メソッドを使用してファイルをターゲットディレクトリにコピーします：

```javascript
const sourceFile = await get("my-app/source.txt", { create: "file" });
await sourceFile.write("Hello, World!");

const targetDir = await get("my-app/target", { create: "dir" });

// 2番目の引数はターゲットファイル名で、省略した場合は元のファイル名が使われる
const copiedFile = await sourceFile.copyTo(targetDir);
// sourceFile.copyTo(targetDir, "source.txt") と同等

const content = await copiedFile.text();
// content === "Hello, World!"

// 元のファイルは依然として存在する
const originalFile = await get("my-app/source.txt");
// originalFile !== null
```

## ディレクトリをコピー

`copyTo()` メソッドはディレクトリにも同様に適用され、ディレクトリとそのすべての内容を再帰的にコピーします。第二引数はコピー先のディレクトリ名で、指定しない場合は元のディレクトリ名がそのまま使用されます：

```javascript
const sourceDir = await get("my-app/sourceDir", { create: "dir" });
await sourceDir.get("file1.txt", { create: "file" });
await sourceDir.get("subDir/file2.txt", { create: "file" });

await (await sourceDir.get("file1.txt")).write("Content 1");
await (await sourceDir.get("subDir/file2.txt")).write("Content 2");

const targetDir = await get("my-app/target", { create: "dir" });
const copiedDir = await sourceDir.copyTo(targetDir);
// sourceDir.copyTo(targetDir, "sourceDir") と同等です

// copiedDir には file1.txt と subDir/file2.txt が含まれます
```

## 完全な例

```javascript
import { get } from "/nos/fs/main.js";

const sourceFile = await get("my-app/document.txt", { create: "file" });
await sourceFile.write("Important content");

const backupDir = await get("my-app/backup", { create: "dir" });
const archiveDir = await get("my-app/archive", { create: "dir" });

// ファイルをコピーする
const backup = await sourceFile.copyTo(backupDir, "document_backup.txt");
console.log(await backup.text()); // "Important content"

// ファイルを移動する
await sourceFile.moveTo(archiveDir, "document_archived.txt");

// 移動の結果を確認する
const original = await get("my-app/document.txt");
console.log(original); // null
```

## 次の章

[ファイルハンドルの比較](./handle-comparison.md)を学習して、ファイルハンドルの比較方法を理解しましょう。