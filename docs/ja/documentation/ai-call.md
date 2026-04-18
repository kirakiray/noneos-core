# AIモデルを呼び出す

## chat モジュールの導入

```javascript
import { chat, subscribe, getStatus, getAvailableProviders } from "/nos/ai/chat.js";
```

## 基本的な使い方

`chat` 関数はメッセージ配列とオプションオブジェクトを受け取ります：

```javascript
const messages = [
  { role: "user", content: "こんにちは" }
];

const response = await chat(messages, {
  provider: "deepseek",  // オプション、プロバイダを指定
  callback: (chunk) => {  // オプション、ストリーミングコールバック
    console.log(chunk);
  },
  maxContextLength: 8192  // オプション、最大コンテキスト長
});
```

## サポートされているプロバイダー

- **deepseek** - DeepSeek
- **kimi** - Kimi (Moonshot)
- **minimax** - MiniMax
- **glm** - 智譜 GLM

`provider`を指定しない場合、システムは利用可能なAPI Keyを自動的に選択します。

## メッセージ形式

```javascript
const messages = [
  { role: "system", content: "あなたは役立つアシスタントです" },
  { role: "user", content: "こんにちは" },
  { role: "assistant", content: "こんにちは、何かお手伝いできますか？" },
  { role: "user", content: "AIとは何かを説明してください" }
];
```

## 並行制御

NoneOS AIモジュールは並行制御をサポートし、同じAPIキーが過度に使用されることを防げます。

### 現在の状態を取得

```javascript
const status = getStatus();
// 各キーの同時使用状況を返す
```

### 購読ステータスの変化

```javascript
subscribe((newStatus) => {
  console.log("状態更新:", newStatus);
});
```

## 利用可能なプロバイダーの取得

```javascript
const providers = await getAvailableProviders();
console.log(providers); // ["deepseek", "kimi", "glm", "minimax"]
```

## エラー処理

```javascript
try {
  const response = await chat(messages);
} catch (error) {
  console.error(error.message);
}
```

よくあるエラー：- `no_key` - APIキーが設定されていません
- `no_provider_key` - プロバイダーのAPIキーが指定されていません
- `concurrency_full` - このキーの同時実行数が満杯です
- `Unsupported provider` - サポートされていないプロバイダー