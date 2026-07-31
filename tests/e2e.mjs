/**
 * ヘッドレスブラウザでの動作確認（このクラウド環境内の Chromium を使用。
 * オーナーのPCのChromeには一切触れません）。
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../docs');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

let offline = false;

const server = createServer(async (req, res) => {
  const path = decodeURIComponent(req.url.split('?')[0]);
  const file = join(ROOT, path === '/' ? 'index.html' : path);
  if (offline && file.endsWith('tasks.json')) { res.writeHead(503).end('offline'); return; }
  try {
    await stat(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(await readFile(file));
  } catch { res.writeHead(404).end('not found'); }
});
await new Promise((r) => server.listen(4173, r));

const browser = await chromium.launch();
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};

async function newPage(viewport) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  return { ctx, page, errors };
}

// ---------- 1. iPhone サイズで初期表示 ----------
const iphone = await newPage({ width: 390, height: 844 });
await iphone.page.goto('http://localhost:4173/', { waitUntil: 'networkidle' });
await iphone.page.waitForTimeout(700);

check('JSエラーなしで起動', iphone.errors.length === 0, iphone.errors.join(' | ').slice(0, 200));
check('カレンダーが42マス描画される', (await iphone.page.locator('.cell').count()) === 42);
check('同期ステータスが出る', /同期|新規/.test(await iphone.page.locator('#statusline').innerText()));

const todayTasks = await iphone.page.locator('.panel-body .item').count();
check('今日のタスクが下部リストに出る', todayTasks >= 4, `${todayTasks}件`);
check('時間帯の見出しが出る', (await iphone.page.locator('.panel-body .slot').count()) >= 2);
check('締切バッジが出る（第6章）', (await iphone.page.locator('.badge.due').count()) >= 1);
check('締切超過は強調される', (await iphone.page.locator('.badge.overdue').count()) >= 1);
check('プロジェクト名バッジが出る', (await iphone.page.locator('.badge.proj').count()) >= 1);
check('日付なしタブに件数が出る', (await iphone.page.locator('#undatedCount').innerText()) === '2');
await iphone.page.screenshot({ path: '/tmp/shot-iphone.png' });

// ---------- 2. 完了トグル → IndexedDB 永続化 ----------
const firstTitle = await iphone.page.locator('.panel-body .item .t').first().innerText();
await iphone.page.locator('.panel-body .item .chk').first().click();
await iphone.page.waitForTimeout(300);
const doneNow = await iphone.page.locator('.panel-body .item.done').count();
check('チェックで完了にできる', doneNow >= 1);

await iphone.page.reload({ waitUntil: 'networkidle' });
await iphone.page.waitForTimeout(800);
const stillDone = await iphone.page.evaluate(async () => {
  const db = await new Promise((res) => { const r = indexedDB.open('notion-lifebear'); r.onsuccess = () => res(r.result); });
  const all = await new Promise((res) => { const r = db.transaction('records').objectStore('records').getAll(); r.onsuccess = () => res(r.result); });
  return all.filter((x) => x.local && x.local.statusGroup === 'done').length;
});
check('リロード後も完了状態が残る（IndexedDB永続化）', stillDone >= 1);

// ---------- 3. 編集シートと履歴 ----------
await iphone.page.locator('.panel-body .item').nth(1).click();
await iphone.page.waitForTimeout(200);
check('編集シートが開く', await iphone.page.locator('#sheet').isVisible());
await iphone.page.fill('#fTitle', '書き換えたタイトル');
await iphone.page.fill('#fMemo', '手元メモ');
await iphone.page.click('#sheetSave');
await iphone.page.waitForTimeout(300);
check('編集が反映される', (await iphone.page.locator('.panel-body .item .t').allInnerTexts()).includes('書き換えたタイトル'));
check('編集済バッジが出る', (await iphone.page.locator('.badge.edited').count()) >= 1);

// ---------- 4. 予定の新規追加（ローカル） ----------
await iphone.page.click('#addBtn');
await iphone.page.fill('#fTitle', '歯医者');
await iphone.page.fill('#fDate', new Date().toISOString().slice(0, 10));
await iphone.page.selectOption('#fSlot', '4');
await iphone.page.click('#sheetSave');
await iphone.page.waitForTimeout(300);
check('ローカル予定を追加できる', (await iphone.page.locator('.panel-body .item .t').allInnerTexts()).includes('歯医者'));
check('端末のみバッジが出る', (await iphone.page.locator('.badge.local').count()) >= 1);

// ---------- 5. 差分再取り込み（第7章）をブラウザ上で検証 ----------
const merge = await iphone.page.evaluate(async () => {
  const core = await import('./js/core.js');
  const t0 = { id: 'x1', title: '旧タイトル', status: '未着手', statusGroup: 'todo', date: '2026-08-01',
    dateEnd: null, due: null, slotIndex: 2, slotLabel: '②', slotMinutes: 240, projectIds: [],
    rank: null, habit: null, link: null, fp: 'AAA' };
  let { record } = core.mergeIncoming(null, t0, '2026-07-31T00:00:00Z');
  ({ record } = core.applyLocalEdit(record, { slotIndex: 4 }, '2026-07-31T01:00:00Z'));
  const r = core.mergeIncoming(record, { ...t0, title: '新タイトル', fp: 'BBB' }, '2026-08-01T00:00:00Z');
  return {
    title: core.effective(r.record, 'title'),
    slot: core.effective(r.record, 'slotIndex'),
    memo: r.record.memo,
    unchangedNext: core.mergeIncoming(r.record, { ...t0, title: '新タイトル', fp: 'BBB' }, 'z').action,
  };
});
check('差分あり：未編集項目はNotion値に更新', merge.title === '新タイトル');
check('差分あり：編集済み項目は保持（第7-3-1）', merge.slot === 4);
check('差分あり：旧値がメモに履歴として残る（第7-3-3）', /※Notion「タイトル」旧タイトル → 新タイトル/.test(merge.memo));
check('差分なし：再取り込みしない（第7-2）', merge.unchangedNext === 'unchanged');

// ---------- 6. オフライン動作 ----------
offline = true;
await iphone.page.reload({ waitUntil: 'load' });
await iphone.page.waitForTimeout(1200);
const offlineItems = await iphone.page.locator('.panel-body .item').count();
const offlineStatus = await iphone.page.locator('#statusline').innerText();
check('オフラインでも画面が出る', offlineItems >= 3, `${offlineItems}件表示`);
check('オフライン表示が出る', /オフライン|同期失敗/.test(offlineStatus), offlineStatus.slice(0, 60));
offline = false;

// ---------- 7. 暗号化データの復号 ----------
const { execSync } = await import('node:child_process');
execSync('node scripts/make-sample.mjs --encrypt テスト合言葉', { cwd: resolve(ROOT, '..') });
const enc = await newPage({ width: 390, height: 844 });
enc.page.on('dialog', async (d) => { await d.accept('テスト合言葉'); });
await enc.page.goto('http://localhost:4173/', { waitUntil: 'networkidle' });
await enc.page.waitForTimeout(1500);
check('暗号化データを合言葉で復号して表示できる', (await enc.page.locator('.panel-body .item').count()) >= 3);
await enc.ctx.close();
execSync('node scripts/make-sample.mjs', { cwd: resolve(ROOT, '..') });

// ---------- 8. PC 幅 ----------
const pc = await newPage({ width: 1280, height: 800 });
await pc.page.goto('http://localhost:4173/', { waitUntil: 'networkidle' });
await pc.page.waitForTimeout(800);
check('PC幅でもJSエラーなし', pc.errors.length === 0, pc.errors.join(' | ').slice(0, 160));
check('PC幅で2カラムになる', (await pc.page.locator('.panel').boundingBox()).x > 600);
await pc.page.screenshot({ path: '/tmp/shot-pc.png' });
await pc.ctx.close();

// ---------- 9. タブレット幅 ----------
const tab = await newPage({ width: 834, height: 1112 });
await tab.page.goto('http://localhost:4173/', { waitUntil: 'networkidle' });
await tab.page.waitForTimeout(800);
check('タブレット幅でもJSエラーなし', tab.errors.length === 0, tab.errors.join(' | ').slice(0, 160));
await tab.page.screenshot({ path: '/tmp/shot-tablet.png' });
await tab.ctx.close();

// ---------- 10. PWA 要件 ----------
const mani = await (await fetch('http://localhost:4173/manifest.webmanifest')).json();
check('manifest が standalone', mani.display === 'standalone');
check('manifest にアイコン3種', mani.icons.length === 3);
const swReg = await iphone.page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => !!r));
check('Service Worker が登録される', swReg);

await iphone.ctx.close();
await browser.close();
server.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 件パス`);
process.exit(failed.length ? 1 : 0);
