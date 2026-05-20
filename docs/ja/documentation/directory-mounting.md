# ディレクトリのマウント

ディレクトリマウント機能により、ユーザーのローカルファイルシステム上の**実際のディレクトリ**にアクセスし、それを永続化ストレージに保存して、後続のセッションでも継続して使用できるようになります。

> **実際のディレクトリ**：あなたの **Windows** / **macOS** / **Linux** システム上の実際のフォルダーを指し，仮想ファイルシステム内のディレクトリとは区別されます。

## 重要なお知らせ

### ブラウザ対応状況

`open()` メソッドはブラウザの `showDirectoryPicker` API に依存しており、現在のところ**Chrome ブラウザのみがこの機能を完全にサポート**しています。

```javascript
// ブラウザのサポートを確認する
if (!window.showDirectoryPicker) {
  console.error("現在のブラウザはディレクトリ選択機能をサポートしていません");
  console.log("完全な機能を得るには Chrome ブラウザを使用してください");
  return;
}
```

### 核心用途

ディレクトリマウントの主な用途は、`open()` と連携してユーザーのローカルファイルシステムにアクセスすることです：

1. **ローカルファイルアクセス**：ユーザーがローカルディレクトリを選択し、ブラウザを通じてファイル内容に直接アクセスできる
2. **静的サーバー機能**：マウントされたローカルディレクトリはHTTPリクエスト経由でアクセス可能となり、ローカル静的サーバーと同様の機能を実現
3. **永続的なアクセス**：`mount()` でマウントすると、後続のセッションでも同じローカルディレクトリにアクセスし続けることができ、再選択が不要

**注意**：`init()` で作成された仮想ファイルシステムディレクトリは、自動的に HTTP アクセスがサポートされるため、`mount()` を使用する必要はありません。

### 典型的な応用シーン

- ローカルプロジェクト開発：ブラウザ上で直接ローカルプロジェクトファイルにアクセスし編集する
- 静的リソースサービス：ローカルディレクトリをアクセス可能な静的リソースパスとしてマウントする
- ファイル管理ツール：ブラウザベースのファイル管理アプリケーションを構築する

## 基本概念

### open() - ディレクトリセレクタを開く

`open()` メソッドはシステムのディレクトリ選択ダイアログを表示し、ユーザーにローカルディレクトリを選択させます：

```javascript
import { open } from "/nos/fs/main.js";

const handle = await open();
```

ユーザーがディレクトリを選択すると、システムは読み取り/書き込み権限を要求します。ユーザーが権限を付与すると、`DirHandle` オブジェクトが返されます。

**注意**：`open()` はユーザーのローカルファイルシステムへのアクセスにのみ使用されます。仮想ファイルシステムのディレクトリには、`init()` を使用して作成してください。

### mount() - ディレクトリをマウント

`mount()` メソッドはローカルディレクトリハンドルを保存し、後続のセッションで再アクセスできるようにします：

```javascript
import { open, mount } from "/nos/fs/main.js";

const handle = await open(); // ディレクトリ選択を開き、この時点での path は仮想パスです
await mount(handle); // マウント後、path は $mount-{id}>ディレクトリ名 になります

console.log(handle.path); // 出力: $mount-123>ディレクトリ名
```

マウント後のパスの形式：`$mount-{id}>ディレクトリ名`

#### 二段階プロセスの利点

二段階の流れ（最初に `open()` してから `mount()` する）を推奨します。一度にマウントする方法は避けてください：

1. **ディレクトリ内容の確認**：マウント前にディレクトリ内容を閲覧し、必要なディレクトリかどうか確認できます。
2. **誤ったマウントの防止**：ユーザーが誤ったディレクトリを選択して、誤ってシステムにマウントするのを防ぎます。
3. **柔軟な判断**：ディレクトリ内容に基づいて、マウントするかどうかを判断できます。

```javascript
const handle = await open();

// まずディレクトリの内容を検証する
const packageJson = await handle.get("package.json");
const data = await packageJson.json();
if (data.somedata) {
  // 条件に一致するディレクトリであることを確認してから、マウントする
  await mount(handle);
  console.log("条件に一致するディレクトリがマウントされました:", handle.path);
} else {
  console.log("これは条件に一致しないディレクトリです。マウントをキャンセルします");
}
```

