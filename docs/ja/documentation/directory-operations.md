# ディレクトリ操作

本書では、ファイルシステムにおけるディレクトリ操作（作成、走査、検索、フラット化、削除を含む）について説明します。

## ディレクトリの作成

`get` メソッドを使用し、`create: "dir"` を指定してディレクトリを作成します：

```javascript
import { get } from "/nos/fs/main.js";

const dir = await get("my-app/path/to/dir", { create: "dir" });
```

## 子項目の数を取得

`length()` メソッドを使用して、ディレクトリ内の子ファイル/ディレクトリの総数を取得します：

```javascript
const dir = await get("my-app/subDir", { create: "dir" });
await dir.get("file1.txt", { create: "file" });
await dir.get("file2.txt", { create: "file" });

const count = await dir.length();
console.log(count); // 2
```

## ディレクトリ走査

### keys() メソッド

`keys()` メソッドを使用してディレクトリ内のすべての項目の名前を反復処理します。

```javascript
for await (const key of dir.keys()) {
  console.log(key);
}
```

### values() メソッド

`values()` メソッドを使用して、ディレクトリ内のすべてのファイルとサブディレクトリを走査します：

```javascript
const handles = [];
for await (const handle of dir.values()) {
  handles.push({
    kind: handle.kind,
    name: handle.name,
  });
}
```

### entries() メソッド

`entries()` メソッドを使用してディレクトリ内のすべてのエントリを反復処理し、[名前, ハンドル] のペアを返します：

```javascript
for await (const [name, handle] of dir.entries()) {
  console.log(`${handle.kind}: ${name}`);
}
```

### forEach() メソッド

`forEach()` メソッドを使用してディレクトリを走査する：

```javascript
await dir.forEach(async (handle, name) => {
  console.log(`${handle.kind}: ${name}`);
});
```

### some() メソッド

`some()` メソッドを使用して、条件を満たす最初のファイルまたはディレクトリを検索し、見つかったら自動的に走査を停止します：

```javascript
let foundTarget = false;
let count = 0;

await dir.some(async (handle, name) => {
  count++;
  if (handle.kind === "file") {
    if (count === 2) {
      foundTarget = true;
      return true; // trueを返して繰り返し処理を停止する
    }
  }
  return false;
});
```

## フラット化ディレクトリ

`flat()` メソッドを使用して、ディレクトリとそのすべてのサブディレクトリから**ファイルハンドル**（ディレクトリを除く）を取得します。

```javascript
const allFiles = await dir.flat();

const fileContents = await Promise.all(
  allFiles.map(async (file) => ({
    path: file.path,
    content: await file.read(),
  }))
);
```

示例：

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
// 戻り値: [file1.txt, subDir1/file2.txt, subDir1/subDir2/file3.txt]
```

## ディレクトリの削除

`remove()` メソッドを使用してディレクトリを削除します（ディレクトリ内のすべての内容を再帰的に削除します）：

```javascript
const subDir = await get("my-app/subDir", { create: "dir" });
await subDir.get("file2.txt", { create: "file" });

await subDir.remove();
const subDirExists = await get("my-app/subDir");
// subDirExists === null はディレクトリが削除されたことを示します
```

⚠️ 警告：削除操作は即座に実行され、ディレクトリ下にサブファイルやサブディレクトリがあってもすべて削除され、復元できません。慎重に操作してください。

## 完全な例

```javascript
import { get } from "/nos/fs/main.js";

const rootDir = await get("my-app");

// ディレクトリ構造を作成
await rootDir.get("docs", { create: "dir" });
await rootDir.get("docs/guide.md", { create: "file" });
await rootDir.get("docs/api.md", { create: "file" });
await rootDir.get("images", { create: "dir" });

// エントリ数を取得
const count = await rootDir.length();
console.log(`エントリ数: ${count}`); // 2

// ルートディレクトリを反復
for await (const [name, handle] of rootDir.entries()) {
  console.log(`${handle.kind}: ${name}`);
}
// 出力: dir: docs, dir: images

// フラット化して全ファイルを取得
const allFiles = await rootDir.flat();
console.log(allFiles.map(f => f.path));
// 出力: ["docs/guide.md", "docs/api.md"]
```

## 次の章

[ファイルの移動とコピー](./move-and-copy.md) を学び、ファイルの移動とコピーの方法を理解します。