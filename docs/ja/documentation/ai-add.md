# AIモデルの追加

## AIモデル管理エントリー

デプロイ済みのNoneOSシステムでは、このシステムに基づいて開発されたアプリケーションは、`o-page`コンポーネントを通じてAIモデルのキー管理ページを導入することができ、ユーザーがグラフィカルユーザーインターフェース（GUI）でAIモデルを追加および管理できるようにします。

### 相対パスを使用する

```html
<o-page src="/nos-tool/ai/pages/key-manager.html"></o-page>
```

これであなたのofa.jsアプリケーションにAIモデルを追加するためのエントリーを直接組み込むことができます。

## jsでモデルを追加

あなたは `o-page` コンポーネントを使用せず、JavaScript コードで直接 AI モデルを管理することができます。

### ストレージモジュールの導入

```javascript
import { storage } from "/gh/kirakiray/ever-cache/src/main.js";
```

### API Key を保存する

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

### 各プロバイダーの利用可能なモデル

利用可能なモデルについては、各プロバイダーのドキュメントを参照してください。

### 保存済みのすべてのキーを取得する

```javascript
const aiKeys = (await storage.getItem("ai-keys")) || [];
```

### APIキーの削除

```javascript
const aiKeys = (await storage.getItem("ai-keys")) || [];
const index = aiKeys.findIndex((k) => k.id === "key-id");
if (index > -1) {
  aiKeys.splice(index, 1);
  await storage.setItem("ai-keys", aiKeys);
}
```

### Key の同時実行数を更新する

```javascript
const aiKeys = (await storage.getItem("ai-keys")) || [];
const keyItem = aiKeys.find((k) => k.id === "key-id");
if (keyItem) {
  keyItem.concurrency = 3;  // 同時実行数を変更
  await storage.setItem("ai-keys", aiKeys);
}
```

### Key オブジェクト構造

| 属性          | 类型    | 説明                               |
| ------------- | ------- | ---------------------------------- |
| `id`          | string  | 一意の識別子                         |
| `provider`    | string  | プロバイダー (deepseek/kimi/minimax/glm) |
| `model`       | string  | モデル名                           |
| `key`         | string  | API Key                            |
| `concurrency` | number  | 最大同時実行数                         |
| `disabled`    | boolean | 無効化されているかどうか                           |