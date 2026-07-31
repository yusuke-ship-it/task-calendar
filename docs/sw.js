/* Service Worker（第3章：オフライン動作 / iPhoneホーム画面からの全画面起動）
   - アプリ本体：cache-first（オフラインでも即起動）
   - data/tasks.json：network-first（オンラインなら最新、オフラインなら前回分）
   キャッシュ名の版を上げると旧キャッシュを破棄して更新される。 */

const VERSION = 'v2';
const SHELL_CACHE = `shell-${VERSION}`;
const DATA_CACHE = `data-${VERSION}`;

const SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/core.js',
  './js/db.js',
  './js/crypto.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(SHELL_CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== SHELL_CACHE && k !== DATA_CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // 取り込みデータ：network-first
  if (url.pathname.endsWith('/data/tasks.json')) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(DATA_CACHE).then((c) => c.put('tasks.json', copy));
          return res;
        })
        .catch(() => caches.open(DATA_CACHE).then((c) => c.match('tasks.json')))
    );
    return;
  }

  // アプリ本体：cache-first + 背景更新
  e.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(SHELL_CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => hit);
      return hit || net;
    })
  );
});
