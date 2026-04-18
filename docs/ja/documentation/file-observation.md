# ファイル変更監視

このドキュメントでは、`observe` メソッドを使用してファイルやディレクトリの変更イベントを監視する方法について説明します。

## 基本的な使い方

`observe()` メソッドを使用してファイルまたはディレクトリの変更を監視します：

```javascript
import { get } from "/nos/fs/main.js";

const dir = await get("my-app");

const events = [];
const unobserve = await dir.observe((event) => {
  console.log("ファイル変更イベントを受信しました:", event);
  events.push(event);
});

// ファイルを作成
const file = await dir.get("test.txt", { create: "file" });
await file.write("Hello");

// ファイルを削除
await file.remove();

// 監視を解除
unobserve();
```

ファイルとディレクトリの両方とも変化を監視できます。たとえば、単一のファイルを監視するには：

```javascript
const file = await get("my-app/test.txt", { create: "file" });

const unobserve = await file.observe((event) => {
  console.log("ファイルが変更されました:", event.type);
});

await file.write("new content");

unobserve();
```

## observe 戻り値

`observe()` は Promise を返し、これは resolve すると監視を解除する関数となる。この関数を呼び出すとリスニングを停止できる：

```javascript
const unobserve = await dir.observe((event) => {
  // イベントを処理
});

// 後で監視を解除
unobserve();
```

## イベントオブジェクト

観測コールバックが受信するイベントオブジェクトには以下の属性が含まれます：

| 属性 | 説明 |
|------|------|
| `type` | イベントタイプ。例: `"create"`, `"remove"`, `"write"` |
| `path` | 変更が発生したファイルパス |## 完全な例

```javascript
import { get } from "/nos/fs/main.js";

const dir = await get("my-app");

console.log("ファイル変更監視テストを開始します");

const events = [];
const unobserve = await dir.observe((event) => {
  console.log("ファイル変更:", event.type, event.path);
  events.push(event);
});

// いくつかのファイル操作を実行
await dir.get("file1.txt", { create: "file" });
await (await dir.get("file1.txt")).write("content");

await new Promise((resolve) => setTimeout(resolve, 100));

await (await dir.get("file1.txt")).remove();

await new Promise((resolve) => setTimeout(resolve, 100));

unobserve();

console.log(`合計 ${events.length} 個のイベントを受信しました`);
```

## 注意事項

1. オブザーバーは作成後に監視を開始し、それ以前のファイル操作はキャプチャされません
2. 監視をキャンセルすると、新たに発生するファイル変更は記録されません
3. ファイル変更イベントは非同期でトリガーされ、一定の遅延が発生する可能性があります