/**
 * 画面本体（第6章 表示ルール / 第10章 操作感）
 * 月カレンダー ＋ 下部リスト。タップした日のタスクが下に出る。
 */

import {
  mergeIncoming, applyLocalEdit, markDeleted, resetField,
  effective, view, newLocalRecord,
} from './core.js';
import * as db from './db.js';
import { decryptJSON } from './crypto.js';

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

const DATA_URL = 'data/tasks.json';
const SLOT_LABELS = {
  1: '①⏰ 〜9:00', 2: '②☀️ 9:00〜13:00', 3: '③🕛 13:00〜18:00', 4: '④🌙 18:00〜',
  0: '時間帯なし',
};

const state = {
  y: 0, m: 0,               // 表示中の年・月(0-11)
  sel: '',                  // 選択中の日 YYYY-MM-DD
  tab: 'day',
  records: new Map(),
  projects: {},
  lastSync: null,
  opts: { showDone: true, showDeleted: false },
  editingId: null,
};

const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dayKey = (v) => (v ? String(v).slice(0, 10) : null);
const todayKey = () => ymd(new Date());
const DOW = ['日', '月', '火', '水', '木', '金', '土'];

function fmtDayTitle(key) {
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return `${m}月${d}日(${DOW[dt.getDay()]})`;
}

function daysBetween(aKey, bKey) {
  const a = new Date(aKey + 'T00:00:00');
  const b = new Date(bKey + 'T00:00:00');
  return Math.round((a - b) / 86400000);
}

// ---------------------------------------------------------------------------
// 起動
// ---------------------------------------------------------------------------

