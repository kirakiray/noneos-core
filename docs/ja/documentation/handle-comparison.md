# ファイルハンドルの比較

このドキュメントでは、ファイルハンドルの比較方法、親ディレクトリ、ルートディレクトリ、ファイルサイズ、および一意識別子の取得方法について説明します。

## 親ディレクトリの取得

`parent` 属性を使用してファイルの親ディレクトリを取得します：

```javascript
import { get } from "/nos/fs/main.js";

const testDir = await get("my-app/a/b/c/d");
const testFile = await testDir.get("test.txt", { create: "file" });
const fileParentDir = await testFile.parent;

const isSame = await fileParentDir.isSame(testDir);
// isSame === true
```

## ルートディレクトリの取得

`root` 属性を使用してファイルまたはディレクトリが属するルートディレクトリを取得する：

```javascript
const testDir = await get("my-app/a/b/c/d");
const testFile = await testDir.get("test.txt", { create: "file" });
const root = testFile.root;

const isSame = await root.isSame(await get("my-app"));
// isSame === true
```

## ハンドルが同一かどうかを判定する

`isSame()` メソッドを使用して、2つのハンドルが同じファイルまたはディレクトリを指しているかどうかを判断します：

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

## ファイルサイズを取得する

`size()` メソッドを使用してファイルのサイズを取得します：

```javascript
const file = await get("my-app/example.txt", { create: "file" });
await file.write("Hello, World!");

const fileSize = await file.size();
console.log(fileSize); // 13 (バイト)
```

ディレクトリの場合、`size()` は `null` を返します。

## 一意の識別子を取得する

`id()` メソッドを使用してファイルまたはディレクトリの一意識別子を取得します：

```javascript
const file = await get("my-app/example.txt", { create: "file" });
const id = await file.id();
console.log(id); // 一意のハッシュ値文字列
```

## ハンドル属性

| 属性 | 説明 | 戻り値 |
|------|------|--------|
| `kind` | ハンドルタイプ | `"file"` または `"dir"` |
| `name` | ファイルまたはディレクトリ名 | 文字列 |
| `path` | フルパス | 文字列 |
| `parent` | 親ディレクトリ | DirHandle |
| `root` | ルートディレクトリ | DirHandle |## 完全な例

```javascript
import { get } from "/nos/fs/main.js";

const deepDir = await get("my-app/a/b/c");
const deepFile = await deepDir.get("deep.txt", { create: "file" });
await deepFile.write("Hello!");

// 親ディレクトリを取得
const parent = await deepFile.parent;
console.log(parent.name); // "c"

// ルートディレクトリを取得
const root = deepFile.root;
console.log(root.path); // "my-app"

// ファイルサイズを取得
const size = await deepFile.size();
console.log(size); // 6

// 一意識別子を取得
const id = await deepFile.id();
console.log(id); // "abc123..."

// 異なるパスで同じファイルを取得
const file2 = await deepDir.get("deep.txt");
console.log(await deepFile.isSame(file2)); // true
```

## 次章

[ファイル変更の監視](./file-observation.md) を学習し、ファイル変更イベントの監視方法を理解します。