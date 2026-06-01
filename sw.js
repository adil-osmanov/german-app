const CACHE_NAME = 'kraft-v7';
const URLS_TO_CACHE = [
    '/',
    '/index.html',
    '/manifest.json'
];

self.addEventListener('install', event => {
    self.skipWaiting(); // Activate new SW immediately
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => cache.addAll(URLS_TO_CACHE))
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
        ).then(() => self.clients.claim()) // Take control of all clients immediately
    );
});

self.addEventListener('fetch', event => {
    if (event.request.method !== 'GET') return;
    
    // Never cache API requests - always go network
    const url = event.request.url;
    if (url.includes('/words') || url.includes('/history') || url.includes('/profiles') ||
        url.includes('/progress') || url.includes('/score') || url.includes('/artifacts')) {
        return; 
    }
    event.respondWith(
        fetch(event.request).catch(() => caches.match(event.request).then(res => res || caches.match('/')))
    );
});