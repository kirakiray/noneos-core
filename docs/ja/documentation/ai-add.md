# AIモデルを追加

## AIモデル管理エントリ

既にデプロイされた NoneOS システムにおいて、当該システムをベースに開発されたアプリケーションは、`o-page` コンポーネントを通じて AI モデルのキー管理ページを取り込むことができ、ユーザーがグラフィカルユーザーインターフェース（GUI）を用いて AI モデルを追加・管理できるようにします。

### 相対パスの使用

```html
<o-page src="/nos-tool/ai/pages/key-manager.html"></o-page>
```

これで、あなたの ofa.js アプリに AI モデルを追加する入り口を直接組み込むことができます。

## JSモデルの追加

`o-page` コンポーネントを使用せず、JavaScript コードで直接 AI モデルを管理することもできます。

### ストレージモジュールの導入

```javascript
import { storage } from "/gh/kirakiray/ever-cache/src/main.js";
```

### API キーを保存

```javascript
const newKey = {
  id: `${Math.random().toString(36).slice(2, 11)}`,
  provider: "deepseek",  // deepseek | kimi | minimax | glm
  model: "deepseek-chat",
  key: "your-api-key-here",
  concurrency: 1,  // 同時実行数
};

// 既存のキーを取得
const aiKeys = (await storage.getItem("ai-keys")) || [];

// 新しいキーを追加
aiKeys.push(newKey);

// 保存
await storage.setItem("ai-keys", aiKeys);
```

### 各プロバイダーで利用可能なモデル

利用可能なモデルについては各プロバイダーのドキュメントを参照してください。

### 保存されたすべてのキーを取得

```javascript
const aiKeys = (await storage.getItem("ai-keys")) || [];
```

### APIキーを削除

```javascript
const aiKeys = (await storage.getItem("ai-keys")) || [];
const index = aiKeys.findIndex((k) => k.id === "key-id");
if (index > -1) {
  aiKeys.splice(index, 1);
  await storage.setItem("ai-keys", aiKeys);
}
```

### キーの同時更新数

```javascript
const aiKeys = (await storage.getItem("ai-keys")) || [];
const keyItem = aiKeys.find((k) => k.id === "key-id");
if (keyItem) {
  keyItem.concurrency = 3;  // 並行数を変更
  await storage.setItem("ai-keys", aiKeys);
}
```

### Key オブジェクト構造

| 属性          | タイプ    | 説明                               |
| ------------- | ------- | ---------------------------------- |
| `id`          | string  | 一意識別子                         |
| `provider`    | string  | プロバイダー (deepseek/kimi/minimax/glm) |
| `model`       | string  | モデル名                           |
| `key`         | string  | APIキー                            |
| `concurrency` | number  | 最大同時実行数                     |
| `disabled`    | boolean | 無効にするかどうか                 |