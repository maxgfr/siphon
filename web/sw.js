/**
 * Offline shell only.
 *
 * The app is useless without a network — the whole point is fetching remote
 * media — so this caches just enough that opening the icon on a flaky phone
 * connection shows the UI instead of the browser's dinosaur.
 *
 * Deliberately NOT cached: anything under /api/, and the downloaded files
 * themselves. Caching a 400 MB video into the Cache API would fill the device's
 * storage quota and, on iOS, get the whole origin's storage evicted.
 */
const CACHE = 'siphon-v5';
const SHELL = [
  './', './index.html', './styles.css', './manifest.webmanifest', './icon.svg',
  './app.js', './api.js', './errors.js', './links.js', './config.json', './instances.json',
  // Everything api.js imports. A module missing from this list is fetched
  // from the network on the first visit, before the worker controls the
  // page, and so is not in the cache when the network goes: the shell then
  // opens to a module that fails to load.
  './endpoint.js', './instances.js',
  // The in-browser extractor. Small enough to precache, and the reason the app
  // can do anything at all with no network to a server of ours.
  './inbrowser.js', './extract.js', './net.js', './m3u8.js', './media.js', './store.js', './ffmpeg-worker.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // backends are never ours to cache
  if (url.pathname.includes('/api/')) return;

  // Network first, so a deploy is picked up on the next load rather than
  // needing the user to clear site data; the cache is the fallback.
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request).then((hit) => hit || caches.match('./index.html'))),
  );
});
