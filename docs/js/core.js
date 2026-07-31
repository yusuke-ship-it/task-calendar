/**
 * 同期ロジックの中核（第7章）。
 * DOM にも IndexedDB にも依存しない純関数だけを置く ＝ そのまま Node でテストできる。
 *
 * 設計の背骨（第2章）: Notion → アプリの一方通行。ここから Notion へ書き戻す処理は存在しない。
 */

/** Notion 由来で、再取り込み時にマージ対象となる項目 */
export const MERGEABLE = [
  'title', 'status', 'statusGroup', 'date', 'dateEnd', 'due',
  'slotIndex', 'slotLabel', 'slotMinutes', 'projectIds', 'rank', 'habit', 'link',
];

/** アプリ側でユーザーが上書きできる項目（＝触ったら保持される項目・第7-3-1） */
export const USER_EDITABLE = ['title', 'status', 'statusGroup', 'date', 'due', 'slotIndex'];

const FIELD_LABEL = {
  title: 'タイトル',
  status: 'ステータス',
  statusGroup: 'ステータス区分',
  date: '実行日',
  dateEnd: '実行日(終了)',
  due: '期限',
  slotIndex: '時間帯',
  slotLabel: '時間帯',
  slotMinutes: '想定時間',
  projectIds: 'プロジェクト',
  rank: '順位',
  habit: '習慣タグ',
  link: 'URL',
};

// ---------------------------------------------------------------------------
// 小道具
// ---------------------------------------------------------------------------

const isArr = Array.isArray;

export function eq(a, b) {
  if (isArr(a) && isArr(b)) {
    if (a.length !== b.length) return false;
    const x = [...a].sort(), y = [...b].sort();
    return x.every((v, i) => v === y[i]);
  }
  return (a ?? null) === (b ?? null);
}

function show(v) {
  if (v === null || v === undefined || v === '') return '（空）';
  if (isArr(v)) return v.length ? v.join(', ') : '（空）';
  return String(v);
}

function jpDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
}

const clone = (o) => JSON.parse(JSON.stringify(o));

// ---------------------------------------------------------------------------
// レコード
// ---------------------------------------------------------------------------

/**
 * 保存レコードの形（第7-3章の実装ヒントに従い、3つを明確に分離する）
 *   origin  : Notion由来の元データ（指紋 fp を含む）
 *   local   : ユーザーが編集した項目だけを持つ（キーの存在＝「触った」の記録）
 *   history : 全変更履歴（オーナーが特に強く希望）
 */
export function newRecordFromNotion(incoming, nowISO) {
  return {
    id: incoming.id,
    source: 'notion',
    origin: { ...incoming },
    local: {},
    memo: '',
    deleted: false,
    createdAt: nowISO,
    updatedAt: nowISO,
    history: [
      { at: nowISO, type: 'import', note: 'Notionから初回取り込み' },
    ],
  };
}

export function newLocalRecord(fields, nowISO, id) {
  return {
    id: id || `local-${nowISO}-${Math.abs(hash32(JSON.stringify(fields) + nowISO))}`,
    source: 'local',
    origin: null,
    local: { ...fields },
    memo: fields.memo || '',
    deleted: false,
    createdAt: nowISO,
    updatedAt: nowISO,
    history: [{ at: nowISO, type: 'create', note: 'アプリ内で作成' }],
  };
}

/** 実効値 = ユーザー編集値があればそれ、なければ Notion 由来値 */
export function effective(rec, field) {
  if (rec.local && Object.prototype.hasOwnProperty.call(rec.local, field)) {
    return rec.local[field];
  }
  return rec.origin ? rec.origin[field] ?? null : null;
}

/** 表示用にフラット化 */
export function view(rec) {
  const out = { id: rec.id, source: rec.source, memo: rec.memo, deleted: rec.deleted };
  for (const f of MERGEABLE) out[f] = effective(rec, f);
  out.url = rec.origin?.url ?? null;
  out.historyCount = rec.history?.length ?? 0;
  out.editedFields = Object.keys(rec.local || {});
  return out;
}

// ---------------------------------------------------------------------------
// 第7章の中核：取り込みマージ
// ---------------------------------------------------------------------------

/**
 * @param {object|null} existing 既存レコード（無ければ null）
 * @param {object} incoming 取り込んだNotionタスク（fp を含む）
 * @param {string} nowISO
 * @param {{reviveDeleted?: boolean}} opts
 * @returns {{record: object, action: 'created'|'unchanged'|'updated', changes: Array}}
 */
