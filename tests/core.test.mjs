import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeIncoming, applyLocalEdit, markDeleted, resetField,
  effective, view, newLocalRecord,
} from '../docs/js/core.js';
import { fingerprint } from '../scripts/sync-notion.mjs';

const NOW1 = '2026-07-31T00:00:00.000Z';
const NOW2 = '2026-08-01T00:00:00.000Z';

function task(over = {}) {
  const t = {
    id: 'abc123',
    url: 'https://app.notion.com/abc123',
    title: 'A社ミーティング',
    status: '未着手',
    statusGroup: 'todo',
    date: '2026-08-03',
    dateEnd: null,
    due: null,
    slotIndex: 2,
    slotLabel: '②☀️ 9:00〜13:00',
    slotMinutes: 240,
    projectIds: [],
    rank: null,
    habit: null,
    link: null,
    createdTime: '2026-07-01T00:00:00.000Z',
    ...over,
  };
  t.fp = fingerprint(t);
  return t;
}

// --- 第7-1章：指紋 ---------------------------------------------------------

test('指紋: 内容が同じなら同じ、変われば変わる', () => {
  assert.equal(task().fp, task().fp);
  assert.notEqual(task().fp, task({ title: 'A社定例ミーティング' }).fp);
});

test('指紋: 日付に依存しない（過去のタスクでも足切りしない）', () => {
  const past = task({ date: '2020-01-01' });
  const same = task({ date: '2020-01-01' });
  assert.equal(past.fp, same.fp);
});

test('指紋: projectIds の並び順が違っても同一とみなす', () => {
  assert.equal(task({ projectIds: ['p1', 'p2'] }).fp, task({ projectIds: ['p2', 'p1'] }).fp);
});

// --- 第7-2章：差分なしは再取り込みしない -----------------------------------

test('差分なし → 何もしない（アプリ側の編集を尊重）', () => {
  const t = task();
  let { record } = mergeIncoming(null, t, NOW1);
  ({ record } = applyLocalEdit(record, { title: '自分で直したタイトル' }, NOW1));

  const r = mergeIncoming(record, task(), NOW2);
  assert.equal(r.action, 'unchanged');
  assert.equal(effective(r.record, 'title'), '自分で直したタイトル');
  assert.equal(r.record.history.length, 2, '履歴が増えていない');
});

test('差分なし → アプリ側で削除済みでも復活しない', () => {
  let { record } = mergeIncoming(null, task(), NOW1);
  record = markDeleted(record, NOW1);
  const r = mergeIncoming(record, task(), NOW2);
  assert.equal(r.action, 'unchanged');
  assert.equal(r.record.deleted, true);
});

// --- 第7-3章：差分ありのマージ ---------------------------------------------

test('差分あり → 未編集項目はNotionの新しい値に更新される', () => {
  let { record } = mergeIncoming(null, task(), NOW1);
  const r = mergeIncoming(record, task({ title: 'A社定例ミーティング' }), NOW2);
  assert.equal(r.action, 'updated');
  assert.equal(effective(r.record, 'title'), 'A社定例ミーティング');
});

test('差分あり → アプリ側で触った項目は保持される（①）', () => {
  let { record } = mergeIncoming(null, task(), NOW1);
  ({ record } = applyLocalEdit(record, { slotIndex: 4 }, NOW1)); // 自分で夜に移した

  const r = mergeIncoming(record, task({ slotIndex: 1, title: 'A社定例ミーティング' }), NOW2);
  assert.equal(effective(r.record, 'slotIndex'), 4, 'ユーザーの時間帯変更が生き残る');
  assert.equal(effective(r.record, 'title'), 'A社定例ミーティング', '未編集のタイトルは更新される');
  const slotChange = r.changes.find((c) => c.field === 'slotIndex');
  assert.equal(slotChange.kept, true);
});

