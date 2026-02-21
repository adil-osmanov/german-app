const CACHE_NAME = 'woerterbuch-v1';

// Список файлов, которые браузер скачает и спрячет в память телефона
const STATIC_ASSETS = [
    '/',
    '/index.html',
    '/icon.png',
    '/manifest.json'
];

// 1. Установка: кешируем базовую статику
self.addEventListener('install', (e) => {
    e.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
    );
    self.skipWaiting();
});

// 2. Активация: чистим старый кеш, если ты обновишь код
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

// 3. Перехват запросов (основная магия офлайна)
self.addEventListener('fetch', (e) => {
    // Если приложение стучится к базе данных за словами (/words)
    if (e.request.url.includes('/words')) {
        e.respondWith(
            // Сначала пробуем получить свежие данные через интернет
            fetch(e.request)
                .then((response) => {
                    const clonedResponse = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clonedResponse));
                    return response;
                })
                .catch(() => {
                    // Если интернета нет, достаем последние слова из памяти телефона!
                    return caches.match(e.request);
                })
        );
    } else {
        // Для обычных файлов (index.html, картинки) - сразу отдаем из памяти для скорости
        e.respondWith(
            caches.match(e.request).then((cachedResponse) => {
                return cachedResponse || fetch(e.request);
            })
        );
    }
});