export function mergeIncoming(existing, incoming, nowISO, opts = {}) {
  const { reviveDeleted = true } = opts;

  // 初見 → そのまま取り込む
  if (!existing) {
    return { record: newRecordFromNotion(incoming, nowISO), action: 'created', changes: [] };
  }

  // 第7-2章：指紋が同じ ＝ 取り込み済み＝「完了」扱い。再取り込みしない。
  // アプリ側で編集・削除していても、ここでは一切触らない（アプリ側を尊重）。
  if (existing.origin && existing.origin.fp === incoming.fp) {
    return { record: existing, action: 'unchanged', changes: [] };
  }

  // 第7-3章：差分あり → 丸ごと上書きせず項目単位でマージする
  const rec = clone(existing);
  const changes = [];

  for (const f of MERGEABLE) {
    const before = existing.origin ? existing.origin[f] : null;
    const after = incoming[f];
    if (eq(before, after)) continue;

    // ① オーナーがアプリ側で触った項目は保持する
    const kept = Object.prototype.hasOwnProperty.call(rec.local, f);
    changes.push({ field: f, label: FIELD_LABEL[f] || f, from: before ?? null, to: after ?? null, kept });
  }

  // ② Notion側で変わった項目は新しい値に更新（＝ origin を差し替える。
  //    local に無い項目は effective() が origin を返すので自動的に新しい値になる）
  rec.origin = { ...incoming };
  rec.updatedAt = nowISO;

  // 削除済みでも Notion 側に実変更があれば復活させる（第7-2「差分があるものだけ再度上書きする」）
  if (rec.deleted && reviveDeleted) {
    rec.deleted = false;
    changes.push({ field: '__revived__', label: '削除状態', from: '削除済み', to: '復活', kept: false });
  }

  if (changes.length === 0) {
    // 指紋だけ変わって内容差分が無いケース（指紋アルゴリズム変更時など）。
    // 履歴を汚さずに指紋だけ更新して終える。
    return { record: rec, action: 'unchanged', changes: [] };
  }

  // ③ 変更前の古い値は捨てず、履歴とメモ欄の両方に残す
  const lines = changes
    .filter((c) => c.field !== '__revived__')
    .map(
      (c) =>
        `※Notion「${c.label}」${show(c.from)} → ${show(c.to)} に変更（${jpDate(nowISO)} 取込）` +
        (c.kept ? '／アプリ側の値を保持' : '')
    );
  if (changes.some((c) => c.field === '__revived__')) {
    lines.push(`※Notion側に変更があったため、削除済みのこのタスクを復活（${jpDate(nowISO)} 取込）`);
  }

  rec.memo = [rec.memo, ...lines].filter(Boolean).join('\n');
  rec.history = [...(rec.history || []), { at: nowISO, type: 'notion-change', changes }];

  return { record: rec, action: 'updated', changes };
}

/** ユーザー編集を適用（変更履歴も残す） */
export function applyLocalEdit(rec, patch, nowISO) {
  const next = clone(rec);
  const changes = [];
  for (const [f, v] of Object.entries(patch)) {
    if (f === 'memo') {
      if (next.memo !== v) changes.push({ field: 'memo', label: 'メモ', from: next.memo, to: v, kept: false });
      next.memo = v;
      continue;
    }
    if (!USER_EDITABLE.includes(f)) continue;
    const before = effective(next, f);
    if (eq(before, v)) continue;
    next.local[f] = v;
    changes.push({ field: f, label: FIELD_LABEL[f] || f, from: before, to: v, kept: false });
  }
  if (!changes.length) return { record: rec, changed: false };
  next.updatedAt = nowISO;
  next.history = [...(next.history || []), { at: nowISO, type: 'local-edit', changes }];
  return { record: next, changed: true };
}

/** アプリ側削除（第7-4：Notionには一切同期しない。ローカルのフラグを立てるだけ） */
export function markDeleted(rec, nowISO) {
  const next = clone(rec);
  next.deleted = true;
  next.updatedAt = nowISO;
  next.history = [...(next.history || []), { at: nowISO, type: 'local-delete', note: 'アプリ側で削除（Notionには反映しない）' }];
  return next;
}

/** ユーザー編集を取り消して Notion の値に戻す */
export function resetField(rec, field, nowISO) {
  if (!rec.local || !Object.prototype.hasOwnProperty.call(rec.local, field)) return rec;
  const next = clone(rec);
  const from = next.local[field];
  delete next.local[field];
  next.updatedAt = nowISO;
  next.history = [
    ...(next.history || []),
    { at: nowISO, type: 'local-reset', changes: [{ field, label: FIELD_LABEL[field] || field, from, to: effective(next, field), kept: false }] },
  ];
  return next;
}

// ---------------------------------------------------------------------------

export function hash32(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h | 0;
}
