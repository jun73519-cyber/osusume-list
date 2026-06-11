// おすすめリスト Service Worker
// アプリ本体（同一オリジンの静的ファイル）はキャッシュしてオフライン対応。
// GAS(クラウド)へのデータ通信はキャッシュせず常に最新を取得する。
const CACHE_NAME = 'osusume-list-v3';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try {
    url = new URL(req.url);
  } catch (_) {
    return;
  }

  // GAS など別オリジン（データ通信）は SW で触らず、ブラウザに任せる（常に最新）
  if (url.origin !== self.location.origin) return;

  // 画面遷移(HTML)はネットワーク優先 → 新デプロイを即反映。失敗時のみキャッシュにフォールバック
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put('./index.html', copy));
          }
          return res;
        })
        .catch(() => caches.match('./index.html').then((r) => r || new Response('', { status: 503 })))
    );
    return;
  }

  // その他の同一オリジン資産: キャッシュ優先＋裏で更新
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => cached || new Response('', { status: 503 }));
      return cached || network;
    })
  );
});
