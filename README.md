# Notion同期型 スケジュールアプリ（マイルストーン1）

「引き継ぎ仕様書｜Notion同期型 Lifebear風スケジュールアプリ（M1）」の実装。

**セットアップ手順は [SETUP.md](SETUP.md) を参照。**（オーナーが手を動かす部分の完全ガイド）

---

## 構成（第4章）

```
Notion（母艦・読み取り専用）
      │  Notion API（読み取りのみ）
      ▼
GitHub Actions（30分ごと・無料）  scripts/sync-notion.mjs
      │  指紋付き JSON を生成 →（合言葉があればAES-256-GCMで暗号化）→ コミット
      ▼
GitHub Pages（無料・永久）        docs/ を配信
      │
      ▼
PWA（iPhone / PC / タブレット）   編集は IndexedDB に保存＝オフライン動作
```

Notion への書き戻し処理はコード上に**存在しません**（第2章）。

## ファイル

| パス | 役割 |
|---|---|
| `scripts/sync-notion.mjs` | 取り込みバッチ。Notion読み取り → 指紋計算 → `docs/data/tasks.json` 生成 |
| `scripts/make-sample.mjs` | Notion接続前でも画面を確認できるサンプルデータ生成 |
| `.github/workflows/sync.yml` | 30分ごとの定期実行＋手動実行 |
| `docs/js/core.js` | **第7章の同期ロジック本体**（純関数・テスト対象） |
| `docs/js/db.js` | IndexedDB（ローカル保存・バックアップ入出力） |
| `docs/js/crypto.js` | tasks.json の暗号化／復号（Node・ブラウザ共用） |
| `docs/js/app.js` | 画面（月カレンダー＋下部リスト・編集シート） |
| `docs/sw.js` | Service Worker（オフライン） |
| `tests/core.test.mjs` | 第7章の仕様どおり動くかのユニットテスト |
| `tests/e2e.mjs` | ヘッドレスブラウザでの実機相当テスト |

## データの持ち方（第7-3章の実装ヒントに準拠）

タスク1件ごとに、3つを**分けて**保持します。

```jsonc
{
  "id": "notionのページID",
  "origin": { "title": "...", "date": "...", "fp": "指紋" },  // Notion由来の元データ
  "local":  { "slotIndex": 4 },                               // ユーザーが触った項目だけ
  "memo":   "手元メモ\n※Notion「タイトル」旧→新 に変更（2026/08/01 取込）",
  "history": [ /* 全変更履歴 */ ]
}
```

表示値は `local` があればそれ、無ければ `origin` を使います。
だから「触った項目は守られ、触っていない項目はNotionに追従する」が自然に成立します。

### 取り込み時の判定（第7-1・7-2章）

| 状況 | 動作 |
|---|---|
| 初見のタスク | そのまま取り込む |
| 指紋が同じ | **何もしない**（アプリ側の編集・削除を尊重） |
| 指紋が違う | その1件だけマージ：未編集項目は更新、編集済み項目は保持、旧値をメモと履歴に記録 |

日付による足切りはしません。過去のタスクも未来のタスクも、内容差分だけで判定します。

## 開発

```bash
node --test tests/core.test.mjs   # 第7章ロジックのテスト（16件）
node tests/e2e.mjs                # ヘッドレス実機テスト（29件）
node scripts/make-sample.mjs      # サンプルデータ生成
npx serve docs                    # ローカル確認
```

Notion側のプロパティ名を変えたときは `scripts/sync-notion.mjs` 冒頭の `PROP` だけ直せば追従します。

## 確認済みの Notion スキーマ（第13章-1の解消）

取り込み元は **タスクメモDB**（`482fec5b-a75e-83cc-b6de-87677e2cfc23`）1本。
「今日のタスク」「明日以降のタスク」はこのDBのビューであり、別DBではありません。

| プロパティ | 型 | アプリでの用途 |
|---|---|---|
| タイトル | title | 表示名 |
| ステータス | status | 完了判定（いつかやる/未着手/停止中/進行中/やらない/完了） |
| 実行日 | date | **カレンダー上の配置基準**（第6章） |
| 期限 | date | 締切バッジ（超過は赤、2日以内は橙） |
| 時間帯 | select | 日内の並び順とグループ見出し |
| プロジェクト | relation | **色分け**（第5-3章） |
| 順位 / 習慣タグ / URL | select / select / url | 補助バッジ |
