const CACHE_NAME = 'kraft-v2';
const URLS_TO_CACHE = [
    '/',
    '/index.html',
    '/manifest.json'
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => cache.addAll(URLS_TO_CACHE))
    );
});

self.addEventListener('fetch', event => {
    if (event.request.method !== 'GET') return;
    
    // Let apiFetch handle API offline fallbacks directly
    if (event.request.url.includes('/words') || event.request.url.includes('/history') || event.request.url.includes('/profiles')) {
        return; 
    }
    event.respondWith(
        fetch(event.request).catch(() => caches.match(event.request).then(res => res || caches.match('/')))
    );
});