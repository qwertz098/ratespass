const $ = (id) => document.getElementById(id)
let status = 'pending'
$('token').value = sessionStorage.getItem('rp.admin') ?? ''

const call = async (method, path, body) => {
  const res = await fetch(path, { method, headers: { 'content-type': 'application/json', 'x-admin-token': $('token').value }, body: body ? JSON.stringify(body) : undefined })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json.message || json.error || res.status)
  return json
}
const toast = (m) => { $('toast').textContent = m; $('toast').classList.add('show'); setTimeout(() => $('toast').classList.remove('show'), 2500) }
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids.flat().filter((k) => k != null)); return e }

async function load() {
  sessionStorage.setItem('rp.admin', $('token').value)
  try {
    const { questions } = await call('GET', `/api/admin/queue?status=${status}`)
    $('list').replaceChildren(...(questions.length ? questions.map(card) : [el('div', { className: 'empty' }, 'Nichts offen 🎉')]))
    const s = await call('GET', '/api/admin/stats')
    const total = s.questions.reduce((a, r) => a + (r.status === 'active' ? r.n : 0), 0)
    $('stats').textContent = `Aktive Fragen: ${total} · Spieler: ${s.players.n} · Batches: ${s.batches.map((b) => b.name).join(', ') || '—'}`
  } catch (e) { toast('Fehler: ' + e.message) }
}

function card(q) {
  const field = (v, rows) => (rows ? el('textarea', { value: v, rows }) : el('input', { type: 'text', value: v }))
  const text = field(q.text, 2), correct = field(q.correct), wrong = q.wrong.map((w) => field(w))
  const act = (action, label, cls = '') => el('button', { className: 'btn small ' + cls, textContent: label, onclick: async () => {
    try {
      await call('POST', `/api/admin/questions/${q.id}`, { action, patch: action === 'approve' || action === 'activate'
        ? { text: text.value, correct: correct.value, wrong: wrong.map((w) => w.value) } : undefined })
      toast('OK'); load()
    } catch (e) { toast('Fehler: ' + e.message) } } })
  return el('div', { className: 'card stack' },
    el('div', { className: 'row' }, el('span', { className: 'badge', textContent: `${q.lang} · ${q.category} · d${q.difficulty}` }), el('span', { className: 'muted grow', textContent: `${q.source} · ${q.license}` }),
      q.reports ? el('span', { className: 'badge bad', textContent: `${q.reports} Meldungen` }) : null),
    q.reasons ? el('div', { className: 'hint', textContent: 'Gründe: ' + q.reasons }) : null,
    text, correct, wrong, el('div', { className: 'row' }, act('approve', 'Freigeben', 'primary'), act('reject', 'Ablehnen', 'danger')))
}

$('export').onclick = async () => {
  try {
    const res = await fetch('/api/admin/community-batch?mark=1', { headers: { 'x-admin-token': $('token').value } })
    if (res.status === 404) return toast('Nichts zu exportieren')
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
if ($('token').value) load()
