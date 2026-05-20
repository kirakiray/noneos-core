# sw.js 設定のテクニック

## バージョン番号制御とキャッシュ更新

新しいバージョンをリリースする際、サーバーが `max-age=0` レスポンスヘッダーを設定していても、ブラウザは古いバージョンの `sw.js` ファイルをキャッシュする可能性があり、更新がすぐに反映されないことがあります。URL にバージョンパラメータを追加することで、ブラウザに最新のファイルを強制的にリクエストさせ、この問題を解決できます。

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

dist.js を参照する際に `?v=` パラメータを追加し、新バージョンをリリースするたびにバージョン番号を更新すると、ブラウザはキャッシュを使用せずに新しいファイルをリクエストするようになります。

## 公式ツール

`nos-tool` ディレクトリにあるツールを使用することで、NoneOS システムを簡単に管理できます。

- **ai** - AIモデル管理、チャット、設定、キー管理を含む
- **editor** - Monacoエディター統合、コードハイライト、フォーマット、AI補完をサポート
- **file-explore** - ファイルブラウザ
- **file-list** - ファイルリストビューとハンドル管理
- **studio** - 開発スタジオ、ファイル管理、カラーツール、テーマ編集などの機能を提供

これらのツールは `nos-tool` ディレクトリにあり、必要に応じて導入して使用できます。