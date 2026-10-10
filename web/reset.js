// Notausgang für Geräte, die eine alte Version festhalten: /reset verwirft Service Worker und Zwischenspeicher (nicht localStorage = Profil) und lädt die App neu.
// Die Seite selbst wird immer frisch vom Server geladen (Navigationen gehen auch beim alten Service Worker zuerst ins Netz).
;(async () => {
  const done = (msg) => { document.getElementById('title').textContent = msg; document.getElementById('go').hidden = false }
  try {
    const regs = (await navigator.serviceWorker?.getRegistrations?.()) ?? []
    await Promise.all(regs.map((r) => r.unregister()))
    if (window.caches) await Promise.all((await caches.keys()).map((k) => caches.delete(k)))
  } catch { /* weiter */ }
  done('Fertig – Quissel wird neu geladen … / Done – reloading …')
  setTimeout(() => location.replace('/?r=' + Date.now()), 800)
})()
