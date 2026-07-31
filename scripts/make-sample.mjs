/**
 * 動作確認用のサンプル tasks.json を作る（Notion に繋ぐ前でも画面を確認できる）。
 * 実行: node scripts/make-sample.mjs [--encrypt 合言葉]
 * ※ 本番では GitHub Actions が scripts/sync-notion.mjs で上書きします。
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fingerprint } from './sync-notion.mjs';
import { encryptJSON } from '../docs/js/crypto.js';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../docs/data/tasks.json');

const d = (offset) => {
  const t = new Date();
  t.setDate(t.getDate() + offset);
  return t.toISOString().slice(0, 10);
};

const P1 = 'proj-1111', P2 = 'proj-2222';
const projects = {
  [P1]: { id: P1, name: '採用・組織づくり', color: '#3b7dd8' },
  [P2]: { id: P2, name: '院内オペレーション', color: '#e0733d' },
};

const raw = [
  ['PubMed論文レビュー', '未着手', d(0), null, 1, [], 'A', null],
  ['朝の申し送り確認', '進行中', d(0), null, 1, [P2], null, '🥇1位'],
  ['求人ページに給与レンジを追記', '未着手', d(0), d(2), 2, [P1], null, '🥈2位'],
  ['面談用資料を作成する', '未着手', d(0), d(-1), 3, [P1], null, null],
  ['レセプト点検', '完了', d(0), null, 3, [P2], null, null],
  ['スタッフ面談（山田さん）', '未着手', d(1), null, 2, [P1], null, null],
  ['セルフレジ導入の見積り取得', '未着手', d(1), d(6), 3, [P2], null, null],
  ['月次売上の集計', '未着手', d(3), d(3), 4, [P2], null, null],
  ['コールセンター比較表をまとめる', '停止中', d(4), null, 2, [P1], null, null],
  ['ヘルニア復帰メニュー見直し', '未着手', d(7), null, 4, [], 'B', null],
  ['院内マニュアル改訂', '未着手', d(-3), null, 2, [P2], null, null],
  ['去年の書類整理', 'いつかやる', null, null, null, [], null, null],
  ['名刺の発注', '未着手', null, d(10), null, [P2], null, null],
];

const SLOT = {
  1: ['①⏰ 〜9:00', 180], 2: ['②☀️ 9:00〜13:00', 240],
  3: ['③🕛 13:00〜18:00', 300], 4: ['④🌙 18:00〜', 180],
};
const group = (s) => (s === '完了' ? 'done' : s === 'やらない' ? 'dropped' : (s === '進行中' || s === '停止中') ? 'doing' : 'todo');

const tasks = raw.map(([title, status, date, due, slot, projectIds, habit, rank], i) => {
  const t = {
    id: `sample${String(i).padStart(4, '0')}`,
    url: null,
    title, status, statusGroup: group(status),
    date, dateEnd: null, due,
    slotIndex: slot, slotLabel: slot ? SLOT[slot][0] : null, slotMinutes: slot ? SLOT[slot][1] : null,
    projectIds, rank, habit, link: null,
    createdTime: new Date().toISOString(),
  };
  t.fp = fingerprint(t);
  return t;
});

const payload = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  source: { sample: true },
  stats: { total: tasks.length, withDate: tasks.filter((t) => t.date).length, withoutDate: tasks.filter((t) => !t.date).length },
  projects,
  tasks,
};

const contentHash = createHash('sha256')
  .update(JSON.stringify({ projects: payload.projects, tasks: payload.tasks })).digest('hex');

const passIdx = process.argv.indexOf('--encrypt');
const out = passIdx > -1
  ? { ...(await encryptJSON(payload, process.argv[passIdx + 1])), contentHash, generatedAt: payload.generatedAt, schemaVersion: 1 }
  : { ...payload, contentHash };

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(out, null, 2) + '\n');
console.log(`サンプル ${tasks.length} 件を書き出しました${passIdx > -1 ? '（暗号化あり）' : ''}: ${OUT}`);
