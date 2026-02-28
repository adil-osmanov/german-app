const CACHE_NAME = 'woerterbuch-v3';

const STATIC_ASSETS = [
    '/',
    '/index.html',
    '/icon.png',
    '/manifest.json'
];

self.addEventListener('install', (e) => {
    self.skipWaiting();
    e.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)));
});

self.addEventListener('activate', (e) => {
    self.clients.claim();
    e.waitUntil(
        caches.keys().then((keys) => Promise.all(
            keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
        ))
    );
});

self.addEventListener('fetch', (e) => {
    // Игнорируем запросы к серверу за словами, пусть с ними разбирается index.html
    if (e.request.method !== 'GET' || e.request.url.includes('/words')) {
        return;
    }

    // Для стилей, иконок и HTML — используем стратегию "Сначала сеть, потом кеш"
    e.respondWith(
        fetch(e.request).then(response => {
            const cloned = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(e.request, cloned));
            return response;
        }).catch(() => caches.match(e.request))
    );
});