**重要**：

- `mount()` は主に `open()` で開いたローカルディレクトリを永続化するために使用されます
- `init()` で作成された仮想ファイルシステムディレクトリには、`mount()` を使用する必要はありません

### 一括で開いてマウント

`open()` の `mount` パラメータを使用すると、ディレクトリを選択した後に自動的にマウントできます：

```javascript
import { open } from "/nos/fs/main.js";

const handle = await open({ mount: true });
// 同等の意味：
// const handle = await open();
// await mount(handle);
```

## mount() の主な用途

`mount()` メソッドは主に `open()` と組み合わせて使用し、ユーザーが選択したローカルディレクトリを永続的に保存します。**`init()` によって作成された仮想ファイルシステムディレクトリについては、`mount()` を使用する必要はありません**。

### 仮想ファイルシステムディレクトリ（マウント不要）

`init()` によって作成されたディレクトリは、すでに HTTP 経由で直接アクセス可能です：

```javascript
import { init } from "/nos/fs/main.js";

// 仮想ファイルシステムのディレクトリを作成
const dir = await init("my-app");
await dir.get("test.txt", { create: "file" });

// $rootdirName を通じて直接アクセス
const response = await fetch("/$my-app/test.txt");
const content = await response.text();
```

これらのディレクトリパスの形式は `$ディレクトリ名` で、マウントせずに HTTP 経由でアクセスできます。

### ローカルディレクトリ（マウントが必要）

`open()` で開いたローカルディレクトリは、永続的にアクセスするためにマウントする必要があります。

```javascript
import { open, mount } from "/nos/fs/main.js";

// ユーザーのローカルディレクトリを開く
const handle = await open();

// 後続のセッションで引き続きアクセスするにはマウントが必要です
await mount(handle);

// マウント後、$mount-{id}>ディレクトリ名 でアクセスできます
const response = await fetch(`/${handle.path}/file.txt`);
```

### 2つのディレクトリの比較

| 機能           | バーチャルファイルシステムディレクトリ   | ローカルディレクトリ（マウント）      |
| -------------- | ---------------------------------------- | -------------------------------------- |
| 作成方法       | `init("dir-name")`                       | `open()` + `mount()`                   |
| パス形式       | `$dir-name`                              | `$mount-{id}>dir-name`                 |
| HTTP アクセス  | ✅ 直接サポート                         | ✅ マウント後にサポート               |
| 永続化         | ✅ 自動永続化                           | ✅ マウントによる永続化が必要         |
| データの保存場所 | ブラウザストレージ                      | ユーザーのローカルファイルシステム    |
| マウントの要否 | ❌ 不要                                 | ✅ 必要                               |
| ブラウザサポート | すべてのモダンブラウザ                 | Chromeのみ                             |## マウント済みディレクトリの管理

### マウント済みディレクトリ一覧の取得

`getMounted()`を使用して、マウントされているすべてのディレクトリを取得します：

```javascript
import { getMounted } from "/nos/fs/main.js";

const mountedDirs = await getMounted();

mountedDirs.forEach((item) => {
  console.log(item.id); // マウントID
  console.log(item.name); // ディレクトリ名
  console.log(item.path); // マウントパス
  console.log(item.handle); // DirHandle オブジェクト
});
```

### アンインストールディレクトリ

`unmount()` を使用して、マウント済みのディレクトリを削除します。このメソッドは、2 種類のパラメータ型をサポートしています。

#### 方法1：IDによるアンインストール

```javascript
import { unmount } from "/nos/fs/main.js";

await unmount(mountId);
```

#### 方法 2：ハンドルオブジェクトによるアンロード（推奨）

```javascript
import { open, mount, unmount } from "/nos/fs/main.js";

const handle = await open({ mount: true });
// handleを使用...

// handleオブジェクトを直接使用してアンマウント
await unmount(handle);
```

#### マウントリストからアンマウントする

```javascript
import { getMounted, unmount } from "/nos/fs/main.js";

const mounted = await getMounted();
for (const item of mounted) {
  // ハンドルオブジェクトを使用してアンマウント
  await unmount(item.handle);

  // またはIDを使用してアンマウント
  // await unmount(item.id);
}
```

