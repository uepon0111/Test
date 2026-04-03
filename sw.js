/**
 * sw.js - Harmonia Service Worker
 * - App shell (HTML/CSS/JS/fonts) をキャッシュしてオフラインでも起動可能にする
 * - 音声ファイル・Drive API レスポンスはキャッシュしない
 */

const CACHE_NAME = 'harmonia-v7';

// キャッシュするリソース（アプリシェル）
const CACHE_URLS = [
    './',
    './index.html',
    './style.css',
    './app.js',
    './manifest.json',
    './icons/icon.svg',
    'https://fonts.googleapis.com/css2?family=Material+Symbols+Rounded:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200',
    'https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@300;400;500;700&display=swap',
    'https://cdn.jsdelivr.net/npm/chart.js',
    'https://cdnjs.cloudflare.com/ajax/libs/jsmediatags/3.9.5/jsmediatags.min.js'
];

// キャッシュしないドメイン（Drive / Google API / OAuth）
const NO_CACHE_PATTERNS = [
    /googleapis\.com/,
    /accounts\.google\.com/,
    /gsi\/client/
];

// ── Install ──────────────────────────────────────
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            // 失敗しても全体が止まらないよう個別にキャッシュ
            return Promise.allSettled(
                CACHE_URLS.map(url =>
                    cache.add(url).catch(err => console.warn('SW cache miss:', url, err))
                )
            );
        }).then(() => self.skipWaiting())
    );
});

// ── Activate ─────────────────────────────────────
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(
                keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
            )
        ).then(() => self.clients.claim())
    );
});

// ── Fetch ─────────────────────────────────────────
self.addEventListener('fetch', (event) => {
    const url = event.request.url;

    // Drive / OAuth / Google APIs → キャッシュせずそのまま通す
    if (NO_CACHE_PATTERNS.some(pat => pat.test(url))) {
        return; // デフォルト fetch
    }

    // POST / PUT 等はキャッシュ対象外
    if (event.request.method !== 'GET') return;

    // Network First（アプリシェル）→ オフラインならキャッシュフォールバック
    event.respondWith(
        fetch(event.request)
            .then(response => {
                // 正常レスポンスをキャッシュに保存
                if (response && response.status === 200 && response.type !== 'opaque') {
                    const cloned = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, cloned));
                }
                return response;
            })
            .catch(() => {
                // オフライン時：キャッシュから返す
                return caches.match(event.request).then(cached => {
                    if (cached) return cached;
                    // ナビゲーションリクエストにはindex.htmlを返す
                    if (event.request.mode === 'navigate') {
                        return caches.match('./index.html');
                    }
                    return new Response('Offline', { status: 503 });
                });
            })
    );
});

