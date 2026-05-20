# ファイル変更監視

このドキュメントでは、`observe` メソッドを使用してファイルまたはディレクトリの変更イベントを監視する方法について説明します。

## 基本的な使用方法

`observe()` メソッドを使用してファイルまたはディレクトリの変更を監視します。

```javascript
import { get } from "/nos/fs/main.js";

const dir = await get("my-app");

const events = [];
const unobserve = await dir.observe((event) => {
  console.log("ファイル変更イベントを受信:", event);
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

ファイルとディレクトリの両方で変更を監視できます。例えば、単一ファイルを監視する場合：

```javascript
const file = await get("my-app/test.txt", { create: "file" });

const unobserve = await file.observe((event) => {
  console.log("ファイルが修正されました:", event.type);
});

await file.write("new content");

unobserve();
```

## observe 戻り値

`observe()` は Promise を返し、監視を解除する関数に解決されます。その関数を呼び出すと監視を停止できます：

```javascript
const unobserve = await dir.observe((event) => {
  // イベントを処理する
});

// 後で監視を解除する
unobserve();
```

## イベントオブジェクト

オブザーバーコールバックで受け取るイベントオブジェクトには、次のプロパティが含まれています：

| プロパティ | 説明 |
|------|------|
| `type` | イベントの種類。例: `"create"`, `"remove"`, `"write"` |
| `path` | 変更が発生したファイルのパス |## 完全な例

```javascript
import { get } from "/nos/fs/main.js";

const dir = await get("my-app");

console.log("ファイル変更監視テスト開始");

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

console.log(`合計 ${events.length} 件のイベントを受信`);
```

## 注意事項

1. オブザーバーが作成されてから監視が開始され、それ以前のファイル操作はキャプチャされません
2. 監視を解除すると、その後に発生したファイルの変更は記録されません
3. ファイル変更イベントは非同期で発生するため、ある程度の遅延が生じる可能性があります