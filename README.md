# おすすめリスト（読書・飲食店 同期リスト）

GAS × HTML で作った自作の「おすすめリスト」アプリ。PC（Cursor）とスマホ（Pixel / PWA）の間で、
読書リストの読了チェック・感想、飲食店リストの「行った！」チェック・感想（myReview）を、
Google スプレッドシート（GAS）経由でリアルタイムに双方向同期する。

## 構成

```
ブラウザ / スマホPWA  <-- fetch(doGet/doPost) -->  GAS(WebアプリURL)  <-->  スプレッドシート(BookState)
```

| 部分 | 実体 | 管理 |
|---|---|---|
| 画面（フロント） | `public/おすすめリスト.html`（単一HTML + Vanilla JS） | このリポジトリ（Git） |
| バックエンド | Google Apps Script（WebアプリとしてデプロイずみのURL） | Google側（必要なら clasp で別途Git化可） |
| データベース | Google スプレッドシート（シート名 `BookState`） | Google側 |

- フロントは `public/おすすめリスト.html` 内の `GAS_URL`（`https://script.google.com/macros/s/.../exec`）宛てに
  fetch するだけの静的ファイル。HTMLはどこに置いても動く（データの実体はGAS+スプレッドシート側）。

## データ構造（キーの命名規則）

- 本（Book）: 数値キー（例 `2001`） → `{ r, s, m }`（読了 / ステータス / 読書メモ）
- 店（Shop）: `i_` + ID（例 `i_1735123456789`） → `{ v, m }`（行った！ / myReview）
- 店オブジェクトは `JSON.stringify()` して保存、`doGet` 時に `JSON.parse()` で復元する。
- `_ts`（タイムスタンプ）でローカルとクラウドの新しい方を判定し、先祖返りを防止。

## 編集と反映

1. `public/おすすめリスト.html` を編集
2. `git add . && git commit -m "..."`
3. `git push`

> 公開ホスティング（スマホPWA用のhttps URL）を GitHub Pages 等にする場合は、push で本番反映できる。
> 設定する際はこの README に手順を追記すること。

## バックアップの鉄則

大きな機能変更（実験）の前は、必ずブランチを切るかコミットしてから着手する。
旧来は `_同期成功版.html` を手動退避していたが、Git管理後はコミット/ブランチがその役割を担う。
