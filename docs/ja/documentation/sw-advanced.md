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

- **file-explore** - ファイルブラウザ：OPFS 仮想ファイルシステムを閲覧し、インポート/ダウンロード/削除や `/$path` でのアクセスが可能
- **system-info** - システム情報と更新管理：バージョンと SW の状態を確認し、システム全体の更新を実行
- **locale-text-tool** - 多言語テキスト抽出：`<locale-text>` をスキャンして `locale-text.json` を生成
- **rtc-tool** - WebRTC STUN/TURN サーバーリスト管理：到達性とレイテンシのテスト、並べ替え、有効/無効化

これらのツールは `nos-tool` ディレクトリにあり、必要に応じて導入して使用できます。