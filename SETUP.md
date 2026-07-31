# セットアップ手順（オーナー本人が実施する作業）

第12章に従い、アカウント作成・トークン発行・権限付与は**すべて伊藤さんご本人**が操作してください。
所要時間の目安は 30〜40分。**費用は全工程ゼロ**です。

各手順の最後に「これができたらOK」の確認ポイントを付けています。

---

## 手順1｜GitHub にリポジトリを作る

1. https://github.com/new を開く
2. 以下のとおり入力する

   | 項目 | 設定 | 理由 |
   |---|---|---|
   | Repository name | `task-calendar`（何でも可） | URL に出ます |
   | 公開設定 | **Public（公開）** | GitHub Pages の無料枠は公開リポジトリのみ。だからこそ手順4-2の暗号化を推奨します |
   | Add a README file | チェックしない | こちらで用意済み |

3. **Create repository** を押す

✅ **確認ポイント**：`https://github.com/＜あなたのID＞/task-calendar` が開ける

---

## 手順2｜ファイルを置く

配布した `notion-lifebear.zip` を解凍し、中身をリポジトリに置きます。

**かんたんな方法（ブラウザだけ）**

1. 作ったリポジトリのページで **uploading an existing file** をクリック
2. 解凍したフォルダの**中身**（`docs` フォルダ、`scripts` フォルダ、`.github` フォルダ、`README.md` など）をまとめてドラッグ＆ドロップ
3. 下の **Commit changes** を押す

> ⚠️ `.github` フォルダは Mac の Finder では隠しファイル扱いです。Finder で `command + shift + .` を押すと表示されます。これが無いと自動同期が動きません。

✅ **確認ポイント**：リポジトリのトップに `docs` `scripts` `.github` が並んでいる

---

## 手順3｜Notion インテグレーションを作り、DBに接続する

### 3-1. インテグレーションを作る

1. https://www.notion.so/profile/integrations を開く
2. **New integration** を押す
3. 入力する
   - Name: `task-calendar`
   - Associated workspace: ご自身のワークスペース
   - Type: Internal
4. 作成後、**Configuration** タブの Capabilities を次のようにする

   | 項目 | 設定 |
   |---|---|
   | Read content | ✅ **オン** |
   | Update content | ❌ オフ |
   | Insert content | ❌ オフ |
   | User information | No user information |

   > 第12章のとおり、このアプリは Notion に書き戻しません。**読み取り専用**にしておけば、万一トークンが漏れても Notion のデータは書き換えられません。

5. **Secrets** タブの `Internal Integration Secret` を **Show → Copy**
   （`ntn_` または `secret_` で始まる文字列。**この画面は閉じずに手順4へ**）

### 3-2. タスクのDBに接続する

インテグレーションを作っただけでは、まだ何も読めません。DB側から「接続」する必要があります。

1. Notion で **🚀タスク管理シート** を開く
2. ページ下部の **【消さない！】元DB** のトグルを開く
3. その中の **タスクメモDB** を開く（これが「今日のタスク」「明日以降のタスク」の中身の実体です）
4. 右上の **•••** → **接続** → 一覧から `task-calendar` を選ぶ
5. 同じ手順で **プロジェクトDB** にも接続する（色分けにプロジェクト名を使うため）

✅ **確認ポイント**：タスクメモDB の ••• → 接続 に `task-calendar` が表示されている

> 💡 なぜ「タスクメモDB」なのか：APIで実物を確認したところ、**「今日のタスク」と「明日以降のタスク」は別々のDBではなく、この1つのDBのビュー（表示フィルタ違い）**でした。したがって接続先はこの1つで足ります。

---

## 手順4｜GitHub に秘密情報を登録する

リポジトリの **Settings** → 左メニュー **Secrets and variables** → **Actions** を開きます。

### 4-1. Notion トークン（必須）

1. **New repository secret** を押す
2. Name: `NOTION_TOKEN`
3. Secret: 手順3-1でコピーした文字列を貼り付け
4. **Add secret**

### 4-2. 合言葉（強く推奨）

手順1のとおりリポジトリは公開されるため、このままだとタスクの中身が誰でも読める状態になります。
合言葉を登録すると、公開されるファイルが暗号化されます。

