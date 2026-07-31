#!/usr/bin/env node
/**
 * Notion → docs/data/tasks.json 取り込みバッチ
 *
 * 引き継ぎ仕様書 第4章 / 第7章 準拠。
 *  - Notion は「読み取り専用の入力ソース」。書き戻しは一切行わない（第2章）。
 *  - トークンは環境変数 NOTION_TOKEN（GitHub Secrets）からのみ読む。コードに直書きしない（第12章）。
 *  - 日付での足切りはしない。全件取り込み、差分判定は「内容の指紋（fp）」のみで行う（第7-1章）。
 *
 * 実行: NOTION_TOKEN=xxx node scripts/sync-notion.mjs
 */

import { createHash } from 'node:crypto';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { encryptJSON } from '../docs/js/crypto.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OUT_PATH = resolve(ROOT, 'docs/data/tasks.json');

// ---------------------------------------------------------------------------
// 設定
// ---------------------------------------------------------------------------

const TOKEN = process.env.NOTION_TOKEN;

/** 公開リポジトリ対策の合言葉。未設定なら平文で書き出す（後から有効化できる）。 */
const PASSPHRASE = process.env.SYNC_PASSPHRASE || '';

/**
 * 取り込み対象データソース（= 旧APIでいう database_id）。
 * 実物確認済み: 「タスクメモDB」。
 * 「今日のタスク」「明日以降のタスク」は別DBではなく、このDBのビュー（フィルタ違い）である。
 */
const DATA_SOURCE_ID =
  process.env.NOTION_DATA_SOURCE_ID || '482fec5b-a75e-83cc-b6de-87677e2cfc23';

/** 参考: プロジェクトDB（色分け用に名前だけ引く。第5-3章） */
const PROJECT_DS_ID =
  process.env.NOTION_PROJECT_DS_ID || '76bfec5b-a75e-8200-8cf5-0716e8590685';

/** プロパティ名マッピング。Notion側で改名された場合はここだけ直せばよい（第13章-1）。 */
const PROP = {
  title: 'タイトル',
  status: 'ステータス',
  date: '実行日',
  due: '期限',
  slot: '時間帯',
  project: 'プロジェクト',
  rank: '順位',
  habit: '習慣タグ',
  url: 'URL',
};

/** 時間帯 select の並び順・表示（第6章）。先頭の丸数字で判定するので絵文字違いに強い。 */
const SLOT_ORDER = ['①', '②', '③', '④'];

const API = 'https://api.notion.com/v1';
const V_LEGACY = '2022-06-28';
const V_DS = '2025-09-03';

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function notion(path, { method = 'GET', body, version = V_LEGACY } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Notion-Version': version,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(
      `Notion API ${res.status} ${path}: ${json?.message || text.slice(0, 300)}`
    );
    err.status = res.status;
    err.code = json?.code;
    throw err;
  }
  return json;
}

/**
 * クエリ。まず旧API（/databases/{id}/query, 2022-06-28）を試し、
 * 弾かれたら新API（/data_sources/{id}/query, 2025-09-03）へフォールバックする。
 * どちらのAPIバージョンでも動くようにしておくことで、Notion側の移行に巻き込まれない。
 */
