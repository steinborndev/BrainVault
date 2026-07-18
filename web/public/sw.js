/**
 * Minimal service worker — just enough to make BrainVault installable as a PWA
 * (TASKS-M3 §2 "PWA-ready"). It caches the app shell for offline launch; API and SSE
 * requests are always network (they are localhost and inherently live), never cached.
 */
const CACHE = 'brainvault-shell-v1'
const SHELL = ['/', '/index.html', '/favicon.svg', '/manifest.webmanifest']

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)))
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))),
  )
  self.clients.claim()
})

/** Old hashed bundles accumulate forever without a cap — trim beyond this many entries. */
const MAX_ASSET_ENTRIES = 60

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  // Never intercept the API or the SSE stream — they must hit the network live.
  if (url.pathname.startsWith('/api/')) return
  if (event.request.method !== 'GET') return
  // Network-first for navigations so a rebuilt shell is picked up; fall back to cache offline.
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        // Only cache real successes — caching a 500/404 would replay the failure offline.
        if (res.ok) {
          const copy = res.clone()
          caches
            .open(CACHE)
            .then(async (c) => {
              await c.put(event.request, copy)
              if (url.pathname.startsWith('/assets/')) await trimAssets(c)
            })
            .catch(() => {})
        }
        return res
      })
      .catch(() => caches.match(event.request).then((r) => r ?? caches.match('/index.html'))),
  )
})

/** Drops the oldest hashed-asset entries once the cache grows past the cap (rough FIFO). */
async function trimAssets(cache) {
  const keys = await cache.keys()
  const assets = keys.filter((req) => new URL(req.url).pathname.startsWith('/assets/'))
  for (const req of assets.slice(0, Math.max(0, assets.length - MAX_ASSET_ENTRIES))) {
    await cache.delete(req)
  }
}