1. **New repository secret** を押す
2. Name: `SYNC_PASSPHRASE`
3. Secret: **ご自身で決めた合言葉**（例：長めの日本語フレーズ。忘れると復旧できないのでメモを）
4. **Add secret**

> この合言葉は、アプリを新しい端末で開いたときに**1回だけ**聞かれます。以後その端末では聞かれません。

✅ **確認ポイント**：Secrets 一覧に `NOTION_TOKEN`（と `SYNC_PASSPHRASE`）が並んでいる

---

## 手順5｜自動同期を有効にする

1. Settings → **Actions** → **General** を開く
2. **Workflow permissions** を **Read and write permissions** に変更 → **Save**
   （生成した JSON をリポジトリに書き戻すために必要です）
3. 上部の **Actions** タブへ移動
4. 緑のボタン **I understand my workflows, go ahead and enable them** が出たら押す
5. 左の **Sync Notion → tasks.json** を選び、右の **Run workflow** → **Run workflow**
6. 1〜2分待って、実行結果が ✅ になることを確認

❌ になった場合はクリックしてログを開いてください。よくある原因は下の「困ったとき」を参照。

✅ **確認ポイント**：`docs/data/tasks.json` の更新日時が今になっている

以後は **30分ごとに自動実行**されます。急ぎのときは同じ画面の Run workflow か、アプリの ⟳ ボタンを押してください。

---

## 手順6｜Web公開（GitHub Pages）

1. Settings → 左メニュー **Pages**
2. Source: **Deploy from a branch**
3. Branch: **main** ／ フォルダ: **/docs** を選び **Save**
4. 1〜2分待つと、同じ画面の上部に URL が出ます

   ```
   https://＜あなたのID＞.github.io/task-calendar/
   ```

✅ **確認ポイント**：その URL をPCのブラウザで開くとカレンダーが表示される

---

## 手順7｜iPhone のホーム画面に置く

1. iPhone の **Safari**（Chromeではなく Safari）で上記URLを開く
2. 合言葉を設定した場合は入力する（この端末では次回から聞かれません）
3. 下部の **共有ボタン（□に↑）** → **ホーム画面に追加** → **追加**
4. ホーム画面のアイコンから起動する

✅ **確認ポイント**：アドレスバーが出ない全画面で起動し、機内モードでも前回の内容が表示される

iPad も同じ手順です。PC（Chrome/Edge）はアドレスバー右の **インストール** アイコンから同じことができます。

---

## 困ったとき

| 症状 | 原因と対処 |
|---|---|
| Actions が赤（❌）／`Notion API 404` | 手順3-2の「接続」ができていません。タスクメモDBの ••• → 接続 を再確認 |
| Actions が赤／`Notion API 401` | `NOTION_TOKEN` の貼り付けミス。前後の空白に注意して登録し直す |
| Actions が赤／`Permission denied` `403` | 手順5-2の Read and write permissions が未設定 |
| アプリは開くがタスクが0件 | 初回同期がまだ。Actions を手動実行 → アプリの ⟳ を押す |
| 「合言葉が違います」 | Secrets の `SYNC_PASSPHRASE` を変えた場合、アプリのメニュー ⋯ →「保存した合言葉を消去する」を押してから入れ直す |
| Notion で直した内容がアプリに出ない | 同期は最大30分間隔です。Actions を手動実行するか ⟳ を押す |
| アプリで消したタスクが復活した | 仕様どおりの動作です。Notion側でその項目に変更があると再取り込みされます（第7-2章） |
| 見た目が古いまま更新されない | アプリを一度閉じて開き直す（Service Worker の更新待ち）。それでも駄目ならメニュー ⋯ からバックアップを取り、Safariの履歴消去 |

---

## この先やっていないこと（第9章・第13章）

- チーム／複数人対応（フェーズ2）
- Notion への書き戻し（恒久的にやりません）
- プッシュ通知
- 端末間の相互同期（第8章 E-1）。ローカル追加した予定は端末ごとに独立です。
  メニュー ⋯ の「バックアップを書き出す／読み込む」で手動移送はできます。
- Lifebear のどの画面を特に再現するか（第13章-3）、色や締切表現の詰め（第13章-4）
  → 実物を触って気になった点をお知らせください。
