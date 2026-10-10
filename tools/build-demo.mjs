// Baut die klickbare Demo (eine einzige HTML-Datei) aus der echten Oberfläche (web/) und einem Mini-Server im Browser (demo/mock.js).
// Verwendung: node tools/build-demo.mjs [ausgabe.html]   (Standard: demo/demo.html)
// Die Datei lässt sich z. B. als Claude-Artifact veröffentlichen oder lokal im Browser öffnen.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const rd = (p) => fs.readFileSync(path.join(root, p), 'utf8')
const out = process.argv[2] ?? path.join(root, 'demo/demo.html')

// Fragen (alle Batches): de immer, en nur wenn vorhanden; r=1 für regionale (dach) Fragen
const qs = []
for (const f of fs.readdirSync(path.join(root, 'batches')).filter((x) => x.endsWith('.json')).sort()) {
  for (const q of JSON.parse(rd('batches/' + f)).questions) {
    const e = { c: q.category, d: q.difficulty, r: (q.region ?? 'global') !== 'global' ? 1 : 0, i: qs.length }
    for (const l of ['de', 'en']) { const c = q.i18n[l]; if (c) e[l] = [c.text, c.correct, ...c.wrong] }
    qs.push(e)
  }
}

// Wordle-Wörter (nur Lösungsliste, genügt für die Demo)
const words = Object.fromEntries(['de', 'en'].map((l) => [l, fs.readFileSync(path.join(root, `wordlists/${l}.solutions.txt`), 'utf8').split('\n').filter(Boolean)]))

// App-Styles; explizites Theme (data-theme) zusätzlich zur System-Einstellung
let css = rd('web/style.css')
const m = css.match(/@media \(prefers-color-scheme: dark\) \{\n {2}:root \{(.*?)\}\n\}/s)
css = css.replace(m[0], `@media (prefers-color-scheme: dark) {\n  :root:not([data-theme="light"]) {${m[1]}}\n}\n:root[data-theme="dark"] {${m[1]}}`)

const i18n = rd('web/i18n.js').replace(/^export /gm, '')
const app = rd('web/app.js').replace(/^import .*\n/, '').replaceAll('confirm(', '(()=>true)(') // confirm() ist im Artifact-Viewer gesperrt
const mock = rd('demo/mock.js')
const img = (f) => 'data:image/jpeg;base64,' + fs.readFileSync(path.join(root, 'demo/assets', f)).toString('base64')
const shots = [
  ['admin-review.jpg', 'Überarbeiten', 'Meldung eines Reviewers mit allen Sprachfassungen zum Mitkorrigieren.'],
  ['admin-search.jpg', 'Suche', 'Fragen nach Text, Antwort oder #ID finden, direkt bearbeiten oder zur Überarbeitung markieren.'],
  ['admin-reviewers.jpg', 'Reviewer', 'Reviewer per Freundescode bestimmen oder entfernen.'],
].map(([f, t, c]) => `<figure><img src="${img(f)}" alt="Admin-Ansicht ${t}"><figcaption><b>${t}.</b> ${c}</figcaption></figure>`).join('')

const html = `<title>Ratespaß Demo</title>
<style>
${css}
${rd('demo/shell.css')}
</style>
<header class="demo-bar">
  <div class="row"><div class="demo-tabs" role="tablist"><button id="tab-app" aria-pressed="true">App</button><button id="tab-mod" aria-pressed="false">Moderation</button></div><button class="demo-reset" id="reset">Demo zurücksetzen</button></div>
  <p class="demo-note">Interaktive Demo mit der echten Oberfläche. Der Server ist hier ein Mini-Nachbau im Browser: Gegner sind Bots, Profil und Spiele bleiben nur in diesem Browser, Push und Konto-Funktionen fehlen. In der Demo bist du Reviewer: nach jeder Antwort erscheint ✎.</p>
</header>
<div id="app"></div>
<div id="toast" role="status" aria-live="polite"></div>
<section id="mod" hidden>
  <p class="demo-note">Der Admin-Bereich braucht einen echten Server und ein Token, daher hier als Screenshots aus der laufenden App.</p>
  <div class="shots">${shots}</div>
</section>
<script>
const QS = ${JSON.stringify(qs)};
const WORDS = ${JSON.stringify(words)};
</script>
<script type="module">
${mock}
${i18n}
${app}
const tabApp = document.getElementById('tab-app'), tabMod = document.getElementById('tab-mod')
const showTab = (mod) => { document.getElementById('app').hidden = mod; document.getElementById('mod').hidden = !mod; tabApp.setAttribute('aria-pressed', String(!mod)); tabMod.setAttribute('aria-pressed', String(mod)) }
tabApp.onclick = () => showTab(false); tabMod.onclick = () => showTab(true)
document.getElementById('reset').onclick = () => { try { localStorage.clear() } catch {} ; DEMO.reset() }
</script>
`
fs.writeFileSync(out, html)
console.log(`${out}: ${Math.round(html.length / 1024)} KB, ${qs.length} Fragen`)