アンインストール後、このディレクトリにはマウントパスからアクセスできなくなります。

**注意**：アンマウントできるのは、マウント済みの handle（パスが `$mount-` で始まるもの）のみです。マウントされていない handle をアンマウントしようとするとエラーが発生します。

## マウントパスを介したファイルアクセス

### get() メソッドの使用

マウント後のディレクトリはマウントパスを通じてアクセスできます：

```javascript
import { get } from "/nos/fs/main.js";

// マウントされたパスが $mount-123>my-project であると仮定します
const file = await get("$mount-123>my-project/src/index.js");
const content = await file.text();
```

### サブディレクトリにアクセスする

```javascript
const subdir = await get("$mount-123>my-project/src");
const files = await subdir.values();

for await (const file of files) {
  console.log(file.name);
}
```

## HTTPでマウントファイルにアクセス（静的サーバー機能）

マウント後のディレクトリはHTTPリクエストを通じてファイルにアクセスでき、ローカル静的サーバーのような機能を実現します。これはディレクトリマウントの核心機能の一つです。

### 基本的な使い方

```javascript
import { open, mount } from "/nos/fs/main.js";

const handle = await open({ mount: true });

// テストファイルを作成
const testFile = await handle.get("test.txt", { create: "file" });
await testFile.write("Hello, World!");

// HTTP 経由でアクセス (静的サーバーのように)
const response = await fetch(`/${handle.path}/test.txt`);
const content = await response.text();
console.log(content); // 出力: Hello, World!
```

### 実践的な応用例

```javascript
// ローカルプロジェクトディレクトリをマウント
const projectHandle = await open({ mount: true });

// これでHTTP経由でプロジェクト内の任意のファイルにアクセス可能
const htmlResponse = await fetch(`/${projectHandle.path}/index.html`);
const htmlContent = await htmlResponse.text();

const jsResponse = await fetch(`/${projectHandle.path}/src/app.js`);
const jsContent = await jsResponse.text();

const cssResponse = await fetch(`/${projectHandle.path}/styles/main.css`);
const cssContent = await cssResponse.text();

// まるでローカルの静的サーバーにアクセスしているかのように
```

### 応用シーン

- **ローカル開発サーバー**：Node.jsサーバーを起動せずに、ブラウザで直接ローカルファイルにアクセス
- **プロジェクトプレビュー**：ローカルのHTML/CSS/JSプロジェクトをリアルタイムでプレビュー
- **リソースの読み込み**：Webアプリでローカルの画像、フォントなどのリソースを読み込む

## 完全な例

### プロジェクトを作成してマウントする

```javascript
import { open, mount, getMounted, unmount } from "/nos/fs/main.js";

// ディレクトリ選択ダイアログを開く
const handle = await open();

// マウント済みかどうかを確認
const mounted = await getMounted();
const existing = mounted.find((item) => item.name === handle.name);

if (existing) {
  console.log("ディレクトリは既にマウントされています:", existing.path);
} else {
  // ディレクトリをマウント
  await mount(handle);
  console.log("ディレクトリは既にマウントされています:", handle.path);
}

// マウントされたディレクトリを使用
const packageJson = await handle.get("package.json");
if (packageJson) {
  const config = await packageJson.json();
  console.log("プロジェクト名:", config.name);
}
```

### 複数のマウントディレクトリの管理

```javascript
import { getMounted, unmount } from "/nos/fs/main.js";

// すべてのマウントを取得
const allMounts = await getMounted();

// 特定のプロジェクトをフィルタリング
const projects = allMounts.filter((item) => item.name.includes("project"));

// 古いプロジェクトをアンマウント
for (const project of projects) {
  if (project.time < Date.now() - 30 * 24 * 60 * 60 * 1000) {
    await unmount(project.handle);
    console.log("アンマウントしました:", project.name);
  }
}
```

## 権限管理

### 権限の確認とリクエスト

ブラウザは初回アクセス時に権限をリクエストします。権限が拒否されたか期限切れになった場合、再度リクエストする必要があります：

