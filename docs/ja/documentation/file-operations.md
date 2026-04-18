# ファイル操作

このドキュメントでは、ファイルシステムにおけるファイル操作について説明します。これには、ファイルの作成、書き込み、読み取り、削除が含まれます。

## ファイルを作成する

`get` メソッドを使用し、`create: "file"` を指定してファイルを作成します：

```javascript
import { get } from "/nos/fs/main.js";

const file = await get("my-app/path/to/file.txt", { create: "file" });
```

## ファイルへの書き込み

`write` メソッドを使用してファイルに内容を書き込む：

```javascript
const file = await get("my-app/hello.txt", { create: "file" });
await file.write("こんにちは、世界！");
```

`write` メソッドは、文字列または Blob データの書き込みをサポートします。

## ファイルを読み込む

### text() メソッド

`text()` メソッドを使用してファイルのテキスト内容を読み取る：

```javascript
const content = await file.text();
console.log(content); // "Hello, World!"
```

### file() メソッド

`file()` メソッドを使用して元の [File オブジェクト](https://developer.mozilla.org/zh-CN/docs/Web/API/File) を読み取ります：

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

`read()` メソッドは低レベルの読み取りメソッドであり、より多くのオプションをサポートしています：

```javascript
const content = await file.read({
  type: "text",    // 戻り値の種類: "text" | "file" | "buffer"
  start: 0,        // 開始バイト
  end: 100,        // 終了バイト
});
```

## JSON 操作

### json() メソッド

`json()` メソッドを使用して直接 JSON ファイルを読み取り、解析します：

```javascript
const data = await file.json();
```

### base64() メソッド

`base64()` メソッドを使用してファイルの内容を [base64](https://developer.mozilla.org/zh-CN/docs/Glossary/Base64) エンコードに変換します)：

```javascript
const base64String = await file.base64();
console.log(base64String); // "data:application/octet-stream;base64,..."
```

## ファイル情報を取得する

### lastModified() メソッド

`lastModified()` を使用してファイルの最終更新時間を取得します：

```javascript
const timestamp = await file.lastModified();
console.log(new Date(timestamp)); // Date オブジェクト
```

### size 属性

`file()` メソッドでファイルサイズを取得：

```javascript
const fileObj = await file.file();
console.log(fileObj.size); // ファイルサイズ（バイト）
```

## fetch を使ってファイルを取得する

ハンドルを使用する以外にも、ファイルを書き込んだ後、ブラウザの `fetch` API を使って URL 経由でファイルの内容を取得できます：

```javascript
const file = await get("my-app/file1.txt", { create: "file" });
const someText = "Write some text " + Math.random();
await file.write(someText);

await new Promise((resolve) => setTimeout(resolve, 300));

const content = await fetch("/$my-app/file1.txt").then((e) => e.text());
```

### HTMLファイルをプレビュー

HTMLファイルに書き込んだ場合、ブラウザで直接プレビューできます：

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

// ファイル情報を取得
const fileInfo = await file.file();
console.log(`ファイル名: ${fileInfo.name}, サイズ: ${fileInfo.size}`);

// 最終更新日時を取得
const modified = await file.lastModified();
console.log(`最終更新: ${new Date(modified)}`);

// ファイルを削除
await file.remove();
const exists = await get("my-app/example.txt");
console.log(exists); // null
```

## 次章

[ディレクトリ操作](./directory-operations.md)を学び、ディレクトリを走査・管理する方法を理解します。