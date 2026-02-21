const CACHE_NAME = 'woerterbuch-v1';

// Список файлов, которые сохранятся в памяти телефона
const STATIC_ASSETS = [
    '/',
    '/index.html',
    '/icon.png',
    '/manifest.json'
];

// 1. Установка: браузер скачивает и прячет статику в кеш
self.addEventListener('install', (e) => {
    e.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
    );
    self.skipWaiting();
});

// 2. Активация: удаляем старый мусор, если выйдет новая версия
self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys().then((keys) => {
            return Promise.all(
                keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
            );
        })
    );
    self.clients.claim();
});

// 3. Магия офлайна: перехват всех запросов
self.addEventListener('fetch', (e) => {
    
    // Если приложение запрашивает слова с сервера (/words)
    if (e.request.url.includes('/words')) {
        // Стратегия "Network First" (Сначала сеть, потом кеш)
        e.respondWith(
            fetch(e.request)
                .then((response) => {
                    // Интернет есть! Сохраняем свежие слова в кеш на будущее
                    const clonedResponse = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clonedResponse));
                    return response;
                })
                .catch(() => {
                    // Интернета нет (офлайн). Достаем последние сохраненные слова!
                    return caches.match(e.request);
                })
        );
    } else {
        // Для обычных файлов (HTML, картинки, манифест)
        // Стратегия "Cache First" (Отдаем мгновенно из кеша)
        e.respondWith(
            caches.match(e.request).then((cachedResponse) => {
                return cachedResponse || fetch(e.request);
            })
        );
    }
});