test('差分あり → 変更前の値がメモ欄に履歴として残る（③）', () => {
  let { record } = mergeIncoming(null, task(), NOW1);
  const r = mergeIncoming(record, task({ title: 'A社定例ミーティング' }), NOW2);
  assert.match(r.record.memo, /※Notion「タイトル」A社ミーティング → A社定例ミーティング に変更（2026\/08\/01 取込）/);
});

test('差分あり → 構造化された変更履歴も残る', () => {
  let { record } = mergeIncoming(null, task(), NOW1);
  const r = mergeIncoming(record, task({ title: 'X', due: '2026-08-05' }), NOW2);
  const entry = r.record.history.at(-1);
  assert.equal(entry.type, 'notion-change');
  assert.deepEqual(entry.changes.map((c) => c.field).sort(), ['due', 'title']);
  const due = entry.changes.find((c) => c.field === 'due');
  assert.equal(due.from, null);
  assert.equal(due.to, '2026-08-05');
});

test('ユーザーのメモは取り込みで消えない（追記される）', () => {
  let { record } = mergeIncoming(null, task(), NOW1);
  ({ record } = applyLocalEdit(record, { memo: '先方に資料送付済み' }, NOW1));
  const r = mergeIncoming(record, task({ title: 'X' }), NOW2);
  assert.match(r.record.memo, /^先方に資料送付済み\n※Notion/);
});

test('複数回の取り込みで履歴が積み上がる', () => {
  let { record } = mergeIncoming(null, task(), NOW1);
  ({ record } = mergeIncoming(record, task({ title: 'B' }), NOW2));
  ({ record } = mergeIncoming(record, task({ title: 'C' }), '2026-08-02T00:00:00.000Z'));
  assert.equal(effective(record, 'title'), 'C');
  assert.equal(record.history.filter((h) => h.type === 'notion-change').length, 2);
  assert.equal(record.memo.split('\n').length, 2);
});

test('差分あり → 削除済みタスクは復活し、その旨も履歴に残る', () => {
  let { record } = mergeIncoming(null, task(), NOW1);
  record = markDeleted(record, NOW1);
  const r = mergeIncoming(record, task({ title: 'よみがえった' }), NOW2);
  assert.equal(r.record.deleted, false);
  assert.match(r.record.memo, /削除済みのこのタスクを復活/);
});

// --- 第7-4章：削除はNotionに同期しない -------------------------------------

test('削除はローカルフラグのみ（書き戻し処理が存在しない）', () => {
  let { record } = mergeIncoming(null, task(), NOW1);
  const deleted = markDeleted(record, NOW1);
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.origin.id, 'abc123', 'origin は保持されたまま');
});

// --- ユーザー編集の取り消し -------------------------------------------------

test('編集を取り消すとNotionの値に戻る', () => {
  let { record } = mergeIncoming(null, task(), NOW1);
  ({ record } = applyLocalEdit(record, { title: '俺のタイトル' }, NOW1));
  assert.equal(effective(record, 'title'), '俺のタイトル');
  record = resetField(record, 'title', NOW2);
  assert.equal(effective(record, 'title'), 'A社ミーティング');
  // 戻したあとは「未編集」なので、次の取り込みで更新対象になる
  const r = mergeIncoming(record, task({ title: '新タイトル' }), NOW2);
  assert.equal(effective(r.record, 'title'), '新タイトル');
});

// --- ローカル追加予定 -------------------------------------------------------

test('ローカル追加予定は取り込みの影響を受けない', () => {
  const rec = newLocalRecord({ title: '歯医者', date: '2026-08-10', slotIndex: 3 }, NOW1);
  assert.equal(rec.source, 'local');
  assert.equal(view(rec).title, '歯医者');
  assert.equal(rec.origin, null);
});

test('view() はユーザー編集を反映した実効値を返す', () => {
  let { record } = mergeIncoming(null, task({ due: '2026-08-05' }), NOW1);
  ({ record } = applyLocalEdit(record, { date: '2026-08-04' }, NOW1));
  const v = view(record);
  assert.equal(v.date, '2026-08-04');
  assert.equal(v.due, '2026-08-05');
  assert.deepEqual(v.editedFields, ['date']);
});
