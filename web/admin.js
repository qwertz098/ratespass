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

const KIND = { wrong: 'falsch', wording: 'Formulierung' }, PART = { question: 'Frage', answers: 'Antworten' }
const REGIONS = ['global', 'dach']

async function load() {
  try {
    $('searchbar').hidden = status !== 'search'
    const list = []
    if (status === 'review') {
      const { reviews } = await call('GET', '/api/admin/reviews')
      list.push(...reviews.map(reviewCard))
    } else if (status === 'search') {
      const p = new URLSearchParams({ q: $('sq').value, lang: $('slang').value, region: $('sregion').value })
      const { questions } = await call('GET', `/api/admin/search?${p}`)
      list.push(...questions.map((q) => editCard(q, { flag: true })))
    } else if (status === 'reviewers') {
      list.push(await reviewersCard())
    } else {
      const { questions } = await call('GET', `/api/admin/queue?status=${status}`)
      list.push(...questions.map(card))
    }
    $('list').replaceChildren(...(list.length ? list : [el('div', { className: 'empty' }, status === 'search' ? 'Keine Treffer' : 'Nichts offen 🎉')]))
    const s = await call('GET', '/api/admin/stats')
    const total = s.questions.reduce((a, r) => a + (r.status === 'active' ? r.n : 0), 0)
    const dach = s.questions.reduce((a, r) => a + (r.status === 'active' && r.region === 'dach' && r.lang === 'de' ? r.n : 0), 0)
    $('review-count').textContent = s.open_reviews.n ? `(${s.open_reviews.n})` : ''
    $('stats').textContent = `Aktive Fragen: ${total} (davon regional/dach auf Deutsch: ${dach}) · Spieler: ${s.players.n} · Batches: ${s.batches.map((b) => b.name).join(', ') || '—'}`
  } catch (e) { if (!(e instanceof Unauthorized)) toast('Fehler: ' + e.message) }
}

const guarded = (fn) => async () => { try { await fn() } catch (e) { if (!(e instanceof Unauthorized)) toast('Fehler: ' + e.message) } }

/** Bearbeitbare Fassung einer Frage (Text, Antworten, Schwierigkeit, Region); patch() liefert die Änderungen. */
function editor(q) {
  const field = (v, rows) => (rows ? el('textarea', { value: v, rows }) : el('input', { type: 'text', value: v }))
  const text = field(q.text, 2), correct = field(q.correct), wrong = q.wrong.map((w) => field(w))
  const diff = el('select', {}, [1, 2, 3].map((d) => el('option', { value: d, selected: d === q.difficulty }, 'd' + d)))
  const region = el('select', {}, REGIONS.map((r) => el('option', { value: r, selected: r === q.region }, r)))
  return {
    node: el('div', { className: 'stack' }, text, correct, wrong, el('div', { className: 'row' }, diff, region)),
    patch: () => ({ text: text.value, correct: correct.value, wrong: wrong.map((w) => w.value), difficulty: Number(diff.value), region: region.value }),
  }
}
const qBadge = (q) => el('div', { className: 'row' }, el('span', { className: 'badge', textContent: `#${q.id} · ${q.lang} · ${q.category} · ${q.region}` }), el('span', { className: 'muted grow', textContent: `${q.source} · ${q.license} · ${q.status}` }))

/** Frage mit „Speichern“ (Status bleibt) – optional mit Markieren zur Überarbeitung. */
function editCard(q, { flag = false, extra = [] } = {}) {
  const ed = editor(q)
  const save = el('button', { className: 'btn small primary', textContent: 'Speichern', onclick: guarded(async () => {
    await call('POST', `/api/admin/questions/${q.id}`, { action: 'save', patch: ed.patch() }); toast('Gespeichert'); load() }) })
  const row = [save, ...extra]
  if (flag) {
    const part = el('select', {}, Object.entries(PART).map(([v, l]) => el('option', { value: v, textContent: l })))
    const kind = el('select', {}, Object.entries(KIND).map(([v, l]) => el('option', { value: v, textContent: l })))
    row.push(part, kind, el('button', { className: 'btn small', textContent: q.open_reviews ? `Markieren (${q.open_reviews} offen)` : 'Markieren', onclick: guarded(async () => {
      await call('POST', '/api/admin/reviews', { question_id: q.id, part: part.value, kind: kind.value, note: '' }); toast('Zur Überarbeitung markiert'); load() }) }))
  }
  return el('div', { className: 'card stack' }, qBadge(q), ed.node, el('div', { className: 'row' }, row))
}

