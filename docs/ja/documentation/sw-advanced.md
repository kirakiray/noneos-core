# sw.js 設定のコツ

## バージョン番号管理とキャッシュ更新

新しいバージョンをリリースする際、サーバーが `max-age=0` レスポンスヘッダーを設定していたとしても、ブラウザは古いバージョンの `sw.js` ファイルをキャッシュすることがあり、アップデートがすぐに反映されない場合があります。URL にバージョンパラメータを追加することで、ブラウザに最新のファイルを強制的にリクエストさせ、この問題を解決できます。

```javascript
let version = "";
if (globalThis.serviceWorker) {
  const urlParams = new URLSearchParams(
    new URL(serviceWorker.scriptURL).search,
  );
  version = urlParams.get("v") || "";
} else {
  const urlParams = new URLSearchParams(new URL(location.href).search);
  version = urlParams.get("v") || "";
}

importScripts("https://core.noneos.com/sw/dist.js?v=" + version);
```

dist.js を引用する際に `?v=` パラメータを付け、新しいバージョンをリリースするたびにバージョン番号を更新すると、ブラウザはキャッシュを使わずに新しいファイルをリクエストします。

## 公式ツール

`nos-tool` ディレクトリ内のツールを使用すると、NoneOS システムを簡単に管理できます。

- **ai** - AI モデル管理、チャット、設定、キー管理を含む
- **editor** - Monaco エディター統合、コードハイライト、フォーマット、AI 補完をサポート
- **file-explore** - ファイルエクスプローラー
- **file-list** - ファイルリストビューとハンドル管理
- **studio** - 開発スタジオ、ファイル管理、カラーツール、テーマ編集などの機能を提供

これらのツールは `nos-tool` ディレクトリにあり、必要に応じてインポートして使用できます。