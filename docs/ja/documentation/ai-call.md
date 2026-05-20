# AIモデルの呼び出し

## chatモジュールの導入

```javascript
import { chat, subscribe, getStatus, getAvailableProviders } from "/nos/ai/chat.js";
```

## 基本的な使用方法

`chat` 関数はメッセージ配列とオプションオブジェクトを受け取ります：

```javascript
const messages = [
  { role: "user", content: "你好" }
];

const response = await chat(messages, {
  provider: "deepseek",  // オプション、プロバイダーを指定
  callback: (chunk) => {  // オプション、ストリーム形式のコールバック
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

`provider` を指定しない場合、システムは自動的に利用可能な API キーを選択します。

## メッセージ形式

```javascript
const messages = [
  { role: "system", content: "あなたは役に立つアシスタントです" },
  { role: "user", content: "こんにちは" },
  { role: "assistant", content: "こんにちは、何かお手伝いできることはありますか？" },
  { role: "user", content: "AIとは何か説明してください" }
];
```

## 並行制御

NoneOS AI モジュールは並行制御をサポートしており、同一の API キーが過度に使用されるのを防ぐことができます。

### 現在の状態を取得

```javascript
const status = getStatus();
// 各キーの同時使用状況を返す
```

### サブスクリプション状態の変化

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

よくある間違い：- `no_key` - API キーが設定されていません
- `no_provider_key` - プロバイダーの API キーが指定されていません
- `concurrency_full` - このキーの同時実行数が上限に達しました
- `Unsupported provider` - サポートされていないプロバイダーです