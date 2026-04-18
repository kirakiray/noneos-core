# 概要

ファイルシステム（FileSystem）は、ブラウザベースの仮想ファイルシステムであり、完全なファイルおよびディレクトリ操作APIを提供します。

## 初期化

ファイルシステムを使用する前に、まずルートディレクトリを初期化する必要があります：

```javascript
import { init } from "/nos/fs/main.js";

await init("my-app");
```

以降のチュートリアルは、`my-app` の初期化が完了していることを前提としています。

## グローバル get メソッド

グローバルな `get` メソッドを使用して、ファイル/ディレクトリハンドルを取得または作成します：

```javascript
import { get } from "/nos/fs/main.js";

const file = await get("my-app/hello.txt", { create: "file" });
const dir = await get("my-app/path/to/dir", { create: "dir" });
```

パス形式：`ルートディレクトリ名/ファイルパス`、先頭に `/` を使用しない。

## 核心概念

### FileHandle と DirHandle

- **FileHandle**：ファイルを表し、ファイルの読み書き操作を提供する
- **DirHandle**：ディレクトリを表し、ディレクトリの走査と子項目の操作を提供する

### 基本属性

- `kind`：`"file"` または `"dir"` を返し、ハンドルのタイプを示します
- `name`：ファイルまたはディレクトリの名前を返します
- `path`：ファイルまたはディレクトリの完全なパスを返します

## 次章

[ファイル操作](./file-operations.md)を学び、ファイルの読み書きや削除の方法を理解します。