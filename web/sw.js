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
// v6: v5 kept shared links as the keys of pages (see the fetch handler), and
// a new name is what sweeps them from a phone that has them.
const CACHE = 'siphon-v6';
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

  // A share or the bookmarklet opens the page as ./?text=… or ./?url=…, and
  // the link in it — a signed address, a token — is out of the address bar
  // the moment the page loads. Kept under that URL, it would sit in Cache
  // Storage instead, one more copy of the page per link. So a page is kept
  // under its bare address, and nothing else with a query is kept at all:
  // the shell has none.
  const key = request.mode === 'navigate' ? url.origin + url.pathname : url.search ? null : request;

  // Network first, so a deploy is picked up on the next load rather than
  // needing the user to clear site data; the cache is the fallback.
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok && key) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(key, copy));
        }
        return response;
      })
      .catch(() => caches.match(key || request).then((hit) => hit || caches.match('./index.html'))),
  );
});
