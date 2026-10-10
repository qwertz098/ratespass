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
function showPanel() {
  $('login').hidden = true; $('panel').hidden = false; $('logout').hidden = false
  fetch('/api/meta').then((r) => r.json()).then((m) => { for (const c of m.categories ?? []) $('stcat').append(el('option', { value: c, textContent: c })) }).catch(() => {})
  load()
}

const KIND = { wrong: 'falsch', wording: 'Formulierung' }, PART = { question: 'Frage', answers: 'Antworten' }
const REGIONS = ['global', 'dach']

async function load() {
  try {
    $('searchbar').hidden = status !== 'search'
    $('statbar').hidden = status !== 'stats'
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
    } else if (status === 'stats') {
      list.push(...(await statsCards()))
    } else if (status === 'lb') {
      list.push(...(await lbCards()))
    } else if (status === 'wordle') {
      list.push(...(await wordleCards()))
    } else if (status === 'ai') {
      list.push(...(await aiCards()))
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

const pct = (r) => (r === null || r === undefined ? '–' : Math.round(r * 100) + ' %')
const DIFF = { 1: 'leicht', 2: 'mittel', 3: 'schwer' }

/** Lösungen vs. Alter: Überblick und Fragenliste mit Vorschlag zur Schwierigkeit. */
async function statsCards() {
  const ov = await call('GET', '/api/admin/stats/overview')
  const p = new URLSearchParams({ category: $('stcat').value, difficulty: $('stdiff').value, min_n: $('stmin').value || '30', sort: $('stsort').value, limit: '50' })
  const { questions, total } = await call('GET', `/api/admin/stats/questions?${p}`)
  const bands = ov.bands
  const cell = (d, b) => ov.by_difficulty_age.find((r) => r.difficulty === d && r.band === b)
  const table = el('table', { className: 'stat' },
    el('thead', {}, el('tr', {}, el('th', { textContent: 'Schwere' }), el('th', { textContent: 'Antworten' }), el('th', { textContent: 'Quote' }), ...bands.map((b) => el('th', { textContent: b === '?' ? 'k. A.' : b })))),
    el('tbody', {}, ...[1, 2, 3].map((d) => { const r = ov.by_difficulty.find((x) => x.difficulty === d)
      return el('tr', {}, el('td', { textContent: DIFF[d] }), el('td', { textContent: r ? r.n : 0 }), el('td', { textContent: pct(r?.rate) }), ...bands.map((b) => el('td', { textContent: pct(cell(d, b)?.rate), title: 'n=' + (cell(d, b)?.n ?? '–') }))) })))
  const head = el('div', { className: 'card stack' },
    el('div', { className: 'hint', textContent: `Lösungsquote nach Schwierigkeit und Altersgruppe (Gruppen unter ${ov.min_group} Antworten ausgeblendet). Spieler mit Geburtsjahr: ${ov.players.with_year} von ${ov.players.total}. Richtwerte: ab ${pct(ov.thresholds.easy)} leicht, ab ${pct(ov.thresholds.medium)} mittel, darunter schwer (Ratequote 25 %).` }),
    el('div', { style: 'overflow-x:auto' }, table),
    el('button', { className: 'btn small', textContent: 'Alle Vorschläge übernehmen', title: 'Setzt die Schwierigkeit aller Fragen mit genug Antworten auf den Vorschlag (wird in den Korrekturen protokolliert)', onclick: guarded(async () => {
      if (!confirm(`Schwierigkeit aller Fragen mit mindestens ${$('stmin').value || 30} Antworten angleichen?`)) return
      const r = await call('POST', '/api/admin/stats/apply-difficulty', { min_n: Number($('stmin').value) || 30 }); toast(r.changed + ' Fragen angepasst'); load() }) }))
  const rows = questions.map((q) => el('div', { className: 'card stack' },
    el('div', { className: 'row wrap' }, el('span', { className: 'badge', textContent: `${q.category} · ${DIFF[q.difficulty]}` }),
      q.suggested && q.suggested !== q.difficulty ? el('span', { className: 'badge bad', textContent: 'Vorschlag: ' + DIFF[q.suggested] }) : q.suggested ? el('span', { className: 'badge good', textContent: 'passt' }) : null,
      el('span', { className: 'muted grow', textContent: `${q.n} Antworten · ${pct(q.rate)} richtig · Ø ${(q.avg_ms / 1000).toFixed(1)} s` })),
    el('div', { textContent: q.text }),
    el('div', { className: 'hint', textContent: bands.filter((b) => q.by_age[b]?.n).map((b) => `${b === '?' ? 'k. A.' : b}: ${pct(q.by_age[b].rate)} (${q.by_age[b].n})`).join(' · ') || 'Keine Altersgruppe mit genug Antworten' }),
    q.suggested && q.suggested !== q.difficulty ? el('button', { className: 'btn small primary', textContent: 'Schwierigkeit übernehmen', onclick: guarded(async () => {
      await call('POST', '/api/admin/stats/apply-difficulty', { group_id: q.group_id, min_n: Number($('stmin').value) || 30 }); toast('Angepasst'); load() }) }) : null))
  return [head, ...(rows.length ? rows : [el('div', { className: 'empty', textContent: 'Noch keine Frage mit genug Antworten' })]), el('div', { className: 'hint', textContent: `${questions.length} von ${total} Fragen` })]
}

/** Bestenliste: statistisch auffällige Spieler prüfen und bei Bedarf aus der Liste sperren (keine automatische Sperre). */
async function lbCards() {
  const { flags, banned } = await call('GET', '/api/admin/lb/flags')
  const ban = (id, b) => guarded(async () => { await call('POST', '/api/admin/lb/ban', { public_id: id, banned: b }); toast(b ? 'Gesperrt' : 'Entsperrt'); load() })
  const head = el('div', { className: 'card hint', textContent: 'Auffällig ab 200 Antworten: Quote über 97 %, weit besser als andere bei denselben Fragen, sehr gleichförmige Antwortzeiten oder Aktivität rund um die Uhr. Das sind Hinweise, keine Beweise – bitte prüfen, bevor du sperrst.' })
  const cards = flags.map((f) => el('div', { className: 'card stack' },
    el('div', { className: 'row wrap' }, el('strong', { className: 'grow', textContent: `${f.name} · ${f.public_id}` }), f.participating ? el('span', { className: 'badge', textContent: 'nimmt teil' }) : null, f.banned ? el('span', { className: 'badge bad', textContent: 'gesperrt' }) : null),
    el('div', { className: 'hint', textContent: `${f.n} Antworten · Quote ${Math.round(f.rate * 100)} % (erwartet ${Math.round(f.expected * 100)} %) · Zeit-Streuung ${f.cv ?? '–'} · ${f.hours} Tagesstunden aktiv` }),
    el('div', { textContent: f.flags.join(' · ') }),
    el('button', { className: 'btn small ' + (f.banned ? '' : 'danger'), textContent: f.banned ? 'Sperre aufheben' : 'Aus Bestenliste sperren', onclick: ban(f.public_id, !f.banned) })))
  const bl = banned.length ? el('div', { className: 'card stack' }, el('div', { className: 'hint', textContent: 'Gesperrt' }), ...banned.map((b) => el('div', { className: 'row' }, el('span', { className: 'grow', textContent: `${b.name} · ${b.public_id}` }), el('button', { className: 'btn small', textContent: 'Entsperren', onclick: ban(b.public_id, false) })))) : null
  return [head, ...(cards.length ? cards : [el('div', { className: 'empty', textContent: 'Keine Auffälligkeiten 🎉' })]), bl].filter(Boolean)
}

/** Wordle: Kennzahlen, Verlauf je Sprache, Wortlisten (sperren), Wort für einen künftigen Tag festlegen, Gruppen, Auffälligkeiten. */
let wordleQuery = { lang: 'de', q: '' }
async function wordleCards() {
  const o = await call('GET', '/api/admin/wordle?days=14')
  const tile = (label, value) => el('div', { className: 'card' }, el('div', { className: 'hint', textContent: label }), el('div', { style: 'font-size:1.6rem;font-weight:800', textContent: String(value) }))
  const tiles = el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px' },
    tile('Spieler heute', o.players.active_1), tile('aktiv 7 Tage', o.players.active_7), tile('aktiv 30 Tage', o.players.active_30), tile('Spiele heute', o.players.games_today),
    tile('Gruppen', o.groups.total), tile('Gruppen-Mitglieder', o.groups.members), tile('9-Uhr-Erinnerungen', Object.values(o.push).reduce((a, b) => a + b, 0)), tile('Push gesendet (3 Tage)', o.pushes_sent_3d))
  const bars = (d) => { const max = Math.max(1, ...d.dist, d.lost); return el('div', { style: 'display:flex;gap:3px;align-items:flex-end;height:28px' }, ...[...d.dist, d.lost].map((n, i) => el('i', { title: (i < 6 ? (i + 1) + ' Versuche' : 'nicht gelöst') + ': ' + n, style: `display:block;width:12px;border-radius:2px;height:${Math.max(2, Math.round((n / max) * 28))}px;background:${i < 6 ? 'var(--accent)' : 'var(--bad)'}` }))) }
  const langCards = o.langs.map((l) => el('div', { className: 'card stack' },
    el('div', { className: 'row wrap' }, el('strong', { className: 'grow', textContent: `Wordle ${l.lang.toUpperCase()}` }), el('span', { className: 'hint', textContent: `${l.words.solutions} Lösungen · ${l.words.valid} gültige Wörter · ${l.words.banned} gesperrt · Bonus heute: ${l.bonus_today}` })),
    el('div', { style: 'overflow-x:auto' }, el('table', { className: 'stat' },
      el('thead', {}, el('tr', {}, ...['Tag', 'Wort', 'Spiele', 'Gelöst', 'Ø Versuche', '1 … 6 | ✗'].map((h) => el('th', { textContent: h })))),
      el('tbody', {}, ...l.daily.map((d) => el('tr', {}, el('td', { textContent: d.day }), el('td', { textContent: d.word ?? '–' }), el('td', { textContent: `${d.finished}/${d.plays}` }), el('td', { textContent: d.win_rate === null ? '–' : d.win_rate + ' %' }), el('td', { textContent: d.avg_guesses ?? '–' }), el('td', {}, bars(d))))))),
    el('div', { className: 'hint', textContent: 'Kommende Tageswörter: ' + l.upcoming.map((u) => `${u.day.slice(5)} ${u.word ? u.word + (u.forced ? ' ★' : '') : '…'}`).join(' · ') })))
  // Wort festlegen
  const fLang = el('select', {}, ...['de', 'en'].map((x) => el('option', { value: x, textContent: x }))), fDay = el('input', { type: 'date', value: o.today }), fWord = el('input', { type: 'text', maxLength: 5, placeholder: 'Wort', style: 'width:110px' })
  const force = el('div', { className: 'card stack' }, el('div', { className: 'hint', textContent: 'Tageswort für einen künftigen Tag festlegen (heute nur, solange noch niemand gespielt hat). ★ = von dir festgelegt.' }),
    el('div', { className: 'row wrap' }, fLang, fDay, fWord, el('button', { className: 'btn small primary', textContent: 'Festlegen', onclick: guarded(async () => { const r = await call('POST', '/api/admin/wordle/force', { lang: fLang.value, day: fDay.value, word: fWord.value }); toast(`${r.day}: ${r.word}`); load() }) })))
  // Wortlisten
  const { words } = await call('GET', `/api/admin/wordle/words?lang=${wordleQuery.lang}&q=${encodeURIComponent(wordleQuery.q)}`)
  const wl = el('select', {}, ...['de', 'en'].map((x) => el('option', { value: x, textContent: x, selected: x === wordleQuery.lang }))), wq = el('input', { type: 'search', value: wordleQuery.q, placeholder: 'Wortanfang suchen (leer = gesperrte)', maxLength: 5, style: 'width:200px' })
  const ban = (w, b) => guarded(async () => { await call('POST', '/api/admin/wordle/ban', { lang: wordleQuery.lang, word: w, banned: b }); toast(b ? 'Gesperrt' : 'Freigegeben'); load() })
  const list = el('div', { className: 'card stack' }, el('div', { className: 'row wrap' }, wl, wq,
    el('button', { className: 'btn small', textContent: 'Suchen', onclick: () => { wordleQuery = { lang: wl.value, q: wq.value }; load() } }),
    el('button', { className: 'btn small', textContent: 'Listen neu laden', title: 'wordlists/*.txt erneut einlesen (Sperren bleiben)', onclick: guarded(async () => { await call('POST', '/api/admin/wordle/reload', {}); toast('Neu geladen'); load() }) })),
    ...(words.length ? words.map((w) => el('div', { className: 'row' }, el('span', { className: 'grow', textContent: w.word.toUpperCase() }), w.solution ? el('span', { className: 'badge', textContent: 'Lösung' }) : null, w.banned ? el('span', { className: 'badge bad', textContent: 'gesperrt' }) : null,
      el('button', { className: 'btn small' + (w.banned ? '' : ' danger'), textContent: w.banned ? 'Freigeben' : 'Sperren', onclick: ban(w.word, !w.banned) }))) : [el('div', { className: 'hint', textContent: wordleQuery.q ? 'Kein Treffer' : 'Keine gesperrten Wörter' })]))
  const groups = el('div', { className: 'card stack' }, el('div', { className: 'hint', textContent: `${o.groups.total} Gruppen · ${o.groups.members} Mitglieder (Top 15 nach Spielen der letzten 7 Tage)` }),
    ...o.groups.top.map((g) => el('div', { className: 'row' }, el('span', { className: 'grow', textContent: `${g.name} (${g.lang})` }), el('span', { className: 'hint', textContent: `${g.members} Mitglieder · ${g.plays7} Spiele` }))))
  const flags = o.flags.length ? el('div', { className: 'card stack' }, el('div', { className: 'hint', textContent: 'Auffällig (ab 5 Spielen): oft im 1. Versuch gelöst oder Lösungen in unter 5 Sekunden. Hinweise, keine Beweise.' }),
    ...o.flags.map((f) => el('div', { className: 'row' }, el('span', { className: 'grow', textContent: `${f.name} · ${f.public_id}` }), el('span', { className: 'hint', textContent: `${f.games} Spiele · ${f.solved_first_try}× sofort · ${f.solved_fast}× unter 5 s` })))) : null
  return [tiles, ...langCards, force, list, groups, flags].filter(Boolean)
}

/** KI-Schnittstelle: Lücken füllen, Schwierigkeit schätzen, Zielverteilung. Neue Fragen erscheinen unter „Eingereicht“. */
let lastGen = null
async function aiCards() {
  const s = await call('GET', '/api/admin/ai/status')
  const num = (v, min, max) => el('input', { type: 'number', value: v, min, max, style: 'width:72px' })
  const d1 = num(s.target.diff[0], 0, 100), d2 = num(s.target.diff[1], 0, 100), d3 = num(s.target.diff[2], 0, 100), minc = num(s.target.min_per_category, 10, 5000)
  const auto = el('input', { type: 'checkbox', checked: s.auto })
  const run = (label, path, body, done) => el('button', { className: 'btn small', textContent: label, onclick: guarded(async (e) => {
    toast(label + ' …'); const r = await call('POST', path, body); done?.(r); load() }) })
  const head = el('div', { className: 'card stack' },
    el('div', { className: 'hint', textContent: s.enabled ? `Modell ${s.model} · heute ${s.used_today}/${s.daily_limit} Fragen · ${s.pending_ai} KI-Fragen warten auf Freigabe · ${s.unrated} Fragen ohne KI-Schätzung`
      : 'KI ist aus: Auf dem Server fehlt ANTHROPIC_API_KEY. Der Plan unten funktioniert trotzdem.' }),
    el('div', { className: 'row wrap' }, run('Lücken füllen (20)', '/api/admin/ai/generate', { count: 20 }, (r) => { lastGen = r.results }),
      run('Schwierigkeit schätzen (30)', '/api/admin/ai/estimate', { limit: 30 }, (r) => toast(`${r.rated} bewertet`)),
      run('Schätzungen übernehmen (≥ 0,7)', '/api/admin/ai/apply', { min_confidence: 0.7 }, (r) => toast(`${r.changed} angepasst`)),
      el('button', { className: 'btn small', textContent: 'KI-Fragen als Batch exportieren', onclick: guarded(async () => {
        const res = await fetch('/api/admin/community-batch?source=llm&mark=1')
        if (res.status === 404) return toast('Nichts zu exportieren')
        const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'ai.json'
        const a = el('a', { href: URL.createObjectURL(await res.blob()), download: name }); document.body.append(a); a.click(); a.remove() }) })),
    el('div', { className: 'hint', textContent: 'KI-Fragen gehen nie automatisch ins Spiel: Sie landen unter „Eingereicht“, werden dort geprüft und freigegeben.' }))
  const settings = el('div', { className: 'card stack' },
    el('div', { className: 'hint', textContent: 'Zielverteilung je Kategorie (Prozent leicht / mittel / schwer) und Mindestgröße – daraus ergibt sich der Plan.' }),
    el('div', { className: 'row wrap' }, d1, d2, d3, el('span', { className: 'muted', textContent: '% · min.' }), minc,
      el('label', { className: 'row' }, auto, el('span', { className: 'hint', textContent: `Auto-Lauf (alle ${s.auto_interval_hours} h)` })),
      el('button', { className: 'btn small primary', textContent: 'Speichern', onclick: guarded(async () => {
        await call('POST', '/api/admin/ai/settings', { diff: [d1, d2, d3].map((x) => Number(x.value)), min_per_category: Number(minc.value), auto: auto.checked }); toast('Gespeichert'); load() }) })))
  const plan = el('div', { className: 'card stack' }, el('div', { className: 'hint', textContent: `Plan: ${s.total_deficit} Fragen fehlen insgesamt (größte Lücken zuerst)` }),
    ...s.plan.slice(0, 12).map((g) => el('div', { className: 'row' }, el('span', { className: 'grow', textContent: `${g.category} · ${DIFF[g.difficulty]}` }), el('span', { className: 'muted', textContent: `${g.have}/${g.want}` }),
      s.enabled ? el('button', { className: 'btn small', textContent: `+${Math.min(10, g.deficit)}`, onclick: guarded(async () => {
        toast('Erzeuge …'); lastGen = (await call('POST', '/api/admin/ai/generate', { category: g.category, difficulty: g.difficulty, count: Math.min(10, g.deficit) })).results; load() }) }) : null)))
  const result = lastGen ? el('div', { className: 'card stack' }, ...lastGen.map((r) => el('div', { className: 'hint', textContent: `${r.created}/${r.requested} angelegt` + (r.rejected.length ? ' · verworfen: ' + r.rejected.map((x) => x.reason).join('; ') : '') }))) : null
  return [head, result, settings, plan].filter(Boolean)
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
    q.ai_difficulty ? el('div', { className: 'hint', textContent: `KI-Schätzung: ${DIFF[q.ai_difficulty]}${q.ai_confidence != null ? ' (Sicherheit ' + q.ai_confidence + ')' : ''}${q.ai_note ? ' – ' + q.ai_note : ''}` }) : null,
    text, correct, wrong, el('div', { className: 'row' }, act('approve', 'Freigeben', 'primary'), act('reject', 'Ablehnen', 'danger')))
}

$('statbar').addEventListener('submit', (e) => { e.preventDefault(); load() })
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
