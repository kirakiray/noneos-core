# ファイル操作

本ドキュメントでは、ファイルシステムにおけるファイル操作（作成、書き込み、読み取り、削除を含む）について説明します。

## ファイルを作成

`get` メソッドを使用し、`create: "file"` を指定してファイルを作成します：

```javascript
import { get } from "/nos/fs/main.js";

const file = await get("my-app/path/to/file.txt", { create: "file" });
```

## ファイルに書き込む

`write`メソッドを使用してファイルに内容を書き込む：

```javascript
const file = await get("my-app/hello.txt", { create: "file" });
await file.write("Hello, World!");
```

`write` メソッドは、文字列または Blob データの書き込みをサポートします。

## ファイル読み込み

### text() メソッド

`text()` メソッドを使用してファイルのテキスト内容を読み取る:

```javascript
const content = await file.text();
console.log(content); // "Hello, World!"
```

### file() メソッド

`file()` メソッドを使用して、生の [File オブジェクト](https://developer.mozilla.org/ja/docs/Web/API/File) を読み取ります。

```javascript
const fileObj = await file.file();
console.log(fileObj.name); // ファイル名
console.log(fileObj.size); // ファイルサイズ
console.log(fileObj.lastModified); // 最終更新日時
```

### buffer() メソッド

`buffer()` メソッドを使用してファイルの [ArrayBuffer](https://developer.mozilla.org/zh-CN/docs/Web/JavaScript/Reference/Global_Objects/ArrayBuffer) データを読み取る：

```javascript
const arrayBuffer = await file.buffer();
```

### read() メソッド

`read()` メソッドは低レベルの読み取りメソッドで、より多くのオプションをサポートしています：

```javascript
const content = await file.read({
  type: "text",    // 戻り値の型: "text" | "file" | "buffer"
  start: 0,        // 開始バイト
  end: 100,        // 終了バイト
});
```

## JSON 操作

### json() メソッド

`json()` メソッドを使用して JSON ファイルを直接読み取り、解析する：

```javascript
const data = await file.json();
```

### base64() メソッド

`base64()` メソッドを使用してファイルの内容を [base64](https://developer.mozilla.org/zh-CN/docs/Glossary/Base64) エンコーディングに変換します)：

```javascript
const base64String = await file.base64();
console.log(base64String); // "data:application/octet-stream;base64,..."
```

## ファイル情報の取得

### lastModified() メソッド

`lastModified()` を使用してファイルの最終更新日時を取得する：

```javascript
const timestamp = await file.lastModified();
console.log(new Date(timestamp)); // Date オブジェクト
```

### size プロパティ

`file()` メソッドでファイルサイズを取得する：

```javascript
const fileObj = await file.file();
console.log(fileObj.size); // ファイルサイズ（バイト）
```

## fetch を使用してファイルを取得する

ハンドルを使用する以外に、ファイルに書き込んだ後、ブラウザの `fetch` API を使用して URL 経由でファイルの内容を取得することもできます：

```javascript
const file = await get("my-app/file1.txt", { create: "file" });
const someText = "Write some text " + Math.random();
await file.write(someText);

await new Promise((resolve) => setTimeout(resolve, 300));

const content = await fetch("/$my-app/file1.txt").then((e) => e.text());
```

### HTML ファイルのプレビュー

HTMLファイルに書き込む場合、ブラウザで直接プレビューできます：

```javascript
const htmlFile = await get("my-app/index.html", { create: "file" });
await htmlFile.write("<html><body><h1>Hello World</h1></body></html>");

// ブラウザで /$my-app/index.html を開くとプレビューできます（$ プレフィックスを忘れずに）
```

## ファイルを削除

`remove()` メソッドを使用してファイルを削除します：

```javascript
const file = await get("my-app/file1.txt", { create: "file" });
await file.remove();

const fileExists = await get("my-app/file1.txt");
// fileExists === null はファイルが削除されたことを意味します
```

## 完全な例

```javascript
import { get } from "/nos/fs/main.js";

// ファイルを作成して書き込む
const file = await get("my-app/example.txt", { create: "file" });
await file.write("This is a test file.");

// ファイルを読み込む
const content = await file.text();
console.log(content); // "This is a test file."

// ファイル情報を取得する
const fileInfo = await file.file();
console.log(`ファイル名: ${fileInfo.name}, サイズ: ${fileInfo.size}`);

// 最終更新日時を取得する
const modified = await file.lastModified();
console.log(`最終更新: ${new Date(modified)}`);

// ファイルを削除する
await file.remove();
const exists = await get("my-app/example.txt");
console.log(exists); // null
```

## 次の章

[ディレクトリ操作](./directory-operations.md)を学習し、ディレクトリの走査と管理方法を理解しましょう。