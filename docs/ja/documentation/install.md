# インストール

NoneOS Core はブラウザベースのファイルシステムで、Service Worker を通じてローカルストレージを実現する必要があります。プロジェクト自体は完全に静的であり、動的サーバーは不要です。

## 前提条件

- 静的サーバー（例: http-server、live-server、nginx など）
- ブラウザが Service Worker をサポートしていること
- 外部ネットワークからアクセスする場合は、HTTPS を使用する必要があります（API 要件のため）

## ステップ

### 1. Service Workerファイルの作成

プロジェクトのルートディレクトリに `sw.js` ファイルを作成し、以下の内容を記述してください:

```javascript
importScripts("https://core.noneos.com/sw/dist.js");
```

### 2. エントリー HTML の作成

エントリHTMLファイルに `ofa.js` と `nos-version` コンポーネントを導入します。`nos-version` コンポーネントを使用すると、自動的に `sw.js` ファイルが登録されます。

```html
<!DOCTYPE html>
<html lang="zh">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>My App</title>
    <script src="https://cdn.jsdelivr.net/gh/ofajs/ofa.js/dist/ofa.js"></script>
  </head>
  <body>
    <!-- nos-version コンポーネントを読み込む -->
    <l-m src="https://core.noneos.com/nos-tool/comps/nos-version.html"></l-m>
    <!-- nos-version コンポーネントを使用する -->
    <nos-version auto-install></nos-version>

    <script type="module">
      // インストール完了を待つ
      $("nos-version").on("installed", () => {
        console.log("NoneOS Core のインストールが完了しました。使用を開始できます");
        // ここで noneos-core を使用できます
      });
    </script>
  </body>
</html>
```

## インストール状態

`nos-version` コンポーネントは、NoneOS Core のインストール状態を自動的に検出します：

- **未インストール**：「Install NoneOS Core」ボタンを表示
- **インストール中**：インストール進捗バーを表示
- **インストール済み**：現在のバージョン番号を表示
- **アップグレード可能**：アップグレードボタンを表示

システムのインストールが完了したとき、または既にインストールされているとき、またはアップグレードが成功したときに、`installed`イベントがトリガーされ、その後でNoneOS Coreのすべての機能を正常に使用できます。