async function boot() {
  const now = new Date();
  state.y = now.getFullYear();
  state.m = now.getMonth();
  state.sel = todayKey();

  await db.openDB();
  state.opts = await db.getMeta('opts', state.opts);
  state.projects = await db.getMeta('projects', {});
  state.lastSync = await db.getMeta('lastSync', null);
  for (const r of await db.getAllRecords()) state.records.set(r.id, r);

  wireUI();
  render();
  sync({ silent: true });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// 同期（第7章）
// ---------------------------------------------------------------------------

async function sync({ silent = false } = {}) {
  const icon = $('syncIcon');
  icon.classList.add('spin');
  try {
    if (!navigator.onLine) throw new Error('offline');

    const res = await fetch(`${DATA_URL}?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await unseal(await res.json());
    if (!payload) { setStatus('合言葉が未入力のため同期を中止しました', 'warn'); return; }

    const nowISO = new Date().toISOString();
    const changed = [];
    let created = 0, updated = 0, unchanged = 0;

    for (const t of payload.tasks || []) {
      const existing = state.records.get(t.id) || null;
      const r = mergeIncoming(existing, t, nowISO);
      if (r.action === 'unchanged' && existing) { unchanged++; continue; }
      if (r.action === 'created') created++; else updated++;
      state.records.set(r.record.id, r.record);
      changed.push(r.record);
    }

    if (changed.length) await db.putRecords(changed);
    state.projects = payload.projects || {};
    state.lastSync = { at: nowISO, generatedAt: payload.generatedAt, created, updated, unchanged };
    await db.setMeta('projects', state.projects);
    await db.setMeta('lastSync', state.lastSync);

    render();
    setStatus(
      `同期 ${new Date(nowISO).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}｜` +
      `新規 ${created} / 更新 ${updated} / 変更なし ${unchanged}`
    );
  } catch (e) {
    const offline = !navigator.onLine || e.message === 'offline';
    const last = state.lastSync
      ? `最終同期 ${new Date(state.lastSync.at).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`
      : '未同期';
    setStatus(
      offline ? `オフライン（保存済みデータを表示中）／${last}` : `同期失敗: ${e.message}／${last}`,
      offline ? 'warn' : 'err'
    );
    if (!silent && !offline) console.error(e);
  } finally {
    icon.classList.remove('spin');
  }
}

/**
 * 暗号化された tasks.json を復号する。合言葉は端末内に保存し、2回目以降は聞かない。
 * 平文なら素通り。
 */
async function unseal(raw) {
  if (!raw?.encrypted) return raw;

  const saved = await db.getMeta('passphrase', null);
  if (saved) {
    try { return await decryptJSON(raw, saved); } catch { /* 合言葉が変わった */ }
  }
  for (let i = 0; i < 3; i++) {
    const p = prompt(
      i === 0
        ? '同期データの合言葉を入力してください（この端末に保存され、次回からは聞かれません）'
        : '合言葉が違います。もう一度入力してください'
    );
    if (!p) return null;
    try {
      const data = await decryptJSON(raw, p);
      await db.setMeta('passphrase', p);
      return data;
    } catch { /* retry */ }
  }
  throw new Error('合言葉が違います');
}

function setStatus(text, cls = '') {
  const el = $('statusline');
  el.textContent = text;
  el.className = `statusline ${cls}`;
}

// ---------------------------------------------------------------------------
// 抽出
// ---------------------------------------------------------------------------

function visibleRecords() {
  const out = [];
  for (const r of state.records.values()) {
    if (r.deleted && !state.opts.showDeleted) continue;
    const v = view(r);
    if (!state.opts.showDone && (v.statusGroup === 'done' || v.statusGroup === 'dropped')) continue;
    out.push(v);
  }
  return out;
}

function byDay() {
  const map = new Map();
  const undated = [];
  for (const v of visibleRecords()) {
    const k = dayKey(v.date);
    if (!k) { undated.push(v); continue; }
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(v);
  }
  for (const list of map.values()) list.sort(cmpTask);
  undated.sort(cmpTask);
  return { map, undated };
}

function cmpTask(a, b) {
  const done = (x) => (x.statusGroup === 'done' || x.statusGroup === 'dropped' ? 1 : 0);
  if (done(a) !== done(b)) return done(a) - done(b);
  const s = (x) => x.slotIndex ?? 9;
  if (s(a) !== s(b)) return s(a) - s(b);
  const r = (x) => (x.rank ? Number(x.rank.replace(/\D/g, '')) || 9 : 9);
  if (r(a) !== r(b)) return r(a) - r(b);
  return String(a.title).localeCompare(String(b.title), 'ja');
}

function projColor(v) {
  if (v.source === 'local') return '#8a6bd1';
  const pid = v.projectIds?.[0];
  return (pid && state.projects[pid]?.color) || 'var(--brand)';
}
function projName(v) {
  const pid = v.projectIds?.[0];
  return pid ? state.projects[pid]?.name : null;
}

// ---------------------------------------------------------------------------
// 描画
// ---------------------------------------------------------------------------

function render() {
  renderCalendar();
  renderPanel();
}

function renderCalendar() {
  $('monthTitle').textContent = `${state.y}年${state.m + 1}月`;
  const { map } = byDay();
  const grid = $('grid');
  const first = new Date(state.y, state.m, 1);
  const start = new Date(first);
  start.setDate(1 - first.getDay());

  const today = todayKey();
  const frag = document.createDocumentFragment();

  for (let i = 0; i < 42; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const key = ymd(d);
    const cell = document.createElement('div');
    cell.className = 'cell';
    if (d.getMonth() !== state.m) cell.classList.add('other');
    if (d.getDay() === 0) cell.classList.add('sun');
    if (d.getDay() === 6) cell.classList.add('sat');
    if (key === today) cell.classList.add('today');
    if (key === state.sel) cell.classList.add('sel');
    cell.dataset.key = key;

    const num = document.createElement('span');
    num.className = 'dnum';
    num.textContent = d.getDate();
    cell.appendChild(num);

    const list = map.get(key) || [];
    if (list.length) {
      const pips = document.createElement('div');
      pips.className = 'pips';
      for (const v of list.slice(0, 3)) {
        const p = document.createElement('div');
        p.className = 'pip' + (v.statusGroup === 'done' || v.statusGroup === 'dropped' ? ' done' : '');
        p.style.borderLeftColor = projColor(v);
        p.textContent = v.title;
        pips.appendChild(p);
      }
      cell.appendChild(pips);
      if (list.length > 3) {
        const more = document.createElement('div');
        more.className = 'more';
        more.textContent = `+${list.length - 3}`;
        cell.appendChild(more);
      }
    }
    frag.appendChild(cell);
  }
  grid.replaceChildren(frag);
}

function renderPanel() {
  const { map, undated } = byDay();
  $('tabDay').textContent = fmtDayTitle(state.sel);
  $('undatedCount').textContent = undated.length;
  $('tabDay').classList.toggle('active', state.tab === 'day');
  $('tabUndated').classList.toggle('active', state.tab === 'undated');

  const list = state.tab === 'day' ? (map.get(state.sel) || []) : undated;
  const body = $('panelBody');

  if (!list.length) {
    body.innerHTML = `<p class="empty">${state.tab === 'day' ? 'この日の予定はありません' : '日付が入っていないタスクはありません'}</p>`;
    return;
  }

  const frag = document.createDocumentFragment();
  let curSlot = null;
  for (const v of list) {
    const slot = v.slotIndex ?? 0;
    if (slot !== curSlot) {
      curSlot = slot;
      const h = document.createElement('div');
      h.className = 'slot';
      h.textContent = SLOT_LABELS[slot] || SLOT_LABELS[0];
      frag.appendChild(h);
    }
    frag.appendChild(itemEl(v));
  }
  body.replaceChildren(frag);
}

function itemEl(v) {
  const done = v.statusGroup === 'done' || v.statusGroup === 'dropped';
  const el = document.createElement('div');
  el.className = 'item' + (done ? ' done' : '');
  el.style.borderLeftColor = projColor(v);
  el.dataset.id = v.id;

  const chk = document.createElement('button');
  chk.className = 'chk';
  chk.dataset.act = 'toggle';
  chk.setAttribute('aria-label', done ? '未完了に戻す' : '完了にする');

  const body = document.createElement('div');
  body.className = 'body';
  const t = document.createElement('div');
  t.className = 't';
  t.textContent = v.title;
  body.appendChild(t);

  const sub = document.createElement('div');
  sub.className = 'sub';

  // 締切バッジ（第6章：実行日に置いたうえで締切も併記）
  if (v.due) {
    const dk = dayKey(v.due);
    const diff = daysBetween(dk, todayKey());
    const b = document.createElement('span');
    b.className = 'badge due' + (diff < 0 ? ' overdue' : diff <= 2 ? ' soon' : '');
    const [, mm, dd] = dk.split('-');
    b.textContent = diff < 0 ? `締切超過 ${Number(mm)}/${Number(dd)}`
      : diff === 0 ? '締切 今日'
      : `締切 ${Number(mm)}/${Number(dd)}`;
    sub.appendChild(b);
  }

  const pn = projName(v);
  if (pn) {
    const b = document.createElement('span');
    b.className = 'badge proj';
    b.style.setProperty('--pc', projColor(v));
    b.textContent = pn;
    sub.appendChild(b);
  }
  if (v.source === 'local') sub.appendChild(badge('この端末のみ', 'local'));
  if (v.editedFields.length) sub.appendChild(badge(`編集済 ${v.editedFields.length}`, 'edited'));
  if (v.deleted) sub.appendChild(badge('削除済み', 'deleted'));
  if (v.status && v.statusGroup !== 'todo') sub.appendChild(badge(v.status));
  if (v.rank) sub.appendChild(badge(v.rank));

  if (sub.childNodes.length) body.appendChild(sub);
  el.append(chk, body);
  return el;
}

function badge(text, cls = '') {
  const b = document.createElement('span');
  b.className = `badge ${cls}`.trim();
  b.textContent = text;
  return b;
}

// ---------------------------------------------------------------------------
// 操作
// ---------------------------------------------------------------------------

function wireUI() {
  $('prevMonth').onclick = () => shiftMonth(-1);
  $('nextMonth').onclick = () => shiftMonth(1);
  $('monthTitle').onclick = () => {
    const v = prompt('表示する年月（YYYY-MM）', `${state.y}-${pad(state.m + 1)}`);
    if (!v) return;
    const mm = v.match(/^(\d{4})-(\d{1,2})$/);
    if (!mm) return;
    state.y = Number(mm[1]); state.m = Number(mm[2]) - 1; render();
  };
  $('todayBtn').onclick = () => {
    const now = new Date();
    state.y = now.getFullYear(); state.m = now.getMonth();
    state.sel = todayKey(); state.tab = 'day'; render();
  };
  $('syncBtn').onclick = () => sync();
  $('menuBtn').onclick = openMenu;
  $('addBtn').onclick = () => openSheet(null);

  $('grid').addEventListener('click', (e) => {
    const cell = e.target.closest('.cell');
    if (!cell) return;
    state.sel = cell.dataset.key;
    state.tab = 'day';
    const d = new Date(state.sel + 'T00:00:00');
    if (d.getMonth() !== state.m) { state.y = d.getFullYear(); state.m = d.getMonth(); }
    render();
  });

  $('panelBody').addEventListener('click', async (e) => {
    const item = e.target.closest('.item');
    if (!item) return;
    if (e.target.dataset.act === 'toggle') { await toggleDone(item.dataset.id); return; }
    openSheet(item.dataset.id);
  });

  $('tabDay').onclick = () => { state.tab = 'day'; renderPanel(); };
  $('tabUndated').onclick = () => { state.tab = 'undated'; renderPanel(); };

  $('sheetCancel').onclick = closeSheets;
  $('backdrop').onclick = closeSheets;
  $('sheetSave').onclick = saveSheet;
  $('sheetDelete').onclick = deleteFromSheet;
  $('menuClose').onclick = closeSheets;

  $('optShowDone').onchange = async (e) => {
    state.opts.showDone = e.target.checked;
    await db.setMeta('opts', state.opts); render();
  };
  $('optShowDeleted').onchange = async (e) => {
    state.opts.showDeleted = e.target.checked;
    await db.setMeta('opts', state.opts); render();
  };
  $('btnExport').onclick = doExport;
  $('fileImport').onchange = doImport;
  $('btnPass').onclick = async () => {
    await db.setMeta('passphrase', null);
    closeSheets();
    alert('保存済みの合言葉を消去しました。次の同期でもう一度聞かれます。');
    sync();
  };

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSheets();
  });
  window.addEventListener('online', () => sync({ silent: true }));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') sync({ silent: true });
  });

  // 左右スワイプで月移動
  let sx = 0, sy = 0;
  $('calendar').addEventListener('touchstart', (e) => {
    sx = e.touches[0].clientX; sy = e.touches[0].clientY;
  }, { passive: true });
  $('calendar').addEventListener('touchend', (e) => {
    const dx = e.changedTouches[0].clientX - sx;
    const dy = e.changedTouches[0].clientY - sy;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.6) shiftMonth(dx < 0 ? 1 : -1);
  }, { passive: true });
}

function shiftMonth(delta) {
  const d = new Date(state.y, state.m + delta, 1);
  state.y = d.getFullYear(); state.m = d.getMonth();
  renderCalendar();
}

async function toggleDone(id) {
  const rec = state.records.get(id);
  if (!rec) return;
  const isDone = effective(rec, 'statusGroup') === 'done';
  const patch = isDone
    ? { status: '未着手', statusGroup: 'todo' }
    : { status: '完了', statusGroup: 'done' };
  const { record, changed } = applyLocalEdit(rec, patch, new Date().toISOString());
  if (!changed) return;
  state.records.set(id, record);
  await db.putRecord(record);
  render();
}

// ---------------------------------------------------------------------------
// 編集シート
// ---------------------------------------------------------------------------

function openSheet(id) {
  state.editingId = id;
  const rec = id ? state.records.get(id) : null;
  const v = rec ? view(rec) : {
    title: '', date: state.tab === 'day' ? state.sel : '', due: '',
    slotIndex: '', status: '未着手', memo: '', editedFields: [], source: 'local',
  };

  $('sheetTitle').textContent = rec ? 'タスクを編集' : '予定を追加';
  $('fTitle').value = v.title || '';
  $('fDate').value = dayKey(v.date) || '';
  $('fDue').value = dayKey(v.due) || '';
  $('fSlot').value = v.slotIndex ?? '';
  $('fStatus').value = v.status || '未着手';
  $('fMemo').value = rec ? rec.memo || '' : '';

  for (const el of document.querySelectorAll('.edited[data-edited]')) {
    el.hidden = !v.editedFields?.includes(el.dataset.edited);
    el.onclick = null;
    if (!el.hidden && rec) {
      el.title = 'クリックでNotionの値に戻す';
      el.onclick = async (ev) => {
        ev.preventDefault();
        const next = resetField(state.records.get(rec.id), el.dataset.edited, new Date().toISOString());
        state.records.set(rec.id, next);
        await db.putRecord(next);
        openSheet(rec.id); render();
      };
    }
  }

  const meta = $('sheetMeta');
  if (rec) {
    const parts = [];
    if (rec.source === 'notion') {
      parts.push(`Notion由来${rec.origin?.url ? `（<a href="${rec.origin.url}" target="_blank" rel="noopener">Notionで開く</a>）` : ''}`);
      if (rec.origin?.fp) parts.push(`指紋: <code>${rec.origin.fp.slice(0, 12)}…</code>`);
    } else {
      parts.push('この端末で作成（Notionには存在しません）');
    }
    parts.push(`最終更新: ${new Date(rec.updatedAt).toLocaleString('ja-JP')}`);
    if (rec.deleted) parts.push('<b>削除済み</b>');
    meta.innerHTML = parts.join('<br>');
  } else {
    meta.textContent = 'アプリ内で追加した予定はこの端末にのみ保存されます（第8章 E-1）。';
  }

  renderHistory(rec);
  $('sheetDelete').style.display = rec ? '' : 'none';
  showSheet($('sheet'));
}

function renderHistory(rec) {
  const ol = $('histList');
  const hist = rec?.history || [];
  $('histCount').textContent = hist.length;
  ol.innerHTML = '';
  for (const h of [...hist].reverse()) {
    const li = document.createElement('li');
    const when = new Date(h.at).toLocaleString('ja-JP', {
      year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
    const label = { import: 'Notionから取り込み', create: 'アプリ内で作成', 'notion-change': 'Notion側で変更', 'local-edit': 'アプリで編集', 'local-delete': 'アプリで削除', 'local-reset': '編集を取消' }[h.type] || h.type;
    let inner = `<span class="when">${when}</span> ${label}`;
    if (h.note) inner += `<br>${h.note}`;
    for (const c of h.changes || []) {
      inner += `<br>・${c.label}: ${fmtVal(c.from)} → ${fmtVal(c.to)}` +
        (c.kept ? ' <span class="kept">（アプリ側の値を保持）</span>' : '');
    }
    li.innerHTML = inner;
    ol.appendChild(li);
  }
}

function fmtVal(v) {
  if (v === null || v === undefined || v === '') return '（空）';
  if (Array.isArray(v)) return v.length ? v.map((x) => state.projects[x]?.name || x).join(', ') : '（空）';
  return String(v);
}

async function saveSheet() {
  const nowISO = new Date().toISOString();
  const slotRaw = $('fSlot').value;
  const patch = {
    title: $('fTitle').value.trim() || '(無題)',
    date: $('fDate').value || null,
    due: $('fDue').value || null,
    slotIndex: slotRaw === '' ? null : Number(slotRaw),
    status: $('fStatus').value,
    memo: $('fMemo').value,
  };
  patch.statusGroup = patch.status === '完了' ? 'done'
    : patch.status === 'やらない' ? 'dropped'
    : (patch.status === '進行中' || patch.status === '停止中') ? 'doing' : 'todo';

  if (state.editingId) {
    const rec = state.records.get(state.editingId);
    const { record } = applyLocalEdit(rec, patch, nowISO);
    state.records.set(record.id, record);
    await db.putRecord(record);
  } else {
    const rec = newLocalRecord(patch, nowISO);
    rec.memo = patch.memo || '';
    state.records.set(rec.id, rec);
    await db.putRecord(rec);
    if (patch.date) { state.sel = patch.date; state.tab = 'day'; }
  }
  closeSheets();
  render();
}

async function deleteFromSheet() {
  const rec = state.records.get(state.editingId);
  if (!rec) return;
  const msg = rec.source === 'local'
    ? 'この予定を削除します。よろしいですか？'
    : 'アプリ側でのみ削除します（Notionには反映されません）。よろしいですか？';
  if (!confirm(msg)) return;

  if (rec.source === 'local') {
    state.records.delete(rec.id);
    await db.deleteRecordHard(rec.id);
  } else {
    const next = markDeleted(rec, new Date().toISOString());
    state.records.set(next.id, next);
    await db.putRecord(next);
  }
  closeSheets();
  render();
}

// ---------------------------------------------------------------------------
// メニュー
// ---------------------------------------------------------------------------

function openMenu() {
  $('optShowDone').checked = state.opts.showDone;
  $('optShowDeleted').checked = state.opts.showDeleted;
  const s = state.lastSync;
  $('menuMeta').innerHTML = [
    `保存件数: ${state.records.size}`,
    s ? `最終同期: ${new Date(s.at).toLocaleString('ja-JP')}` : '未同期',
    s?.generatedAt ? `データ生成: ${new Date(s.generatedAt).toLocaleString('ja-JP')}` : '',
  ].filter(Boolean).join('<br>');
  showSheet($('menuSheet'));
}

async function doExport() {
  const data = await db.exportAll();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `lifebear-backup-${todayKey()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

async function doImport(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const n = await db.importAll(JSON.parse(await file.text()));
    state.records.clear();
    for (const r of await db.getAllRecords()) state.records.set(r.id, r);
    state.projects = await db.getMeta('projects', {});
    render();
    alert(`${n} 件を読み込みました。`);
  } catch (err) {
    alert(`読み込みに失敗しました: ${err.message}`);
  } finally {
    e.target.value = '';
  }
}

// ---------------------------------------------------------------------------

function showSheet(el) {
  $('backdrop').hidden = false;
  el.hidden = false;
}
function closeSheets() {
  $('backdrop').hidden = true;
  $('sheet').hidden = true;
  $('menuSheet').hidden = true;
  state.editingId = null;
}

boot();