```javascript
import { get } from "/nos/fs/main.js";

try {
  const handle = await get("$mount-123>my-project");
  // handle を使用
} catch (error) {
  if (error.message.includes("Permission denied")) {
    console.log("再認証が必要です");
    // ユーザーにディレクトリの再選択を促す
  }
}
```

## ブラウザ互換性

### 対応状況

- ✅ Chrome 86+ / Edge 86+  - **完全サポート**（推奨）
- ⚠️ Firefox 111+ - **非サポート** `showDirectoryPicker`、ただし仮想ディレクトリのマウントは可能
- ❌ Safari - **非サポート** `showDirectoryPicker`、仮想ディレクトリのマウントも不可

### コア機能の説明

**`open()` メソッド**は `showDirectoryPicker` API に依存しており、今のところ Chrome のみの機能です：

- **Chrome**：完全サポート、ディレクトリ選択ダイアログを表示し、ハンドルを永続的に保存可能
- **その他のブラウザ**：ディレクトリ選択機能はサポートされておらず、`open()` メソッドを使用できません

### 推奨使用方法

```javascript
import { open, mount } from "/nos/fs/main.js";

// ブラウザのサポートを検出する
if (!window.showDirectoryPicker) {
  alert("この機能は Chrome ブラウザのサポートが必要です");
  return;
}

// Chrome で使用する
const handle = await open({ mount: true });
console.log("ローカルディレクトリをマウントしました:", handle.path);

// HTTP 経由でローカルファイルにアクセスする
const response = await fetch(`/${handle.path}/index.html`);
const content = await response.text();
```

### Safariは完全に非対応

Safari は `showDirectoryPicker` API をサポートしておらず、`FileSystemHandle` を IndexedDB に保存することもサポートしていない：

```javascript
// Safari では使用できません
const handle = await open(); // ❌ エラー: showDirectoryPicker はサポートされていません
```

### ブラウザのサポートを検出する

```javascript
const isFileSystemSupported = !!window.showDirectoryPicker;

if (!isFileSystemSupported) {
  console.log("現在のブラウザはディレクトリ選択機能をサポートしていません");
  console.log("完全な機能を利用するには Chrome ブラウザを使用してください");
}
```

## ベストプラクティス

1. **ブラウザ検出**：使用前にブラウザが `showDirectoryPicker` をサポートしているかを検出する
2. **ユーザーへの通知**：この機能にはChromeブラウザが必要であることを明示的にユーザーに伝える
3. **エラーハンドリング**：権限拒否やディレクトリが存在しないケースの処理
4. **古いマウントのクリーンアップ**：不要になったマウントディレクトリを定期的にクリーンアップする
5. **静的サーバー機能**：HTTPアクセス機能を活用し、ローカルファイルサービスを実現する

### 推奨される完全な実装

```javascript
import { open, mount, getMounted, unmount } from "/nos/fs/main.js";

async function setupLocalProject() {
  // 1. ブラウザのサポートを検出
  if (!window.showDirectoryPicker) {
    alert(
      "この機能にはChromeブラウザが必要です。\n\n完全なローカルファイルアクセス機能を利用するにはChromeブラウザを使用してください。",
    );
    return null;
  }

  try {
    // 2. ディレクトリを開いてマウント
    const handle = await open({ mount: true });

    // 3. 有効なプロジェクトかどうかを検証
    const packageJson = await handle.get("package.json");
    if (!packageJson) {
      console.warn("選択したディレクトリは有効なプロジェクトではありません");
    }

    console.log("ローカルプロジェクトがマウントされました：", handle.path);
    console.log("HTTPでアクセス可能：", `/${handle.path}/`);

    return handle;
  } catch (error) {
    if (error.message.includes("Permission denied")) {
      alert("この機能を使用するにはディレクトリアクセス許可が必要です");
    } else {
      console.error("マウント失敗：", error);
    }
    return null;
  }
}

// 使用例
const projectHandle = await setupLocalProject();
if (projectHandle) {
  // HTTP経由でローカルファイルにアクセス
  const response = await fetch(`/${projectHandle.path}/README.md`);
  const readme = await response.text();
  console.log(readme);
}
```

## 次の章

[ファイル操作](./file-operations.md)を学習し，ファイルの読み書きと削除の方法を理解する