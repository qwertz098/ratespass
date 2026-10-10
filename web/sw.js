// Service Worker: App-Shell offline verfügbar, API immer live.
importScripts('/sw-version.js') // setzt self.APP_VERSION; ändert sich die Version, ändert sich der importierte Code → der Browser installiert den Service Worker neu
const VERSION = 'rp-' + (self.APP_VERSION || 'dev')
const V = '?v=' + (self.APP_VERSION || 'dev') // der Server stempelt die Adressen der App-Dateien mit der Version (siehe server/app.ts)
const SHELL = ['/', '/app.js' + V, '/i18n.js' + V, '/install.js' + V, '/version.js' + V, '/style.css' + V, '/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-192.png', '/fonts/ClearSans-Bold.woff2']

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()))
})
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys()
    const updated = keys.some((k) => k.startsWith('rp-') && k !== VERSION) // vorher lief schon eine andere Version → Update (nicht Erstinstallation)
    await Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))
    await self.clients.claim()
    // Bei einem Update alle offenen Fenster sofort mit der neuen Oberfläche neu laden (sonst bliebe eine laufende App bis zum nächsten Start alt)
    if (updated) for (const c of await self.clients.matchAll({ type: 'window' })) { try { await c.navigate(c.url) } catch { /* Fenster nicht navigierbar */ } }
  })())
})
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return
  if (url.pathname === '/version.js') { // Version immer vom Server holen (offline: letzte bekannte)
    e.respondWith(caches.open(VERSION).then(async (c) => fetch(e.request).then((r) => { if (r.ok) c.put(e.request, r.clone()); return r }).catch(async () => (await c.match(e.request)) ?? Response.error())))
    return
  }
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(() => caches.match('/')))
    return
  }
  // stale-while-revalidate
  e.respondWith(caches.open(VERSION).then(async (c) => {
    const hit = await c.match(e.request)
    const net = fetch(e.request).then((r) => { if (r.ok) c.put(e.request, r.clone()); return r }).catch(() => hit)
    return hit || net
  }))
})

// --- Web Push ---
self.addEventListener('push', (e) => {
  let data = {}
  try { data = e.data ? e.data.json() : {} } catch { data = { body: e.data ? e.data.text() : '' } }
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const visible = wins.filter((w) => w.visibilityState === 'visible')
    if (visible.length) { visible.forEach((w) => w.postMessage({ type: 'push-refresh' })); return }
    await self.registration.showNotification(data.title || 'Quissel', {
      body: data.body || '', tag: data.tag || 'ratespass', renotify: true,
      icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', data: { url: data.url || '/' },
    })
  })())
})

self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  const url = new URL(e.notification.data?.url || '/', self.location.origin).href
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const win = wins.find((w) => new URL(w.url).origin === self.location.origin)
    if (win) { await win.focus(); if ('navigate' in win) await win.navigate(url).catch(() => {}); return }
    await self.clients.openWindow(url)
  })())
})
