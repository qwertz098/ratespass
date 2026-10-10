// Impressum & Datenschutz: Text kommt vom Server (/api/privacy), damit er immer zur Konfiguration und zur zugestimmten Version passt.
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids.flat().filter((k) => k != null)); return e }
let lang = 'de'
try { lang = localStorage.getItem('rp.lang') || (navigator.language || 'de').slice(0, 2) } catch { lang = (navigator.language || 'de').slice(0, 2) }
const priv = await fetch('/api/privacy').then((r) => r.json())
const doc = priv[lang] ?? priv.de
document.documentElement.lang = priv[lang] ? lang : 'de'
document.title = doc.title + ' · Quissel'
document.querySelector('h1').textContent = doc.title
document.getElementById('doc').replaceChildren(
  ...doc.sections.map((s) => el('div', { className: 'stack' }, el('h3', { textContent: s.title }), ...(s.paras ?? []).map((p) => el('p', { textContent: p })), s.items ? el('ul', {}, ...s.items.map((i) => el('li', { textContent: i }))) : null)),
  el('p', { className: 'hint', textContent: `Version ${priv.version.slice(0, 8)}${priv.missing.length ? ' · Angaben fehlen: ' + priv.missing.join(', ') : ''}` }))
