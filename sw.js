const CACHE_NAME = 'kraft-v5';
const urlsToCache = [
    '/',
    '/index.html',
    '/manifest.json',
    'https://cdn.tailwindcss.com',
    'https://cdn.jsdelivr.net/npm/sortablejs@latest/Sortable.min.js',
    'https://cdn.jsdelivr.net/npm/canvas-confetti@1.6.0/dist/confetti.browser.min.js'
];

self.addEventListener('install', event => {
    // Force immediate takeover
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => {
                // Ignore failure on optional CDNs, focus on core files
                return Promise.allSettled(urlsToCache.map(url => {
                    return fetch(url).then(r => {
                        if (r.ok) cache.put(url, r.clone());
                    }).catch(err => {
                        console.log('SW Cache Failed for', url, err);
                    });
                }));
            })
    );
});

self.addEventListener('activate', event => {
    // Delete old caches
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.map(cacheName => {
                    if (cacheName !== CACHE_NAME) {
                        return caches.delete(cacheName);
                    }
                })
            );
        })
    );
    self.clients.claim();
});

self.addEventListener('fetch', event => {
    if (event.request.method !== 'GET') return;

    event.respondWith(
        fetch(event.request)
            .then(response => {
                // If network fetch successful, update the cache
                if (response && response.status === 200 && (response.type === 'basic' || response.type === 'cors')) {
                    const responseToCache = response.clone();
                    caches.open(CACHE_NAME).then(cache => {
                        cache.put(event.request, responseToCache);
                    });
                }
                return response;
            })
            .catch(() => {
                // If offline, try to serve from cache
                return caches.match(event.request).then(cachedResponse => {
                    if (cachedResponse) {
                        return cachedResponse;
                    }
                    if (event.request.mode === 'navigate') {
                        return caches.match('/');
                    }
                    return null;
                });
            })
    );
});