function reviewCard(r) {
  const main = r.group.find((q) => q.id === r.question_id)
  const editors = r.group.map((q) => ({ q, ed: editor(q) }))
  const mainEd = editors.find((e) => e.q.id === r.question_id).ed
  const by = r.by ? `${r.by.name} (${r.by.public_id})` : 'Admin'
  const saveOther = (q, ed) => el('button', { className: 'btn small', textContent: `${q.lang} speichern`, onclick: guarded(async () => {
    await call('POST', `/api/admin/questions/${q.id}`, { action: 'save', patch: ed.patch() }); toast('Gespeichert'); load() }) })
  return el('div', { className: 'card stack' },
    el('div', { className: 'row' }, el('span', { className: 'badge bad', textContent: `${KIND[r.kind]} · ${PART[r.part]}` }), el('span', { className: 'muted grow', textContent: `von ${by}` })),
    r.note ? el('div', { className: 'hint', textContent: 'Hinweis: ' + r.note }) : null,
    ...editors.map(({ q, ed }) => el('div', { className: 'stack' }, qBadge(q), q.id === r.question_id ? el('div', { className: 'hint', textContent: 'gemeldete Fassung' }) : null, ed.node,
      q.id === r.question_id ? null : el('div', { className: 'row' }, saveOther(q, ed)))),
    el('div', { className: 'row' },
      el('button', { className: 'btn small primary', textContent: 'Korrigiert / erledigt', onclick: guarded(async () => {
        await call('POST', `/api/admin/reviews/${r.id}`, { action: 'resolve', patch: mainEd.patch() }); toast('Erledigt'); load() }) }),
      el('button', { className: 'btn small danger', textContent: 'Verwerfen', onclick: guarded(async () => {
        await call('POST', `/api/admin/reviews/${r.id}`, { action: 'dismiss' }); toast('Verworfen'); load() }) })))
}

async function reviewersCard() {
  const { reviewers } = await call('GET', '/api/admin/reviewers')
  const code = el('input', { type: 'text', placeholder: 'Freundescode, z. B. ABCD-EFGH', maxLength: 12, autocapitalize: 'characters' })
  return el('div', { className: 'card stack' },
    el('p', { className: 'hint', textContent: 'Reviewer sehen beim Spielen einen ✎-Knopf und können Fragen oder Antworten als „falsch“ oder „Formulierung“ melden. Den Code findet die Person unter Profil → Freundescode.' }),
    el('div', { className: 'row' }, code, el('button', { className: 'btn small primary', textContent: 'Hinzufügen', onclick: guarded(async () => {
      await call('POST', '/api/admin/reviewers', { public_id: code.value }); toast('Hinzugefügt'); load() }) })),
    ...(reviewers.length ? reviewers : []).map((r) => el('div', { className: 'row' }, el('span', { className: 'grow', textContent: `${r.name} · ${r.public_id}` }),
      el('button', { className: 'btn small danger', textContent: 'Entfernen', onclick: guarded(async () => {
        await call('DELETE', `/api/admin/reviewers/${r.public_id}`); toast('Entfernt'); load() }) }))),
    reviewers.length ? null : el('div', { className: 'empty', textContent: 'Noch keine Reviewer' }))
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
    el('div', { className: 'row' }, el('span', { className: 'badge', textContent: `${q.lang} · ${q.category} · d${q.difficulty} · ${q.region}` }), el('span', { className: 'muted grow', textContent: `${q.source} · ${q.license}` }),
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
$('searchbar').addEventListener('submit', (e) => { e.preventDefault(); load() })
$('edits').onclick = async () => {
  try {
    const res = await fetch('/api/admin/edits')
    if (res.status === 401) return showLogin('Sitzung abgelaufen – bitte neu anmelden.')
    if (!res.ok) throw new Error(res.status)
    const a = el('a', { href: URL.createObjectURL(await res.blob()), download: 'edits.json' })
    document.body.append(a); a.click(); a.remove()
    toast('edits.json heruntergeladen – mit `npm run apply:edits -- edits.json` ins Repo übernehmen')
  } catch (e) { toast('Fehler: ' + e.message) }
}
$('tabs').onclick = (e) => {
  const b = e.target.closest('button')
  if (!b?.dataset.s) return
  status = b.dataset.s
  for (const x of $('tabs').children) x.setAttribute('aria-pressed', String(x === b))
  load()
}

// Beim Öffnen: gültige Sitzung? Sonst Login.
call('GET', '/api/admin/me').then(showPanel).catch((e) => { if (!(e instanceof Unauthorized)) showLogin(e.status === 404 ? 'Admin-Bereich ist auf dem Server nicht aktiviert.' : '') })
