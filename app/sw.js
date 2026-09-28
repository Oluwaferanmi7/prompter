// Offline cache for the app shell. Stale-while-revalidate: opens instantly (even with
// no signal on set), fetches updates in the background for the next launch.
const VERSION = 'prompter-v15';
const SHELL = [
  './',
  'index.html',
  'app.css',
  'manifest.webmanifest',
  'js/main.js',
  'js/prompter.js',
  'js/remote.js',
  'js/controls.js',
  'js/cloud.js',
  'js/config.js',
  'js/home.js',
  'js/importer.js',
  'js/engine.js',
  'js/library.js',
  'js/link.js',
  'js/render.js',
  'js/store.js',
  'js/voice.js',
  'js/takelog.js',
  'js/wakelock.js',
  'vendor/peerjs.min.js',
  'vendor/nosleep-media.js',
  'fonts/cormorant-garamond.woff2',
  'fonts/inter.woff2',
  'icons/sapphire-mark.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(VERSION)
      // cache: 'reload' skips the browser's HTTP cache, which can hold the previous
      // version for ~10 minutes after a deploy and would get saved as the "new" one.
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // PeerJS signalling etc. go straight to network
  e.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const cached = await cache.match(req, { ignoreSearch: true });
      const network = fetch(req, { cache: 'no-cache' })
        .then((res) => {
          if (res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => null);
      if (cached) {
        e.waitUntil(network);
        return cached;
      }
      const res = await network;
      return res || (req.mode === 'navigate' ? cache.match('index.html') : Response.error());
    })
  );
});
