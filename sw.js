const CACHE_NAME = 'meno-guide-cache-v1';
const urlsToCache = [
  '/',
  '/index.html',
  '/favicon-96x96.png',
  '/favicon.svg',
  '/favicon.ico',
  '/apple-touch-icon.png',
  '/site.webmanifest'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('Opened cache');
        return cache.addAll(urlsToCache);
      })
  );
});

self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        if (response) {
          return response; // Return from cache
        }
        return fetch(event.request); // Fetch from network
      })
  );

});
// This code should be in your sw.js file

// When the new service worker is installing, this tells it to become active immediately.
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

// After the new service worker is active, this tells it to take control of all open pages.
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});
