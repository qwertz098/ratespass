const $ = (id) => document.getElementById(id)
let status = 'pending'

const toast = (m) => { $('toast').textContent = m; $('toast').classList.add('show'); setTimeout(() => $('toast').classList.remove('show'), 2800) }
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids.flat().filter((k) => k != null)); return e }

/** Alle Anfragen laufen über das HttpOnly-Session-Cookie – das Token wird nirgends im Browser gespeichert. */
class Unauthorized extends Error {}
const call = async (method, path, body) => {
  const res = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
  const json = await res.json().catch(() => ({}))
  if (res.status === 401 && !path.endsWith('/login')) {
    showLogin(path.endsWith('/me') ? '' : 'Sitzung abgelaufen – bitte neu anmelden.') // beim ersten Besuch gibt es nichts „Abgelaufenes“
    throw new Unauthorized()
  }
  if (!res.ok) throw Object.assign(new Error(json.message || json.error || res.status), { status: res.status, code: json.error })
  return json
}

function showLogin(msg = '') {
  $('login').hidden = false; $('panel').hidden = true; $('logout').hidden = true
  $('login-msg').textContent = msg
  $('token').value = ''
  $('token').focus()
}
function showPanel() { $('login').hidden = true; $('panel').hidden = false; $('logout').hidden = false; load() }

async function load() {
  try {
    const { questions } = await call('GET', `/api/admin/queue?status=${status}`)
    $('list').replaceChildren(...(questions.length ? questions.map(card) : [el('div', { className: 'empty' }, 'Nichts offen 🎉')]))
    const s = await call('GET', '/api/admin/stats')
    const total = s.questions.reduce((a, r) => a + (r.status === 'active' ? r.n : 0), 0)
    $('stats').textContent = `Aktive Fragen: ${total} · Spieler: ${s.players.n} · Batches: ${s.batches.map((b) => b.name).join(', ') || '—'}`
  } catch (e) { if (!(e instanceof Unauthorized)) toast('Fehler: ' + e.message) }
}

function card(q) {
  const field = (v, rows) => (rows ? el('textarea', { value: v, rows }) : el('input', { type: 'text', value: v }))
  const text = field(q.text, 2), correct = field(q.correct), wrong = q.wrong.map((w) => field(w))
  const act = (action, label, cls = '') => el('button', { className: 'btn small ' + cls, textContent: label, onclick: async () => {
    try {
      await call('POST', `/api/admin/questions/${q.id}`, { action, patch: action === 'approve' || action === 'activate'
        ? { text: text.value, correct: correct.value, wrong: wrong.map((w) => w.value) } : undefined })
      toast('OK'); load()
    } catch (e) { if (!(e instanceof Unauthorized)) toast('Fehler: ' + e.message) } } })
  return el('div', { className: 'card stack' },
    el('div', { className: 'row' }, el('span', { className: 'badge', textContent: `${q.lang} · ${q.category} · d${q.difficulty}` }), el('span', { className: 'muted grow', textContent: `${q.source} · ${q.license}` }),
      q.reports ? el('span', { className: 'badge bad', textContent: `${q.reports} Meldungen` }) : null),
    q.reasons ? el('div', { className: 'hint', textContent: 'Gründe: ' + q.reasons }) : null,
    text, correct, wrong, el('div', { className: 'row' }, act('approve', 'Freigeben', 'primary'), act('reject', 'Ablehnen', 'danger')))
}

$('login').addEventListener('submit', async (e) => {
  e.preventDefault()
  const btn = $('login').querySelector('button'); btn.disabled = true
  try {
    await call('POST', '/api/admin/login', { token: $('token').value.trim() })
    $('token').value = ''; showPanel()
  } catch (err) {
    $('login-msg').textContent = err.status === 429 ? 'Zu viele Fehlversuche – bitte in einigen Minuten erneut versuchen.'
      : err.status === 404 ? 'Admin ist auf dem Server nicht aktiviert (ADMIN_TOKEN, mind. 16 Zeichen).' : 'Token falsch.'
    $('token').value = ''
  } finally { btn.disabled = false }
})
$('logout').onclick = async () => { await fetch('/api/admin/logout', { method: 'POST' }).catch(() => {}); showLogin('Abgemeldet.') }
$('export').onclick = async () => {
  try {
    const res = await fetch('/api/admin/community-batch?mark=1')
    if (res.status === 404) return toast('Nichts zu exportieren')
    if (res.status === 401) return showLogin('Sitzung abgelaufen – bitte neu anmelden.')
    if (!res.ok) throw new Error(res.status)
    const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'community.json'
    const a = el('a', { href: URL.createObjectURL(await res.blob()), download: name })
    document.body.append(a); a.click(); a.remove()
    toast(`${name} heruntergeladen – ins Repo unter batches/ legen und committen`)
  } catch (e) { toast('Fehler: ' + e.message) }
}
$('load').onclick = load
$('tabs').onclick = (e) => {
  if (!e.target.dataset.s) return
  status = e.target.dataset.s
  for (const b of $('tabs').children) b.setAttribute('aria-pressed', String(b === e.target))
  load()
}

// Beim Öffnen: gültige Sitzung? Sonst Login.
call('GET', '/api/admin/me').then(showPanel).catch((e) => { if (!(e instanceof Unauthorized)) showLogin(e.status === 404 ? 'Admin-Bereich ist auf dem Server nicht aktiviert.' : '') })