async function queryAll(dsId) {
  const attempts = [
    { path: `/databases/${dsId}/query`, version: V_LEGACY },
    { path: `/data_sources/${dsId}/query`, version: V_DS },
  ];

  let lastErr;
  for (const attempt of attempts) {
    try {
      const rows = [];
      let cursor;
      do {
        const page = await notion(attempt.path, {
          method: 'POST',
          version: attempt.version,
          body: { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) },
        });
        rows.push(...(page.results || []));
        cursor = page.has_more ? page.next_cursor : undefined;
      } while (cursor);
      console.log(`  query OK via ${attempt.path} (${attempt.version}) → ${rows.length} 件`);
      return rows;
    } catch (e) {
      lastErr = e;
      console.log(`  query NG via ${attempt.path}: ${e.message}`);
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// プロパティ抽出
// ---------------------------------------------------------------------------

const richText = (arr) => (arr || []).map((t) => t.plain_text).join('').trim();
const dashless = (id) => String(id || '').replace(/-/g, '');

function readProp(props, name) {
  return props?.[name];
}

/** 時間帯 "②☀️ 9:00〜13:00【240】" → {index:2, label:"②☀️ 9:00〜13:00", minutes:240} */
function parseSlot(name) {
  if (!name) return { index: null, label: null, minutes: null };
  const index = SLOT_ORDER.indexOf(name.trim()[0]) + 1 || null;
  const m = name.match(/【\s*(\d+)\s*】/);
  const minutes = m ? Number(m[1]) : null;
  const label = name.replace(/【\s*\d+\s*】/, '').trim();
  return { index, label, minutes };
}

/** status 名 → アプリ内の粗いグループ */
function statusGroup(name) {
  if (!name) return 'todo';
  if (name === '完了') return 'done';
  if (name === 'やらない') return 'dropped';
  if (name === '進行中' || name === '停止中') return 'doing';
  return 'todo'; // 未着手 / いつかやる
}

function extractTask(page) {
  const p = page.properties || {};

  const titleProp = readProp(p, PROP.title);
  const dateProp = readProp(p, PROP.date);
  const dueProp = readProp(p, PROP.due);
  const slotName = readProp(p, PROP.slot)?.select?.name ?? null;
  const slot = parseSlot(slotName);

  return {
    id: dashless(page.id),
    url: page.url || null,
    title: richText(titleProp?.title) || '(無題)',
    status: readProp(p, PROP.status)?.status?.name ?? null,
    statusGroup: statusGroup(readProp(p, PROP.status)?.status?.name),
    date: dateProp?.date?.start ?? null,
    dateEnd: dateProp?.date?.end ?? null,
    due: dueProp?.date?.start ?? null,
    slotIndex: slot.index,
    slotLabel: slot.label,
    slotMinutes: slot.minutes,
    projectIds: (readProp(p, PROP.project)?.relation || []).map((r) => dashless(r.id)),
    rank: readProp(p, PROP.rank)?.select?.name ?? null,
    habit: readProp(p, PROP.habit)?.select?.name ?? null,
    link: readProp(p, PROP.url)?.url ?? null,
    createdTime: page.created_time ?? null,
  };
}

/**
 * 内容の指紋（第7-1章）。
 * Notion由来の「中身」だけを対象にする。last_edited_time のような
 * 実質無変更でも動く値は入れない ＝ 空振り再取り込みを防ぐ。
 */
const FP_FIELDS = [
  'title', 'status', 'date', 'dateEnd', 'due',
  'slotIndex', 'slotLabel', 'slotMinutes',
  'projectIds', 'rank', 'habit', 'link',
];

export function fingerprint(task) {
  const canonical = FP_FIELDS.map((k) => {
    const v = task[k];
    return `${k}=${Array.isArray(v) ? [...v].sort().join(',') : v ?? ''}`;
  }).join('');
  return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 32);
}

// ---------------------------------------------------------------------------
// プロジェクト名（色分け用・第5-3章）
// ---------------------------------------------------------------------------

const PALETTE = [
  '#3b7dd8', '#e0733d', '#3f9e77', '#b45bb0',
  '#c9a227', '#5b6bd6', '#d1566f', '#2f9bb5',
  '#7a8b3e', '#8a6bd1',
];

async function fetchProjects(ids) {
  const out = {};
  const list = [...new Set(ids)];
  for (let i = 0; i < list.length; i++) {
    const id = list[i];
    try {
      const page = await notion(`/pages/${id}`);
      const titleProp = Object.values(page.properties || {}).find((v) => v?.type === 'title');
      out[id] = {
        id,
        name: richText(titleProp?.title) || '(無題プロジェクト)',
        color: PALETTE[i % PALETTE.length],
      };
    } catch (e) {
      console.log(`  project ${id} 取得失敗（色分けのみ影響）: ${e.message}`);
      out[id] = { id, name: '(取得不可)', color: PALETTE[i % PALETTE.length] };
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  if (!TOKEN) {
    console.error('NOTION_TOKEN が未設定です。GitHub Secrets に登録してください（第12章）。');
    process.exit(1);
  }

  console.log(`[1/4] タスクメモDB を取得中 (${DATA_SOURCE_ID})`);
  const pages = await queryAll(DATA_SOURCE_ID);

  console.log('[2/4] プロパティ抽出と指紋計算');
  const tasks = pages
    .filter((pg) => !pg.archived && !pg.in_trash)
    .map((pg) => {
      const t = extractTask(pg);
      t.fp = fingerprint(t);
      return t;
    })
    // 実行日が無いものはカレンダーに置けない（第6章）。取り込みはするが末尾へ。
    .sort((a, b) => String(a.date || '9999').localeCompare(String(b.date || '9999')));

  console.log('[3/4] プロジェクト名を取得（色分け用）');
  const projectIds = tasks.flatMap((t) => t.projectIds);
  const projects = projectIds.length ? await fetchProjects(projectIds) : {};

  const payload = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: { dataSourceId: DATA_SOURCE_ID, projectDataSourceId: PROJECT_DS_ID },
    stats: {
      total: tasks.length,
      withDate: tasks.filter((t) => t.date).length,
      withoutDate: tasks.filter((t) => !t.date).length,
    },
    projects,
    tasks,
  };

  // 中身が同じなら書かない → 空コミットを避ける。
  // 暗号化すると毎回バイト列が変わるので、比較は「平文のハッシュ」で行う。
  const contentHash = createHash('sha256')
    .update(JSON.stringify({ projects: payload.projects, tasks: payload.tasks }))
    .digest('hex');

  let prev = null;
  try {
    prev = JSON.parse(await readFile(OUT_PATH, 'utf8'));
  } catch { /* 初回 */ }
  if (prev && prev.contentHash === contentHash) {
    console.log('[4/4] 変更なし。tasks.json は更新しません。');
    return;
  }

  // GitHub Pages 無料枠は公開リポジトリのみ → 合言葉があれば暗号化して置く。
  let out;
  if (PASSPHRASE) {
    const env = await encryptJSON(payload, PASSPHRASE);
    out = { ...env, contentHash, generatedAt: payload.generatedAt, schemaVersion: 1 };
    console.log('  SYNC_PASSPHRASE あり → AES-256-GCM で暗号化して書き出します');
  } else {
    out = { ...payload, contentHash };
    console.warn(
      '  ⚠ SYNC_PASSPHRASE が未設定です。tasks.json は平文で公開されます。' +
      '公開リポジトリの場合、タスク内容が誰でも読める状態になります。'
    );
  }

  await mkdir(dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log(
    `[4/4] 書き出し完了: ${tasks.length} 件（実行日あり ${payload.stats.withDate} / なし ${payload.stats.withoutDate}）`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
