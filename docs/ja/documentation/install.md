# インストール

NoneOS Core はブラウザベースのファイルシステムで、Service Worker を介してローカルストレージを実現する必要があります。プロジェクト自体は純粋に静的であり、動的サーバーは必要ありません。

## 前提条件

- 静的サーバー（http-server、live-server、nginxなど）
- ブラウザがService Workerをサポートしていること
- 外部アクセスする場合は、HTTPSの使用が必須です（APIの要件により）

## 手順

### 1. Service Worker ファイルの作成

プロジェクトのルートディレクトリに `sw.js` ファイルを作成し、以下の内容を入力します：

```javascript
importScripts("https://core.noneos.com/sw/dist.js");
```

### 2. エントリHTMLの作成

エントリー HTML ファイルに `ofa.js` と `nos-version` コンポーネントを導入します。`nos-version` コンポーネントを使用すると、`sw.js` ファイルが自動的に登録されます：

```html
<!DOCTYPE html>
<html lang="ja">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>My App</title>
    <script src="https://cdn.jsdelivr.net/gh/ofajs/ofa.js/dist/ofa.js"></script>
  </head>
  <body>
    <!-- nos-version コンポーネントをロード -->
    <l-m src="https://core.noneos.com/nos-tool/comps/nos-version.html"></l-m>
    <!-- nos-version コンポーネントを使用 -->
    <nos-version auto-install></nos-version>

    <script type="module">
      // インストール完了を待機
      $("nos-version").on("installed", () => {
        console.log("NoneOS Core のインストールが完了しました。使用を開始できます。");
        // ここで noneos-core を使用可能
      });
    </script>
  </body>
</html>
```

## インストールステータス

`nos-version`コンポーネントはNoneOS Coreのインストール状態を自動的に検出します：

- **未インストール**：「Install NoneOS Core」ボタンを表示
- **インストール中**：インストール進捗バーを表示
- **インストール済み**：現在のバージョン番号を表示
- **アップグレード可能**：アップグレードボタンを表示

システムのインストールが完了したとき、または既にインストールされている場合、またはアップグレードが成功したときに、`installed` イベントがトリガーされ、その後、NoneOS Core のすべての機能を正常に使用できるようになります。