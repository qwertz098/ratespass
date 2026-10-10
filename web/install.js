// Bebilderte Anleitung „App auf den Startbildschirm legen“ (PWA installieren), je nach Gerät und Browser.
// Die Bilder sind kleine selbstgezeichnete SVGs (keine Screenshots fremder Oberflächen, keine externen Dateien); Farben kommen aus den
// CSS-Variablen der App und folgen damit Hell/Dunkel. Texte stehen in i18n.js (`install.*`).
import { t } from './i18n.js'

/* ---------- Umgebung erkennen ---------- */
export function detectEnv() {
  const ua = navigator.userAgent || ''
  const ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  const android = /Android/i.test(ua)
  const os = ios ? 'ios' : android ? 'android' : 'desktop'
  let browser = 'other'
  if (/SamsungBrowser/i.test(ua)) browser = 'samsung'
  else if (/EdgA|EdgiOS|Edg\//.test(ua)) browser = 'edge'
  else if (/Firefox|FxiOS/.test(ua)) browser = 'firefox'
  else if (/OPR|OPiOS|OPT\//.test(ua)) browser = 'opera'
  else if (/Chrome|CriOS|Chromium/.test(ua)) browser = 'chrome'
  else if (/Safari/.test(ua)) browser = 'safari'
  const standalone = (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true
  return { os, browser, standalone }
}

/* ---------- Bilder (SVG) ---------- */
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const svgEl = (inner) => {
  const doc = new DOMParser().parseFromString(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 140" class="ill" role="img" aria-hidden="true">${inner}</svg>`, 'image/svg+xml')
  return document.importNode(doc.documentElement, true)
}
const ring = (x, y, r = 14) => `<circle class="i-hl i-pulse" cx="${x}" cy="${y}" r="${r}"/>`
const ringR = (x, y, w, h) => `<rect class="i-hl i-pulse" x="${x - 3}" y="${y - 3}" width="${w + 6}" height="${h + 6}" rx="${h / 2 + 3}"/>`
const rows = (x, y, n, w, gap = 16) => Array.from({ length: n }, (_, i) => `<rect class="i-bar" x="${x}" y="${y + i * gap}" width="${w - (i % 3) * 14}" height="6" rx="3"/>`).join('')
const frame = (inner) => `<rect class="i-bg" x="4" y="2" width="232" height="136" rx="14"/>${inner}`
const dots = (x, y) => `<circle class="i-icof" cx="${x}" cy="${y - 7}" r="2.4"/><circle class="i-icof" cx="${x}" cy="${y}" r="2.4"/><circle class="i-icof" cx="${x}" cy="${y + 7}" r="2.4"/>`
const phoneIcon = (x, y) => `<rect class="i-ico" x="${x}" y="${y}" width="9" height="14" rx="2"/><path class="i-ico" d="M${x + 4.5} ${y + 6}v4M${x + 2.5} ${y + 8.5}l2 2 2-2"/>`
const ART = {
  // Browser-Leiste oben, Menü ⋮ rechts
  'menu-top': () => frame(`<rect class="i-pill" x="14" y="12" width="168" height="22" rx="11"/><text class="i-tx" x="26" y="27">quissel</text>${dots(212, 23)}${ring(212, 23)}${rows(20, 56, 5, 190)}`),
  // Browser-Leiste unten, Menü ≡ rechts (Samsung Internet, Edge)
  'menu-bottom': () => frame(`${rows(20, 18, 5, 190)}<rect class="i-pill" x="4" y="106" width="232" height="32" rx="0"/><path class="i-ico" d="M20 122l7-6v12zM60 116v12M76 116v12"/><path class="i-ico" d="M196 117h18M196 122h18M196 127h18"/>${ring(205, 122)}`),
  // Menü-Liste mit hervorgehobener Zeile; tx = Beschriftung der Zeile
  'menu-list': (tx) => frame(`<rect class="i-card" x="58" y="10" width="170" height="120" rx="10"/>${rows(74, 24, 2, 120)}<rect class="i-sel" x="64" y="52" width="158" height="26" rx="8"/>${phoneIcon(72, 58)}<text class="i-txb" x="90" y="69">${esc(tx)}</text>${rows(74, 94, 2, 120)}${ringR(64, 52, 158, 26)}`),
  // Bestätigungsdialog; tx = Beschriftung des Knopfs
  dialog: (tx) => frame(`${rows(20, 14, 3, 190)}<rect class="i-card" x="32" y="34" width="176" height="82" rx="12"/><rect class="i-app" x="46" y="46" width="22" height="22" rx="6"/><text class="i-txb" x="76" y="56">Quissel</text><text class="i-tx" x="76" y="68">quissel…</text><text class="i-tx" x="150" y="104">…</text><rect class="i-btn" x="118" y="90" width="76" height="20" rx="10"/><text class="i-txw" x="156" y="104" text-anchor="middle">${esc(tx)}</text>${ringR(118, 90, 76, 20)}`),
  // iPhone: Safari-Leiste unten mit Teilen-Symbol
  'ios-share': () => frame(`${rows(20, 18, 5, 190)}<rect class="i-pill" x="4" y="100" width="232" height="38" rx="0"/><path class="i-ico" d="M30 114l-6 6 6 6M60 114l6 6-6 6"/><path class="i-ico" d="M112 120v-12M107 112l5-5 5 5M106 117h-3v13h18v-13h-3"/><path class="i-ico" d="M158 112h12v14h-12zM190 112h12v14h-12z"/>${ring(112, 119, 17)}`),
  // iPhone: Teilen-Blatt mit „Zum Home-Bildschirm“
  'ios-sheet': (tx) => frame(`<rect class="i-card" x="14" y="20" width="212" height="116" rx="14"/>${rows(30, 34, 2, 150)}<rect class="i-sel" x="20" y="64" width="200" height="26" rx="8"/><rect class="i-ico" x="30" y="69" width="16" height="16" rx="4"/><path class="i-ico" d="M38 73v8M34 77h8"/><text class="i-txb" x="56" y="81">${esc(tx)}</text>${rows(30, 104, 2, 150)}<path class="i-ico" d="M120 8v8M116 12l4 4 4-4"/>${ringR(20, 64, 200, 26)}`),
  // iPhone: „Hinzufügen“ oben rechts
  'ios-add': (tx) => frame(`<text class="i-tx" x="18" y="22">…</text><text class="i-txb" x="94" y="22" text-anchor="middle">Quissel</text><rect class="i-btn" x="160" y="9" width="66" height="20" rx="10"/><text class="i-txw" x="193" y="23" text-anchor="middle">${esc(tx)}</text>${ringR(160, 9, 66, 20)}<rect class="i-card" x="20" y="48" width="200" height="60" rx="12"/><rect class="i-app" x="32" y="60" width="32" height="32" rx="8"/><text class="i-txb" x="76" y="74">Quissel</text><text class="i-tx" x="76" y="88">quissel…</text>`),
  // Startbildschirm mit dem App-Symbol
  home: (tx) => frame(`${[0, 1, 2, 3].map((c) => [0, 1].map((r) => (c === 1 && r === 1 ? '' : `<rect class="i-icn" x="${22 + c * 52}" y="${16 + r * 52}" width="34" height="34" rx="9"/>`)).join('')).join('')}<rect class="i-app" x="74" y="68" width="34" height="34" rx="9"/><text class="i-txw" x="91" y="91" text-anchor="middle" font-size="18">Q</text><text class="i-tx" x="91" y="116" text-anchor="middle">${esc(tx)}</text>${ring(91, 85, 24)}`),
  // Computer: Installieren-Symbol in der Adressleiste
  'addr-install': () => frame(`<circle class="i-icof" cx="20" cy="18" r="3"/><circle class="i-icof" cx="30" cy="18" r="3"/><circle class="i-icof" cx="40" cy="18" r="3"/><rect class="i-pill" x="54" y="8" width="172" height="22" rx="11"/><text class="i-tx" x="70" y="23">quissel</text><rect class="i-ico" x="188" y="13" width="14" height="12" rx="2"/><path class="i-ico" d="M195 15v6M192 19l3 3 3-3"/>${ring(195, 19, 13)}${rows(20, 52, 5, 190)}`),
}
export const art = (kind, tx) => svgEl(ART[kind](tx))

/* ---------- Anleitungen ---------- */
// Jeder Schritt: Bild + Text (i18n-Schlüssel `install.s.<key>`); `tx` ist die Beschriftung im Bild (i18n-Schlüssel `install.l.<key>`).
const STEPS = {
  'android-chrome': [['menu-top', 'menuTop'], ['menu-list', 'chromeItem', 'installApp'], ['dialog', 'confirm', 'installBtn'], ['home', 'done', 'app']],
  'android-firefox': [['menu-top', 'menuTop'], ['menu-list', 'firefoxItem', 'installFx'], ['dialog', 'confirm', 'add'], ['home', 'done', 'app']],
  'android-samsung': [['menu-bottom', 'menuBottom'], ['menu-list', 'samsungItem', 'addTo'], ['dialog', 'samsungConfirm', 'add'], ['home', 'done', 'app']],
  'android-edge': [['menu-bottom', 'menuBottom'], ['menu-list', 'edgeItem', 'addPhone'], ['dialog', 'confirm', 'add'], ['home', 'done', 'app']],
  'ios-safari': [['ios-share', 'iosShare'], ['ios-sheet', 'iosSheet', 'homeScreen'], ['ios-add', 'iosAdd', 'add'], ['home', 'done', 'app']],
  'desktop-chrome': [['addr-install', 'addr'], ['dialog', 'confirm', 'installBtn'], ['home', 'desktopDone', 'app']],
}
export const GUIDES = [
  ['android-chrome', 'install.g.androidChrome'], ['ios-safari', 'install.g.iosSafari'], ['android-samsung', 'install.g.samsung'],
  ['android-firefox', 'install.g.firefox'], ['android-edge', 'install.g.edge'], ['desktop-chrome', 'install.g.desktop'],
]
/** Welche Anleitung passt zu Gerät und Browser? */
export function guideFor(env = detectEnv()) {
  if (env.os === 'ios') return 'ios-safari' // alle iPhone-Browser nutzen dasselbe Teilen-Blatt von iOS (Safari am zuverlässigsten)
  if (env.os === 'android') return { samsung: 'android-samsung', firefox: 'android-firefox', edge: 'android-edge' }[env.browser] ?? 'android-chrome'
  return 'desktop-chrome'
}

let deferredPrompt = null
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredPrompt = e })
  window.addEventListener('appinstalled', () => { deferredPrompt = null })
}

/** Baut die Anleitung als DOM-Knoten (mit Auswahl „Anderes Gerät/Browser“). `h` ist der Element-Helfer der App. */
export function installGuide(h) {
  const env = detectEnv()
  const box = h('div', { class: 'guide stack' })
  let key = guideFor(env)
  const draw = () => {
    const steps = STEPS[key]
    const note = key === 'ios-safari' ? [env.os === 'ios' && env.browser !== 'safari' ? h('p', { class: 'hint' }, t('install.iosOtherBrowser')) : null, h('p', { class: 'hint' }, t('install.iosPush'))]
      : key === 'desktop-chrome' ? h('p', { class: 'hint' }, t('install.desktopOther')) : null
    box.replaceChildren(...[
      env.standalone ? h('p', { class: 'feedback good' }, '✓ ' + t('install.already')) : null,
      h('div', { class: 'seg wrap' }, GUIDES.map(([k, label]) => h('button', { 'aria-pressed': String(k === key), onclick: () => { key = k; draw() } }, t(label)))),
      deferredPrompt && key === 'android-chrome' ? h('button', { class: 'btn primary block', onclick: async () => { const p = deferredPrompt; deferredPrompt = null; try { await p.prompt() } catch { /* abgebrochen */ } draw() } }, '📲 ' + t('install.now')) : null,
      h('ol', { class: 'steps-guide' }, steps.map(([kind, text, label], i) => h('li', {}, h('div', { class: 'ill-wrap' }, art(kind, label ? t('install.l.' + label) : '')),
        h('div', { class: 'step-text' }, h('b', {}, String(i + 1) + '. '), t('install.s.' + text))))),
      note].flat().filter(Boolean))
  }
  draw()
  return box
}
