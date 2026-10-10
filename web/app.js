import { t, setLang, getLang, detectLang, languages, dict } from './i18n.js'

/* ---------- Helfer ---------- */
const $app = document.getElementById('app')
const $toast = document.getElementById('toast')
const store = {
  get: (k) => { try { return localStorage.getItem(k) } catch { return null } },
  set: (k, v) => { try { localStorage.setItem(k, v) } catch { /* privater Modus */ } },
  del: (k) => { try { localStorage.removeItem(k) } catch { /* ignorieren */ } },
}
const S = { token: store.get('rp.token'), me: null, contacts: [], meta: null }

function h(tag, props, ...kids) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue
    if (k === 'class') el.className = v
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
    else if (k === 'cat') el.dataset.cat = v
    else if (k in el) el[k] = v
    else el.setAttribute(k, v === true ? '' : v)
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)))
  return el
}

let toastTimer
function toast(msg) {
  $toast.textContent = msg
  $toast.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => $toast.classList.remove('show'), 2800)
}

class ApiError extends Error {
  constructor(status, code, message) { super(message || code); this.status = status; this.code = code }
}
async function api(method, path, body, { auth = true } = {}) {
  let res
  try {
    res = await fetch(path, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(auth && S.token ? { authorization: `Bearer ${S.token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch { throw new ApiError(0, 'network') }
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(res.status, json.error || 'generic', json.message)
  return json
}
const errText = (e) => {
  const key = 'err.' + (e.code ?? 'generic')
  return dict[getLang()][key] || dict.en[key] ? t(key, { message: e.message }) : t('err.generic')
}
const guard = (fn) => async (...a) => { try { return await fn(...a) } catch (e) { toast(e instanceof ApiError ? errText(e) : t('err.generic')); console.error(e) } }

const initial = (name) => (name || '?').trim().charAt(0).toUpperCase()
const hue = (s) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7)
function avatar(p, cls = '') {
  const el = h('div', { class: 'avatar ' + cls, 'aria-hidden': 'true' }, p?.is_bot ? '🤖' : initial(p?.name))
  el.style.background = `hsl(${hue(p?.public_id || p?.name || '')} 55% 48%)`
  return el
}
const catChip = (cat) => h('span', { class: 'chip', cat }, t('cat.' + cat))
const inviteUrl = () => `${location.origin}/i/${S.me.public_id}`

/* Kontakte zusätzlich lokal speichern (Spiegel des Servers; stellt ihn wieder her, falls er leer ist). */
const LC_KEY = 'rp.contacts'
function localContacts() {
  try {
    const d = JSON.parse(store.get(LC_KEY) || 'null')
    return d && d.owner === S.me?.public_id && Array.isArray(d.list) ? d.list : []
  } catch { return [] }
}
const setLocalContacts = (list) => store.set(LC_KEY, JSON.stringify({ owner: S.me.public_id, list: list.map((c) => ({ public_id: c.public_id, name: c.name })) }))
function forgetIdentity() { store.del('rp.token'); store.del(LC_KEY); S.token = null; S.me = null; S.contacts = [] }

/** Server-Liste ist maßgeblich. Nur wenn sie komplett leer ist (z. B. Datenbank zurückgesetzt), werden lokale Kontakte nachgetragen. */
async function syncContacts(restore) {
  const local = localContacts()
  if (restore && !S.contacts.length && local.length) {
    for (const c of local) { try { await api('POST', '/api/contacts', { public_id: c.public_id }) } catch { /* Spieler existiert nicht mehr */ } }
    S.contacts = (await api('GET', '/api/me')).contacts
  }
  setLocalContacts(S.contacts)
}

const scriptLoads = {}
const loadScript = (src) => (scriptLoads[src] ??= new Promise((resolve, reject) => {
  document.head.append(h('script', { src, onload: resolve, onerror: () => { delete scriptLoads[src]; reject(new Error('load ' + src)) } }))
}))

/** Akzeptiert Freundescode, Einladungslink (/i/CODE oder #/invite/CODE) oder QR-Inhalt. */
function parseCode(text) {
  const raw = String(text ?? '').trim()
  const m = raw.match(/\/i\/([A-Za-z0-9]{8})(?![A-Za-z0-9])/) || raw.match(/#\/invite\/([A-Za-z0-9]{8})(?![A-Za-z0-9])/)
  const code = (m ? m[1] : raw).toUpperCase().replace(/[^A-Z0-9]/g, '')
  return /^[A-HJ-NP-Z2-9]{8}$/.test(code) ? code : null
}

async function share(url, title) {
  if (navigator.share) { try { await navigator.share({ title, url }); return } catch (e) { if (e.name === 'AbortError') return } }
  try { await navigator.clipboard.writeText(url); toast(t('profile.copied')) } catch { prompt(title, url) }
}

function gameLang() {
  const langs = (S.meta?.langs ?? []).map((l) => l.lang)
  const saved = store.get('rp.gameLang')
  if (saved && langs.includes(saved)) return saved
  return langs.includes(getLang()) ? getLang() : langs[0] ?? 'de'
}

/* ---------- Router ---------- */
let cleanup = () => {}
let runId = 0
const go = (hash) => { if (location.hash === hash) route(); else location.hash = hash }
/** Wie go(), ersetzt aber den aktuellen Verlaufseintrag: für das Betreten und Verlassen der Spielbildschirme (Übersicht ↔ Frage), damit „Zurück“ nicht zwischen beiden hin- und herspringt. */
const goReplace = (hash) => { if (location.hash === hash) route(); else location.replace(location.pathname + location.search + hash) }

let mountedRun = 0, refreshing = false
/** Inhalt der Seite ersetzen. Beim ersten Mount eines Laufs (Navigation): einblenden und nach oben scrollen. Bei Auto-Aktualisierungen im selben Lauf
 *  (poll, Live-Zustände): ohne Einblenden und ohne Scroll-Sprung, damit die Seite nicht sichtbar „blinkt“. */
function mount(...nodes) { place(nodes, refreshing && mountedRun === runId) }
function place(nodes, soft) {
  const y = window.scrollY
  $app.replaceChildren(h('div', { class: soft ? 'fade soft' : 'fade' }, ...nodes))
  if (soft) window.scrollTo(0, y); else window.scrollTo(0, 0)
  mountedRun = runId
}
const loading = () => $app.replaceChildren(h('div', { class: 'spinner', 'aria-label': t('loading') }))

/** true, wenn `data` dem vorherigen Aufruf dieser Ansicht entspricht (Auto-Aktualisierung ohne Änderung braucht kein Neuzeichnen). */
const makeUnchanged = () => { let last; return (data) => { const j = JSON.stringify(data); const same = j === last; last = j; return same } }

function poll(fn, ms) {
  const tick = async () => { refreshing = true; try { await fn() } finally { refreshing = false } }
  const id = setInterval(() => { if (!document.hidden) tick() }, ms)
  const onVis = () => { if (!document.hidden) tick() }
  document.addEventListener('visibilitychange', onVis)
  const prev = cleanup
  cleanup = () => { prev(); clearInterval(id); document.removeEventListener('visibilitychange', onVis) }
}

let updateReady = false
async function route() {
  if (updateReady) return location.reload()
  cleanup(); cleanup = () => {}
  const my = ++runId
  const [, page = '', arg, arg2] = (location.hash || '#/').slice(1).split('/')
  try {
    if (!S.me) { loading(); if (!(await boot())) return }
    if (my !== runId) return
    const pages = { '': home, history, new: newGame, game: gameView, play, profile, contribute, licenses, invite, friends, ladder, lplay, room, rplay, join, top, live, 'live-join': liveJoin, sofa, wordle }
    await (pages[page] ?? home)(arg, my, arg2)
  } catch (e) {
    if (my !== runId) return
    if (e instanceof ApiError && e.status === 401) return sessionLost()
    mount(topbar(t('app.name'), false), h('div', { class: 'empty' }, e instanceof ApiError ? errText(e) : t('err.generic'), h('p', {}, h('button', { class: 'btn', onclick: route }, t('retry')))))
    console.error(e)
  }
}
window.addEventListener('hashchange', route)

function topbar(title, back = true, right) {
  return h('div', { class: 'top' },
    back ? h('button', { class: 'iconbtn', 'aria-label': t('back'), onclick: () => (history.length > 1 && !location.hash.startsWith('#/invite') ? history.back() : go('#/')) }, '←') : null,
    h('h1', {}, title), right)
}

/* ---------- Start / Sitzung ---------- */
async function boot() {
  if (!S.meta) S.meta = await api('GET', '/api/meta', undefined, { auth: false })
  if (!S.priv) S.priv = await api('GET', '/api/privacy', undefined, { auth: false })
  if (!S.token) {
    // Erster Aufruf: erst Zustimmung zur Datenschutzerklärung (dokumentiert), dann Namenswahl
    let version = await askConsent(S.priv, false)
    const name = await askName()
    for (let tries = 0; ; tries++) {
      try {
        const r = await api('POST', '/api/players', { lang: getLang(), ...(name ? { name } : {}), consent: { version, age_ok: true } }, { auth: false })
        S.token = r.token; store.set('rp.token', r.token)
        break
      } catch (e) {
        if (!(e instanceof ApiError && e.code === 'privacy_changed') || tries > 2) throw e
        S.priv = await api('GET', '/api/privacy', undefined, { auth: false }); version = await askConsent(S.priv, true) // Text hat sich währenddessen geändert
      }
    }
  }
  try { await refreshMe(true) } catch (e) { if (e instanceof ApiError && e.status === 401) { sessionLost(); return false } throw e }
  // Geänderte Datenschutzerklärung: genau einmal erneut zustimmen
  while (S.consent && S.consent.accepted !== S.consent.current) {
    S.priv = await api('GET', '/api/privacy', undefined, { auth: false })
    const version = await askConsent(S.priv, S.consent.accepted != null)
    try { await api('POST', '/api/consent', { version, age_ok: true }) } catch (e) { if (!(e instanceof ApiError && e.code === 'privacy_changed')) throw e }
    await refreshMe()
  }
  resyncPush()
  return true
}
const renderDoc = (doc) => h('div', { class: 'doc stack' }, doc.sections.map((s) => h('div', { class: 'stack' }, h('h4', {}, s.title),
  (s.paras ?? []).map((p) => h('p', { class: 'muted' }, p)), s.items ? h('ul', {}, s.items.map((i) => h('li', {}, i))) : null)))

/** Zustimmung zur Datenschutzerklärung (nicht vorangekreuzt, ab 16). Löst mit der zugestimmten Version auf. */
function askConsent(priv, changed) {
  return new Promise((resolve) => {
    const view = (declined = false) => {
      const doc = priv[getLang()] ?? priv.de
      const box = h('input', { type: 'checkbox', id: 'consent-box' })
      const ok = h('button', { class: 'btn primary block', disabled: true, onclick: () => resolve(priv.version) }, t('consent.accept'))
      box.addEventListener('change', () => { ok.disabled = !box.checked })
      const langs = h('div', { class: 'seg' }, Object.keys(dict).map((l) => h('button', { 'aria-pressed': String(l === getLang()), onclick: () => { store.set('rp.lang', l); setLang(l); view(declined) } }, dict[l]['lang.name'])))
      mount(h('div', { class: 'top' }, h('h1', { class: 'brand' }, 'Quis', h('b', {}, 'sel')), langs),
        declined
          ? h('div', { class: 'card stack' }, h('h3', {}, t('consent.declinedTitle')), h('p', { class: 'muted' }, t('consent.declinedInfo')), h('button', { class: 'btn primary block', onclick: () => view(false) }, t('consent.back')))
          : h('div', { class: 'card stack' }, h('h3', {}, t(changed ? 'consent.changedTitle' : 'consent.title')),
            changed ? h('p', { class: 'muted' }, t('consent.changedInfo')) : null,
            h('ul', {}, doc.summary.map((s) => h('li', {}, s))),
            h('details', {}, h('summary', { class: 'muted' }, t('consent.read')), renderDoc(doc)),
            h('label', { class: 'row consent-row' }, box, h('span', {}, t('consent.check'))),
            ok, h('button', { class: 'btn block', onclick: () => view(true) }, t('consent.decline'))))
    }
    view()
  })
}

/** Erster Start: Anzeigenamen wählen (oder einen zufälligen nehmen). Ändern geht jederzeit im Profil. */
function askName() {
  return new Promise((resolve) => {
    const input = h('input', { type: 'text', maxLength: 24, placeholder: t('welcome.placeholder'), autocomplete: 'nickname', 'aria-label': t('profile.name') })
    const submit = () => {
      const v = input.value.trim()
      if (v.length < 2) return toast(t('err.bad_name'))
      resolve(v)
    }
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit() })
    mount(h('div', { class: 'top' }, h('h1', { class: 'brand' }, 'Quis', h('b', {}, 'sel'))),
      h('div', { class: 'card stack' }, h('h3', {}, t('welcome.title')), h('p', { class: 'muted' }, t('welcome.hint')), input,
        h('button', { class: 'btn primary block', onclick: submit }, t('welcome.go')),
        h('button', { class: 'btn block', onclick: () => resolve('') }, t('welcome.random'))))
    input.focus()
  })
}
async function refreshMe(restore = false) {
  const r = await api('GET', '/api/me')
  S.me = r.player; S.contacts = r.contacts; S.consent = r.consent
  await syncContacts(restore)
}
function sessionLost() {
  S.me = null
  mount(topbar(t('session.title'), false), h('div', { class: 'card stack' },
    h('p', { class: 'muted' }, t('session.info')),
    importControls(),
    h('button', { class: 'btn block', onclick: () => { forgetIdentity(); route() } }, t('session.fresh'))))
}

/* ---------- Startseite ---------- */
async function home(_, my) {
  let wordleOpen = 0
  const unchanged = makeUnchanged()
  const render = (games, rooms = [], older = 0) => {
    if (my !== runId) return
    const mine = games.filter((g) => g.status === 'active' && g.turn === 'me')
    const theirs = games.filter((g) => g.status === 'active' && g.turn === 'opp')
    const waiting = games.filter((g) => g.status === 'waiting')
    const done = games.filter((g) => g.status === 'finished')
    const section = (title, list) => list.length ? [h('h2', {}, title), h('div', { class: 'list' }, list.map(gameItem))] : []
    mount(
      h('div', { class: 'top' }, h('h1', { class: 'brand' }, 'Quis', h('b', {}, 'sel')),
        h('button', { class: 'iconbtn', 'aria-label': t('profile.title'), onclick: () => go('#/profile') }, avatar(S.me, 'sm'))),
      h('div', { class: 'tiles' },
        h('button', { class: 'tile quiz', onclick: () => go('#/new') }, h('b', {}, t('home.quizduell')), h('span', { class: 'ts' }, '＋ ' + t('home.new'))),
        h('button', { class: 'tile wordle', onclick: () => go('#/wordle') }, h('b', {}, t('wordle.title')), h('span', { class: 'ts' }, wordleOpen ? t('wordle.open', { n: wordleOpen }) : t('wordle.allDone')))),
      games.length || rooms.length ? null : h('div', { class: 'empty' }, t('home.empty')),
      rooms.length ? [h('h2', {}, t('room.rounds')), h('div', { class: 'list' }, rooms.map(roomItem))] : null,
      section(t('home.yourTurn'), mine), section(t('home.theirTurn'), theirs), section(t('home.waiting'), waiting), section(t('home.finished'), done),
      older ? h('button', { class: 'btn block', onclick: () => go('#/history') }, t('home.history', { n: older })) : null,
      h('div', { class: 'lbrow' }, h('button', { class: 'btn', onclick: () => go('#/top') }, t('home.lbQuiz')), h('button', { class: 'btn', onclick: () => go('#/wordle/board') }, t('wordle.board'))))
  }
  const load = guard(async () => {
    const [g, r, w] = await Promise.all([api('GET', '/api/games'), api('GET', '/api/rooms'), api('GET', '/api/wordle').catch(() => null)])
    wordleOpen = w ? w.langs.filter((l) => l.lang === getLang() && !l.daily).length + w.groups.filter((x) => !x.today || x.today.status === 'playing').length : 0
    if (!unchanged([g.games, g.history, r.rooms, wordleOpen])) render(g.games, r.rooms, g.history)
  })
  await load()
  poll(load, 10000)
}

/** Verlauf: alle beendeten Spiele (die Startseite zeigt je Gegner nur das letzte). */
async function history(_, my) {
  const r = await api('GET', '/api/games/history')
  if (my !== runId) return
  mount(topbar(t('history.title')), r.games.length ? h('div', { class: 'list' }, r.games.map(gameItem)) : h('div', { class: 'empty' }, t('history.empty')))
}

function gameItem(g) {
  const badge = g.status === 'finished'
    ? h('span', { class: 'badge ' + (g.winner === 'me' ? 'good' : g.winner === 'opp' ? 'bad' : '') }, t(g.winner === 'me' ? 'home.won' : g.winner === 'opp' ? 'home.lost' : 'home.draw'))
    : g.status === 'waiting' ? null : h('span', { class: 'muted' }, t('home.round', { n: g.round, total: 6 }))
  return h('button', { class: 'item', onclick: () => go('#/game/' + g.id) },
    avatar(g.opp), h('div', { class: 'grow' }, h('div', { class: 'ell' }, g.opp?.name ?? '…'), h('div', { class: 'muted' }, badge)),
    g.status === 'waiting' ? null : h('span', { class: 'score' }, `${g.score.me} : ${g.score.opp}`))
}

/* ---------- Neues Spiel ---------- */
async function newGame() {
  const start = guard(async (opponent) => {
    const r = await api('POST', '/api/games', { opponent, lang: gameLang() })
    go('#/game/' + r.id)
  })
  const roomCode = h('input', { type: 'text', maxLength: 12, autocapitalize: 'characters', autocomplete: 'off', placeholder: 'ABC123' })
  const langSel = h('select', { id: 'gl', onchange: (e) => store.set('rp.gameLang', e.target.value) },
    (S.meta.langs ?? []).map((l) => h('option', { value: l.lang, selected: l.lang === gameLang() }, langName(l.lang))))
  const option = (title, sub, icon, fn) => h('button', { class: 'item', onclick: fn },
    h('div', { class: 'avatar sm' }, icon), h('div', { class: 'grow' }, h('div', {}, title), h('div', { class: 'muted' }, sub)))
  mount(topbar(t('new.title')),
    S.contacts.length ? [h('h2', {}, t('new.challengeKnown')), h('div', { class: 'list' }, S.contacts.map((c) => h('button', { class: 'item', onclick: () => start(c.public_id) }, avatar(c), h('div', { class: 'grow' }, c.name), h('span', { class: 'badge' }, t('profile.challenge')))))] : null,
    h('h2', {}, t('new.duel')),
    h('div', { class: 'list' },
      option(t('new.random'), t('new.randomSub'), '🎲', () => start('random')),
      option(t('new.bot'), t('new.botSub'), '🤖', () => start('bot')),
      option(t('friends.title'), t('new.inviteSub'), '🤝', () => go('#/friends'))),
    h('h2', {}, t('ladder.title')),
    h('div', { class: 'list' }, option(t('ladder.title'), t('ladder.sub'), '💎', guard(async () => {
      const r = await api('POST', '/api/ladders', { lang: gameLang() }); go('#/ladder/' + r.id) }))),
    h('h2', {}, t('room.multi')),
    h('div', { class: 'list' },
      ['quiz', 'ladder'].map((m) => option(modeName(m), t('room.sub.' + m), m === 'ladder' ? '💎' : '👥', guard(async () => {
        const r = await api('POST', '/api/rooms', { mode: m, lang: gameLang() }); go('#/room/' + r.id) })))),
    h('div', { class: 'card' }, h('label', { class: 'field' }, t('room.codeLabel'), h('div', { class: 'row' }, roomCode,
      h('button', { class: 'btn', onclick: guard(async () => joinRoom(roomCode.value)) }, t('room.join'))))),
    h('h2', {}, t('live.title')),
    h('div', { class: 'list' }, option(t('live.title'), t('live.sub'), '🎉', guard(async () => {
      const r = await api('POST', '/api/live', { mode: 'tempo', screen: false, lang: gameLang() }); go('#/live/' + r.id) })),
      option(t('sofa.title'), t('sofa.sub'), '🛋️', () => go('#/sofa'))),
    h('h2', {}, t('new.questionLang')), h('div', { class: 'card' }, langSel))
}
const langName = (code) => { try { return new Intl.DisplayNames([getLang()], { type: 'language' }).of(code) } catch { return code } }

/* ---------- Sofa-Modus: ein Gerät, reihum ---------- */
async function sofa() {
  const MAX = 8, SECS = 20
  let names = []
  try { names = JSON.parse(store.get('rp.sofaNames') || '[]') } catch { /* leer */ }
  names = names.filter((n) => typeof n === 'string').slice(0, MAX)
  while (names.length < 2) names.push('')
  let rounds = Number(store.get('rp.sofaRounds')) || 5
  let share = store.get('rp.sofaShare') !== '0' // gleiche Frage für alle (Standard)
  let raf = 0
  const prev = cleanup
  cleanup = () => { prev(); cancelAnimationFrame(raf) }

  const setup = () => {
    const inputs = names.map((n, i) => h('input', { type: 'text', maxLength: 20, value: n, placeholder: t('sofa.name', { n: i + 1 }), autocomplete: 'off', oninput: (e) => { names[i] = e.target.value } }))
    const opts = share ? [5, 10, 15] : [3, 5, 8]
    if (!opts.includes(rounds)) rounds = opts[1]
    const roundSeg = h('div', { class: 'seg wrap' }, opts.map((n) => h('button', { 'aria-pressed': String(rounds === n), onclick: (e) => {
      rounds = n; store.set('rp.sofaRounds', String(n)); roundSeg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === e.currentTarget))) } }, t('sofa.rounds', { n }))))
    const shareSeg = h('div', { class: 'seg wrap' }, [[true, 'sofa.share'], [false, 'sofa.own']].map(([v, label]) => h('button', { 'aria-pressed': String(share === v), onclick: () => { share = v; store.set('rp.sofaShare', v ? '1' : '0'); setup() } }, t(label))))
    mount(topbar(t('sofa.title')),
      h('div', { class: 'card stack' }, h('p', { class: 'muted' }, t('sofa.info')),
        h('div', { class: 'stack' }, inputs.map((i, idx) => h('div', { class: 'row' }, i, names.length > 2 ? h('button', { class: 'btn small danger', 'aria-label': t('profile.remove'), onclick: () => { names.splice(idx, 1); setup() } }, '✕') : null))),
        names.length < MAX ? h('button', { class: 'btn small', onclick: () => { names.push(''); setup() } }, '＋ ' + t('sofa.add')) : null,
        h('label', { class: 'field' }, t('sofa.shareLabel'), shareSeg), h('p', { class: 'hint' }, t(share ? 'sofa.shareInfo' : 'sofa.ownInfo')),
        h('label', { class: 'field' }, t(share ? 'sofa.roundsShared' : 'sofa.roundsLabel'), roundSeg),
        h('button', { class: 'btn primary block', onclick: guard(start) }, t('sofa.start'))))
  }

  async function start() {
    const players = names.map((n, i) => ({ name: n.trim() || t('sofa.name', { n: i + 1 }), score: 0 }))
    store.set('rp.sofaNames', JSON.stringify(names.map((n) => n.trim())))
    const r = await api('GET', `/api/sofa?lang=${gameLang()}&n=${share ? rounds : players.length * rounds}`)
    if (share) sharedTurn(players, r.questions, 0, 0, [])
    else turn(players, r.questions, 0)
  }

  /** Gleiche Frage für alle: reihum verdeckt antworten, danach gemeinsame Auflösung. Der Startspieler rotiert je Frage. */
  function sharedTurn(players, qs, k, i, picks) {
    const p = players[(k + i) % players.length]
    mount(topbar(t('sofa.title')),
      h('div', { class: 'card stack lresult' }, h('p', { class: 'muted' }, t('sofa.pass')), h('div', { class: 'big' }, p.name),
        h('p', { class: 'hint' }, t('ladder.step', { n: k + 1, total: qs.length }) + ' · ' + t('sofa.hidden')),
        h('button', { class: 'btn primary block', onclick: () => sharedAsk(players, qs, k, i, picks) }, t('sofa.ready', { name: p.name }))),
      h('div', { class: 'card stack' }, players.map((x) => h('div', { class: 'row' }, h('div', { class: 'grow ell' }, x.name), h('span', { class: 'score' }, String(x.score))))))
  }

  function sharedAsk(players, qs, k, i, picks) {
    const p = players[(k + i) % players.length], q = qs[k]
    let chosen = -1, done = false
    const bar = h('i')
    const deadline = performance.now() + SECS * 1000
    const confirm = h('button', { class: 'btn primary block', disabled: true, onclick: () => lock(chosen) }, t('sofa.lock'))
    const buttons = q.options.map((text, n) => h('button', { class: 'opt', onclick: () => { if (done) return; chosen = n; buttons.forEach((b, m) => b.classList.toggle('sel', m === n)); confirm.disabled = false } }, h('kbd', {}, String(n + 1)), h('span', {}, text)))
    const lock = (choice) => {
      if (done) return
      done = true; cancelAnimationFrame(raf)
      picks.push({ player: p, choice })
      if (i + 1 < players.length) sharedTurn(players, qs, k, i + 1, picks)
      else sharedReveal(players, qs, k, picks)
    }
    const tick = () => { const left = deadline - performance.now(); bar.style.transform = `scaleX(${Math.max(0, left / (SECS * 1000))})`; if (left <= 0) lock(chosen); else raf = requestAnimationFrame(tick) }
    mount(topbar(t('sofa.turn', { name: p.name })),
      h('div', { class: 'card qcard', cat: q.category }, h('div', { class: 'q-head' }, catChip(q.category), h('span', { class: 'muted' }, t('ladder.step', { n: k + 1, total: qs.length }))),
        h('div', { class: 'timer' }, bar), h('div', { class: 'question' }, q.text), h('div', { class: 'opts' }, buttons), h('div', { class: 'feedback' }, confirm)))
    raf = requestAnimationFrame(tick)
  }

  function sharedReveal(players, qs, k, picks) {
    const q = qs[k]
    for (const pk of picks) if (pk.choice === q.correct_index) pk.player.score++
    mount(topbar(t('sofa.title')),
      h('div', { class: 'card qcard', cat: q.category }, h('div', { class: 'q-head' }, catChip(q.category), h('span', { class: 'muted' }, t('ladder.step', { n: k + 1, total: qs.length }))),
        h('div', { class: 'question' }, q.text),
        h('div', { class: 'opts' }, q.options.map((text, n) => h('button', { class: 'opt ' + (n === q.correct_index ? 'good' : 'dim'), disabled: true }, h('kbd', {}, String(n + 1)), h('span', {}, text)))),
        q.explanation ? h('p', { class: 'muted' }, q.explanation) : null),
      h('div', { class: 'list' }, picks.map((pk) => h('div', { class: 'item' }, h('div', { class: 'grow ell' }, pk.player.name),
        h('span', { class: 'badge ' + (pk.choice === q.correct_index ? 'good' : 'bad') }, pk.choice < 0 ? t('play.timeUp') : (pk.choice === q.correct_index ? '✓ ' : '✗ ') + (pk.choice < 0 ? '' : q.options[pk.choice].slice(0, 24))), h('span', { class: 'score' }, String(pk.player.score))))),
      h('button', { class: 'btn primary block', onclick: () => (k + 1 >= qs.length ? result(players, qs) : sharedTurn(players, qs, k + 1, 0, [])) }, k + 1 >= qs.length ? t('sofa.result') : t('play.next')))
  }

  function turn(players, qs, k) {
    if (k >= qs.length) return result(players, qs)
    const p = players[k % players.length], q = qs[k]
    mount(topbar(t('sofa.title')),
      h('div', { class: 'card stack lresult' }, h('p', { class: 'muted' }, t('sofa.pass')), h('div', { class: 'big' }, p.name),
        h('p', { class: 'hint' }, t('ladder.step', { n: k + 1, total: qs.length })),
        h('button', { class: 'btn primary block', onclick: () => ask(players, qs, k) }, t('sofa.ready', { name: p.name }))),
      h('div', { class: 'card stack' }, players.map((x) => h('div', { class: 'row' }, h('div', { class: 'grow ell' }, x.name), h('span', { class: 'score' }, String(x.score))))))
  }

  function ask(players, qs, k) {
    const p = players[k % players.length], q = qs[k]
    let done = false
    const bar = h('i'), feedback = h('div', { class: 'feedback' })
    const deadline = performance.now() + SECS * 1000
    const buttons = q.options.map((text, i) => h('button', { class: 'opt', onclick: () => submit(i) }, h('kbd', {}, String(i + 1)), h('span', {}, text)))
    const submit = (choice) => {
      if (done) return
      done = true; cancelAnimationFrame(raf)
      const ok = choice === q.correct_index
      if (ok) p.score++
      buttons.forEach((b) => (b.disabled = true))
      bar.parentNode?.classList.add('done') // Platz für Erklärung und „Weiter“
      buttons[q.correct_index].classList.add('good')
      if (choice >= 0 && !ok) buttons[choice].classList.add('bad')
      feedback.append(h('strong', {}, choice === -1 ? t('play.timeUp') : ok ? t('play.right') : t('play.wrong')),
        h('button', { class: 'btn small primary', onclick: () => turn(players, qs, k + 1) }, k + 1 >= qs.length ? t('sofa.result') : t('play.next')))
      if (q.explanation) feedback.before(h('p', { class: 'muted' }, q.explanation))
    }
    const tick = () => { const left = deadline - performance.now(); bar.style.transform = `scaleX(${Math.max(0, left / (SECS * 1000))})`; if (left <= 0) submit(-1); else raf = requestAnimationFrame(tick) }
    mount(topbar(t('sofa.turn', { name: p.name })),
      h('div', { class: 'card qcard', cat: q.category }, h('div', { class: 'q-head' }, catChip(q.category), h('span', { class: 'muted' }, t('ladder.step', { n: k + 1, total: qs.length }))),
        h('div', { class: 'timer' }, bar), h('div', { class: 'question' }, q.text), h('div', { class: 'opts' }, buttons), feedback))
    raf = requestAnimationFrame(tick)
  }

  function result(players, qs) {
    const rank = [...players].sort((a, b) => b.score - a.score)
    const top = rank.filter((p) => p.score === rank[0].score).map((p) => p.name).join(' & ')
    mount(topbar(t('sofa.title')),
      h('div', { class: 'card stack lresult' }, h('h3', {}, t('live.finished')), h('div', { class: 'big' }, '🏆 ' + top)),
      h('div', { class: 'list' }, rank.map((p, i) => h('div', { class: 'item' }, h('span', { class: 'rank' }, '#' + (i + 1)), h('div', { class: 'grow ell' }, p.name), h('span', { class: 'score' }, String(p.score))))),
      h('button', { class: 'btn primary block', onclick: guard(start) }, t('sofa.again')),
      h('button', { class: 'btn block', onclick: () => go('#/') }, t('ladder.home')))
  }

  setup()
}

/* ---------- Wordle ---------- */
const WLANGS = ['de', 'en']
const wlangs = () => [getLang(), ...WLANGS.filter((l) => l !== getLang())].filter((l, i, a) => WLANGS.includes(l) && a.indexOf(l) === i)
const wstatus = (s) => !s ? t('wordle.status.none') : s.status === 'won' ? t('wordle.status.won', { n: s.guesses }) : s.status === 'lost' ? t('wordle.status.lost') : t('wordle.status.playing', { n: s.guesses })
const wbadge = (s) => h('span', { class: 'badge ' + (s?.status === 'won' ? 'good' : s?.status === 'lost' ? 'bad' : '') }, s ? (s.status === 'won' ? '✓ ' + s.guesses + '/6' : s.status === 'lost' ? '✗' : '…') : t('wordle.new'))
const localTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || '' } catch { return '' } }
/** Erinnerung um 9 Uhr (lokale Zeit) für ein Wordle ein-/ausschalten; schaltet bei Bedarf zuerst die Push-Benachrichtigungen des Geräts ein. */
const wordleBell = (key, on, after) => h('button', { class: 'btn small' + (on ? ' primary' : ''), 'aria-pressed': String(on), title: t('wordle.bell'), onclick: guard(async () => {
  if (!on && (await pushStatus()) !== 'on') { if (!pushSupported()) return toast(t('push.unsupported')); await enablePush() }
  await api('POST', '/api/wordle/push', { key, on: !on, tz: localTz() }); toast(t(on ? 'wordle.bellOff' : 'wordle.bellOn')); after()
}) }, '🔔 ' + t(on ? 'wordle.bellIs' : 'wordle.bellAsk'))
const wInviteLink = (code) => location.origin + '/#/wordle/join/' + code

async function wordle(arg, my, arg2) {
  if (arg === 'play') return wordlePlay(Number(arg2), my)
  if (arg === 'group') return wordleGroup(Number(arg2), my)
  if (arg === 'join') return wordleJoin(arg2, my)
  if (arg === 'board') return wordleBoard(my)
  if (arg === 'inbox') return wordleInbox(my)
  return wordleHub(my)
}

async function wordleHub(my) {
  let creating = false, duel = false
  const startGame = guard(async (kind, lang, group_id) => { const r = await api('POST', '/api/wordle/games', { kind, lang, group_id }); go('#/wordle/play/' + r.game.id) })
  const render = (d) => {
    if (my !== runId) return
    const langSeg = (cur, set) => h('div', { class: 'seg' }, WLANGS.map((l) => h('button', { 'aria-pressed': String(cur() === l), onclick: (e) => { set(l); e.currentTarget.parentNode.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === e.currentTarget))) } }, langName(l))))
    let newLang = getLang(), newName = h('input', { type: 'text', maxLength: 30, placeholder: t('wordle.groupName'), autocomplete: 'off' }), joinCode = h('input', { type: 'text', maxLength: 12, placeholder: 'ABC23DEF', autocapitalize: 'characters', autocomplete: 'off' })
    const createCard = h('div', { class: 'card stack' }, h('label', { class: 'field' }, t('wordle.groupName'), newName), langSeg(() => newLang, (l) => (newLang = l)),
      h('button', { class: 'btn primary block', onclick: guard(async () => { const r = await api('POST', '/api/wordle/groups', { name: newName.value, lang: newLang }); go('#/wordle/group/' + r.group.id) }) }, t('wordle.newGroup')))
    const duelCard = h('div', { class: 'card stack' }, h('p', { class: 'muted' }, t('wordle.duelInfo')), langSeg(() => newLang, (l) => (newLang = l)),
      S.contacts.length ? h('div', { class: 'list' }, S.contacts.map((c) => h('button', { class: 'item', onclick: guard(async () => { const r = await api('POST', '/api/wordle/duel', { public_id: c.public_id, lang: newLang }); toast(t('wordle.duelSent', { name: c.name })); go('#/wordle/group/' + r.group.id) }) }, avatar(c), h('div', { class: 'grow' }, c.name), h('span', { class: 'badge' }, '⚔')))) : h('p', { class: 'hint' }, t('new.noContacts')))
    mount(topbar(t('wordle.title')),
      h('p', { class: 'hint' }, t('wordle.sub')),
      wlangs().map((lang) => h('div', { class: 'card stack' },
        h('div', { class: 'row' }, h('h3', { class: 'grow' }, langName(lang)), d.langs.find((x) => x.lang === lang).streak ? h('span', { class: 'badge' }, '🔥 ' + t('wordle.streak', { n: d.langs.find((x) => x.lang === lang).streak })) : null, wordleBell('daily:' + lang, d.langs.find((x) => x.lang === lang).push, load)),
        h('button', { class: 'item', onclick: () => startGame('daily', lang) }, h('div', { class: 'avatar sm' }, '🟩'), h('div', { class: 'grow' }, h('div', {}, t('wordle.today')), h('div', { class: 'muted' }, wstatus(d.langs.find((x) => x.lang === lang).daily))), wbadge(d.langs.find((x) => x.lang === lang).daily)))),
      h('h2', {}, t('wordle.groups')),
      d.groups.length ? h('div', { class: 'list' }, d.groups.map((g) => h('button', { class: 'item', onclick: () => go('#/wordle/group/' + g.id) }, h('div', { class: 'avatar sm' }, g.members === 2 ? '⚔' : '👥'), h('div', { class: 'grow' }, h('div', { class: 'ell' }, g.name), h('div', { class: 'muted' }, langName(g.lang) + ' · ' + t('wordle.members', { n: g.members }) + ' · ' + t('wordle.standing', { rank: g.rank, points: g.points }))), wbadge(g.today)))) : h('div', { class: 'empty' }, t('wordle.noGroups')),
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn small', onclick: () => { creating = !creating; duel = false; setExtra() } }, '＋ ' + t('wordle.newGroup')),
        h('button', { class: 'btn small', onclick: () => { duel = !duel; creating = false; setExtra() } }, '⚔ ' + t('wordle.duel'))),
      h('div', { id: 'wextra', class: 'stack' }),
      h('div', { class: 'card stack' }, h('label', { class: 'field' }, t('wordle.joinGroup'), h('div', { class: 'row' }, joinCode, h('button', { class: 'btn', onclick: guard(async () => { const r = await api('POST', '/api/wordle/groups/join', { code: joinCode.value }); go('#/wordle/group/' + r.group.id) }) }, t('room.join'))))),
      h('button', { class: 'btn block', onclick: () => go('#/wordle/inbox') }, '📨 ' + t('wordle.inbox'), d.inbox_unseen ? h('span', { class: 'badge' }, String(d.inbox_unseen)) : null),
      h('button', { class: 'btn block', onclick: () => go('#/wordle/board') }, '🏆 ' + t('wordle.board')))
    function setExtra() { const box = document.getElementById('wextra'); box.replaceChildren(...(creating ? [createCard] : duel ? [duelCard] : [])) }
  }
  const unchanged = makeUnchanged()
  const load = guard(async () => { const d = await api('GET', `/api/wordle?tz=${encodeURIComponent(localTz())}`); if (!unchanged(d)) render(d) })
  await load()
  poll(load, 60000)
}

async function wordleJoin(code, my) {
  mount(topbar(t('wordle.title')), h('div', { class: 'card stack' }, h('p', {}, t('wordle.joinAsk', { code })),
    h('button', { class: 'btn primary block', onclick: guard(async () => { const r = await api('POST', '/api/wordle/groups/join', { code }); go('#/wordle/group/' + r.group.id) }) }, t('wordle.joinGroup')),
    h('button', { class: 'btn block', onclick: () => go('#/wordle') }, t('wordle.back'))))
}

const WKEYS = {
  de: ['QWERTZUIOP', 'ASDFGHJKL', 'YXCVBNM'],
  en: ['QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM'],
}
async function wordlePlay(id, my) {
  let g = (await api('GET', `/api/wordle/games/${id}`)).game
  let cur = '', busy = false
  const title = { daily: t('wordle.today'), group: t('wordle.groupToday') }[g.kind] + ' · ' + langName(g.lang)
  const rows = Array.from({ length: g.max }, () => Array.from({ length: 5 }, () => h('div', { class: 'wt' })))
  const grid = h('div', { class: 'wgrid', role: 'grid', 'aria-label': title }, rows.map((r) => h('div', { class: 'wrow', role: 'row' }, r)))
  const msg = h('div', { class: 'wmsg', 'aria-live': 'polite' })
  const keyEls = new Map()
  const best = { c: 3, p: 2, a: 1 }
  const keyMarks = () => { const m = new Map(); for (const gu of g.guesses) [...gu.word].forEach((ch, i) => { const k = gu.marks[i]; if ((best[k] ?? 0) > (best[m.get(ch)] ?? 0)) m.set(ch, k) }); return m }
  const MARKTXT = { c: 'wordle.m.c', p: 'wordle.m.p', a: 'wordle.m.a' }
  const paintRow = (i, flip) => {
    const gu = g.guesses[i]
    rows[i].forEach((tile, n) => {
      const ch = gu ? gu.word[n] : i === g.guesses.length && !g.finished ? cur[n] : ''
      tile.textContent = ch ? ch.toUpperCase() : ''
      tile.className = 'wt' + (ch && !gu ? ' filled' : '') + (gu ? ' ' + gu.marks[n] + (flip ? ' flip' : '') : '')
      if (gu) { tile.setAttribute('aria-label', `${ch.toUpperCase()}, ${t(MARKTXT[gu.marks[n]])}`); if (flip) tile.style.animationDelay = n * 0.18 + 's' } else tile.removeAttribute('aria-label')
    })
  }
  const paintKeys = () => { const m = keyMarks(); for (const [ch, el] of keyEls) el.className = 'key' + (m.has(ch) ? ' ' + m.get(ch) : '') + (el.dataset.wide ? ' wide' : '') }
  const paintAll = () => { for (let i = 0; i < g.max; i++) paintRow(i, false); paintKeys() }
  const shake = () => { const r = rows[g.guesses.length][0].parentNode; r.classList.remove('shake'); void r.offsetWidth; r.classList.add('shake') }
  const result = h('div', { class: 'stack' })
  const share = () => {
    const text = `Quissel Wordle ${g.lang.toUpperCase()} ${g.day} ${g.status === 'won' ? g.guesses.length : 'X'}/${g.max}\n` + g.guesses.map((gu) => [...gu.marks].map((m) => ({ c: '🟩', p: '🟨', a: '⬛' })[m]).join('')).join('\n')
    if (navigator.share) navigator.share({ text }).catch(() => {}); else navigator.clipboard?.writeText(text).then(() => toast(t('wordle.copied'))).catch(() => toast(text))
  }
  const picker = h('div', { class: 'stack' })
  /** Ergebnis in der App an einen Kontakt oder in eine eigene Gruppe schicken (nur Markierungen, nie das Wort). */
  const openPicker = guard(async () => {
    if (picker.childNodes.length) return picker.replaceChildren()
    const hub = await api('GET', '/api/wordle')
    const send = (body, label) => guard(async () => { await api('POST', '/api/wordle/share', { game_id: g.id, ...body }); toast(t('wordle.sent', { name: label })); picker.replaceChildren() })
    picker.replaceChildren(h('div', { class: 'card stack' }, h('p', { class: 'muted' }, t('wordle.sendInfo')),
      S.contacts.length || hub.groups.length ? h('div', { class: 'list' },
        S.contacts.map((c) => h('button', { class: 'item', onclick: send({ public_id: c.public_id }, c.name) }, avatar(c), h('div', { class: 'grow ell' }, c.name))),
        hub.groups.map((x) => h('button', { class: 'item', onclick: send({ group_id: x.id }, x.name) }, h('div', { class: 'avatar sm' }, x.members === 2 ? '⚔' : '👥'), h('div', { class: 'grow ell' }, x.name)))) : h('p', { class: 'hint' }, t('wordle.sendNone'))))
  })
  const showResult = () => {
    if (!g.finished) return result.replaceChildren()
    result.replaceChildren(h('div', { class: 'card stack lresult' }, h('h3', {}, g.status === 'won' ? t('wordle.win') : t('wordle.lose', { word: g.answer.toUpperCase() })),
      g.status === 'won' ? h('p', { class: 'muted' }, t('wordle.points', { n: g.points })) : null,
      h('button', { class: 'btn primary block', onclick: share }, '📋 ' + t('wordle.share')),
      g.kind === 'daily' ? [h('button', { class: 'btn block', onclick: openPicker }, '📨 ' + t('wordle.send')), picker] : null,
      g.kind === 'group' ? h('button', { class: 'btn block', onclick: () => go('#/wordle/group/' + g.group_id) }, t('wordle.toGroup')) : null,
      h('button', { class: 'btn block', onclick: () => go('#/wordle') }, t('wordle.back'))))
  }
  const type = (ch) => { if (busy || g.finished || cur.length >= 5) return; cur += ch.toLowerCase(); paintRow(g.guesses.length, false) }
  const del = () => { if (busy || g.finished) return; cur = cur.slice(0, -1); paintRow(g.guesses.length, false) }
  const submit = async () => {
    if (busy || g.finished) return
    if (cur.length < 5) { shake(); msg.textContent = t('err.bad_word'); return }
    busy = true
    try {
      const r = await api('POST', `/api/wordle/games/${id}/guess`, { word: cur })
      g = r.game; cur = ''; msg.textContent = ''
      paintRow(g.guesses.length - 1, true)
      setTimeout(() => { paintKeys(); paintAll(); showResult() }, g.finished ? 1000 : 900)
    } catch (e) { shake(); msg.textContent = e instanceof ApiError ? errText(e) : t('err.generic') } finally { busy = false }
  }
  const press = (k) => (k === 'ENTER' ? submit() : k === 'DEL' ? del() : type(k))
  const mkKey = (k, label, wide) => { const el = h('button', { class: 'key', 'data-wide': wide ? '1' : '', onclick: () => press(k), 'aria-label': k === 'ENTER' ? t('wordle.enter') : k === 'DEL' ? t('wordle.del') : k }, label); if (wide) el.classList.add('wide'); keyEls.set(k.toLowerCase(), el); return el }
  const kb = h('div', { class: 'kb' }, WKEYS[g.lang].map((row, i, all) => h('div', { class: 'krow' },
    i === all.length - 1 ? mkKey('ENTER', '↵', true) : null, [...row].map((ch) => mkKey(ch, ch)), i === all.length - 1 ? mkKey('DEL', '⌫', true) : null)))
  const onKey = (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return
    if (e.key === 'Enter') { e.preventDefault(); submit() } else if (e.key === 'Backspace') del()
    else if (e.key.length === 1 && /^[a-zA-Z]$/.test(e.key)) type(e.key)
  }
  document.addEventListener('keydown', onKey)
  const prev = cleanup
  cleanup = () => { prev(); document.removeEventListener('keydown', onKey) }
  mount(topbar(title),
    h('div', { class: 'card stack wcard' }, h('p', { class: 'hint', style: 'text-align:center' }, t('wordle.hint.' + g.lang)), grid, msg, result, kb))
  paintAll(); showResult()
}

/** Geteiltes Tages-Wordle (Eingang und Gruppen-Feed); das Raster erscheint erst, wenn man dasselbe Wordle selbst beendet hat. */
const wShare = (x) => h('div', { class: 'item wmember' + (x.is_me ? ' me' : '') }, h('div', { class: 'grow' }, h('div', { class: 'ell' }, x.name + ' · ' + langName(x.lang) + ' · ' + x.day),
  x.grid ? wGrid(x.grid) : h('p', { class: 'hint' }, t('wordle.shareLocked'))), h('span', { class: 'badge ' + (x.status === 'won' ? 'good' : 'bad') }, x.status === 'won' ? '✓ ' + x.guesses + '/6' : '✗'))
async function wordleInbox(my) {
  const r = await api('GET', '/api/wordle/inbox')
  if (my !== runId) return
  mount(topbar(t('wordle.inbox')), h('p', { class: 'hint' }, t('wordle.inboxInfo')),
    r.items.length ? h('div', { class: 'list' }, r.items.map(wShare)) : h('div', { class: 'empty' }, t('wordle.inboxEmpty')),
    h('button', { class: 'btn block', onclick: () => go('#/wordle') }, t('wordle.back')))
}
const wGrid = (rows) => h('div', { class: 'wgrid', 'aria-hidden': 'true' }, rows.map((r) => h('div', {}, [...r].map((m) => ({ c: '🟩', p: '🟨', a: '⬛' })[m]).join(''))))

async function wordleGroup(id, my) {
  let scope = store.get('rp.wScope2') || 'all'
  const render = (gv, board) => {
    if (my !== runId) return
    const link = wInviteLink(gv.code)
    const holder = h('div', { class: 'qr' })
    const scopeSeg = h('div', { class: 'seg wrap' }, [['all', 'wordle.scope.all'], ['month', 'wordle.scope.month'], ['week', 'wordle.scope.week'], ['day', 'wordle.scope.day']].map(([v, l]) => h('button', { 'aria-pressed': String(scope === v), onclick: () => { scope = v; store.set('rp.wScope2', v); load() } }, t(l))))
    mount(topbar(gv.name),
      h('div', { class: 'card stack' }, h('p', { class: 'muted' }, langName(gv.lang) + ' · ' + t('wordle.members', { n: gv.members.length })),
        wordleBell('g:' + gv.id, gv.push, load),
        h('button', { class: 'btn primary block', onclick: guard(async () => { const r = await api('POST', '/api/wordle/games', { kind: 'group', group_id: gv.id }); go('#/wordle/play/' + r.game.id) }) },
          gv.my_game ? (gv.my_game.status === 'playing' ? t('wordle.continue') : wstatus(gv.my_game)) : t('wordle.groupPlay'))),
      h('h2', {}, t('wordle.invite')),
      h('div', { class: 'card stack' }, h('div', { class: 'code' }, gv.code), holder,
        h('button', { class: 'btn block', onclick: () => share(link, gv.name) }, '🔗 ' + t('wordle.inviteLink'))),
      h('h2', {}, t('wordle.standToday')),
      h('div', { class: 'list' }, gv.members.map((m) => h('div', { class: 'item wmember' + (m.is_me ? ' me' : '') }, h('div', { class: 'grow' }, h('div', { class: 'ell' }, m.name + (m.is_owner ? ' ★' : '')), m.grid ? wGrid(m.grid) : null),
        h('span', { class: 'badge ' + (m.today?.status === 'won' ? 'good' : m.today?.status === 'lost' ? 'bad' : '') }, m.today ? (m.today.status === 'won' ? '✓ ' + m.today.guesses + '/6' : m.today.status === 'lost' ? '✗' : '… ' + m.today.guesses + '/6') : t('wordle.stillOpen'))))),
      gv.members.some((m) => m.today?.status && m.today.status !== 'playing' && !m.grid) ? h('p', { class: 'hint' }, t('wordle.gridLocked')) : null,
      gv.feed.length ? [h('h2', {}, t('wordle.feed')), h('div', { class: 'list' }, gv.feed.map(wShare))] : null,
      h('h2', {}, t('wordle.groupBoard')), h('div', { class: 'card stack' }, scopeSeg, h('p', { class: 'hint' }, t('wordle.boardInfo')),
        board.rows.length ? h('div', { class: 'list' }, board.rows.map((r) => h('div', { class: 'item' + (r.is_me ? ' me' : '') }, h('span', { class: 'rank' }, '#' + r.rank), h('div', { class: 'grow' }, h('div', { class: 'ell' }, r.name),
          h('div', { class: 'muted small' }, [r.avg_guesses ? 'Ø ' + r.avg_guesses : null, t('wordle.playedWon', { p: r.played, w: r.won }), r.missed ? t('wordle.missed', { n: r.missed }) : null, r.streak > 1 ? '🔥 ' + r.streak : null].filter(Boolean).join(' · '))),
          h('span', { class: 'score' }, String(r.points))))) : null),
      h('button', { class: 'btn block danger', onclick: guard(async () => { if (confirm(t('wordle.leaveConfirm'))) { await api('POST', `/api/wordle/groups/${id}/leave`, {}); go('#/wordle') } }) }, t('wordle.leave')),
      gv.is_owner ? h('button', { class: 'btn block danger', onclick: guard(async () => { if (confirm(t('wordle.deleteConfirm'))) { await api('DELETE', `/api/wordle/groups/${id}`); go('#/wordle') } }) }, t('wordle.delete')) : null)
    renderQr(link).then((q) => holder.replaceChildren(q)).catch(() => holder.replaceChildren(h('p', { class: 'hint' }, link)))
  }
  const load = guard(async () => { const [g, b] = await Promise.all([api('GET', `/api/wordle/groups/${id}`), api('GET', `/api/wordle/groups/${id}/board?scope=${scope}`)]); render(g.group, b) })
  await load()
}

async function wordleBoard(my) {
  let lang = store.get('rp.wLang') || getLang(), scope = store.get('rp.wScopeG') || 'week'
  if (!WLANGS.includes(lang)) lang = 'de'
  const render = (r) => {
    if (my !== runId) return
    const seg = (cur, opts, set) => h('div', { class: 'seg wrap' }, opts.map(([v, l]) => h('button', { 'aria-pressed': String(cur === v), onclick: () => { set(v); load() } }, l)))
    mount(topbar(t('wordle.board')),
      h('div', { class: 'card stack' }, seg(lang, WLANGS.map((l) => [l, langName(l)]), (v) => { lang = v; store.set('rp.wLang', v) }), seg(scope, [['day', t('wordle.scope.day')], ['week', t('wordle.scope.week')], ['month', t('wordle.scope.month')], ['all', t('wordle.scope.all')]], (v) => { scope = v; store.set('rp.wScopeG', v) }),
        r.me.participating ? h('p', { class: 'hint' }, r.me.rank ? t('wordle.myRank', { rank: r.me.rank, total: r.total }) : t('wordle.notRanked')) : null),
      r.top.length ? h('div', { class: 'list' }, r.top.map((x) => h('div', { class: 'item' + (x.is_me ? ' me' : '') }, h('span', { class: 'rank' }, '#' + x.rank), h('div', { class: 'grow ell' }, x.name), x.streak ? h('span', { class: 'badge' }, '🔥' + x.streak) : null, h('span', { class: 'muted' }, x.avg_guesses ? 'Ø ' + x.avg_guesses : ''), h('span', { class: 'score' }, String(x.points))))) : h('div', { class: 'empty' }, t('lb.empty')),
      r.me.participating ? null : h('div', { class: 'card stack' }, h('p', { class: 'muted' }, t('wordle.joinLbInfo')), h('button', { class: 'btn primary block', onclick: () => go('#/top') }, t('wordle.joinLb'))))
  }
  const load = guard(async () => render(await api('GET', `/api/wordle/board?lang=${lang}&scope=${scope}`)))
  await load()
}

/* ---------- Spielansicht ---------- */
async function gameView(id, my) {
  const render = (g) => {
    if (my !== runId) return
    const finished = g.status === 'finished'
    const rounds = Array.from({ length: g.rounds_total }, (_, i) => g.rounds.find((r) => r.n === i + 1) ?? { n: i + 1, category: null, me: [null, null, null], opp: [null, null, null] })
    const dots = (arr, right) => h('div', { class: 'dots' + (right ? ' r' : '') }, arr.map((v) => h('span', { class: 'dot ' + (v === true ? 'good' : v === false ? 'bad' : '') })))
    mount(
      topbar(t('game.vs', { name: g.opp?.name ?? '…' }), true,
        g.status === 'active' ? h('button', { class: 'btn small danger', onclick: guard(async () => { if (confirm(t('game.resignConfirm'))) { await api('POST', `/api/games/${id}/resign`, {}); route() } }) }, t('game.resign')) : null),
      h('div', { class: 'card' },
        h('div', { class: 'score-board' },
          h('div', { class: 'who' }, avatar(g.me), h('span', { class: 'ell' }, t('game.you'))),
          h('div', { class: 'big' }, `${g.score.me}:${g.score.opp}`),
          h('div', { class: 'who' }, avatar(g.opp), h('span', { class: 'ell' }, g.opp?.name ?? '…'))),
        g.level !== 'basic' || g.level !== S.me.level ? h('div', { class: 'hint', style: 'text-align:center' }, t(g.level !== S.me.level ? 'level.lowered' : 'level.badge', { level: t('tier.' + g.level) })) : null,
        h('div', { class: 'rounds' }, rounds.map((r) => h('div', { class: 'round' + (!finished && r.n === g.round ? ' now' : '') },
          dots(r.me), h('div', { class: 'cat', cat: r.category }, r.category ? t('cat.' + r.category) : t('game.round', { n: r.n })), dots(r.opp, true))))),
      h('div', { class: 'card stack' }, actions(g, id)))
  }
  const load = guard(async () => render((await api('GET', `/api/games/${id}`)).game))
  await load()
  poll(load, 6000)
}

function actions(g, id) {
  if (g.status === 'waiting') return [
    h('div', { class: 'row' }, h('div', { class: 'spinner' }), h('div', {}, t('game.waitingOpp'))),
    h('button', { class: 'btn block', onclick: guard(async () => { await api('POST', `/api/games/${id}/bot`, {}); route() }) }, t('game.playBot')),
    h('button', { class: 'btn block danger', onclick: guard(async () => { await api('POST', `/api/games/${id}/resign`, {}); go('#/') }) }, t('game.cancel')),
    h('p', { class: 'hint' }, t('game.waitHint'))]
  if (g.status === 'finished') {
    const msg = g.winner === 'me' ? t('game.win') : g.winner === 'opp' ? t('game.lose', { name: g.opp?.name }) : t('game.draw')
    const known = S.contacts.some((c) => c.public_id === g.opp?.public_id)
    return [h('h3', {}, msg), g.end_reason && g.end_reason !== 'completed' ? h('p', { class: 'muted' }, t(g.end_reason === 'resigned' ? 'game.resigned' : 'game.timeout')) : null,
      h('button', { class: 'btn primary block', onclick: guard(async () => {
        const r = await api('POST', '/api/games', { opponent: g.opp.is_bot ? 'bot' : g.opp.public_id, lang: g.lang }); go('#/game/' + r.id) }) }, t('game.rematch')),
      !known && !g.opp?.is_bot ? h('button', { class: 'btn block', onclick: guard(async () => { await api('POST', '/api/contacts', { public_id: g.opp.public_id }); await refreshMe(); toast(t('profile.saved')); route() }) }, t('game.addContact')) : null]
  }
  if (g.turn === 'me' && g.phase === 'pick') return [h('h3', {}, t('game.pick')),
    h('div', { class: 'cats' }, g.options.map((c) => h('button', { class: 'cat-btn', cat: c,
      onclick: guard(async () => { await api('POST', `/api/games/${id}/pick`, { category: c }); goReplace('#/play/' + id) }) }, t('cat.' + c))))]
  if (g.turn === 'me') return [h('button', { class: 'btn primary block', onclick: () => goReplace('#/play/' + id) }, t(g.rounds.find((r) => r.n === g.round)?.me.some((x) => x !== null) ? 'game.continue' : 'game.play'))]
  return [h('div', { class: 'row' }, avatar(g.opp, 'sm'), h('div', {}, t('game.oppTurn', { name: g.opp?.name }))),
    g.idle_hours >= 1 ? h('p', { class: 'hint' }, t('game.idle', { name: g.opp?.name, h: g.idle_hours })) : null,
    g.can_takeover ? h('button', { class: 'btn block', onclick: guard(async () => {
      if (!confirm(t('game.takeoverConfirm', { name: g.opp?.name }))) return
      await api('POST', `/api/games/${id}/bot`, {}); route() }) }, t('game.takeover')) : null]
}

/* ---------- Frage-Screen ---------- */
async function play(id, my) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  let raf = 0, keyHandler = null
  const prev = cleanup
  cleanup = () => { prev(); cancelAnimationFrame(raf); if (keyHandler) document.removeEventListener('keydown', keyHandler) }
  const alive = () => my === runId

  while (alive()) {
    let q
    try { q = await api('GET', `/api/games/${id}/question`) } catch (e) {
      if (e.status === 409) return goReplace('#/game/' + id)
      throw e
    }
    if (!alive()) return
    const answered = await new Promise((resolve) => {
      let done = false
      const bar = h('i')
      const buttons = q.options.map((text, i) => h('button', { class: 'opt', onclick: () => submit(i) }, h('kbd', {}, String(i + 1)), h('span', {}, text)))
      const feedback = h('div', { class: 'feedback' })
      mount(
        topbar(t('game.round', { n: q.round }), true),
        h('div', { class: 'card qcard', cat: q.category },
          h('div', { class: 'q-head' }, catChip(q.category), h('span', { class: 'muted' }, t('play.question', { n: q.idx + 1, total: q.total }))),
          h('div', { class: 'timer' }, bar), h('div', { class: 'question' }, q.text), h('div', { class: 'opts' }, buttons), feedback))
      const deadline = performance.now() + q.remaining_ms
      const tick = () => {
        const left = deadline - performance.now()
        bar.style.transform = `scaleX(${Math.max(0, left / q.limit_ms)})`
        if (left <= 0) submit(-1); else raf = requestAnimationFrame(tick)
      }
      raf = requestAnimationFrame(tick)
      keyHandler = (e) => { const n = Number(e.key); if (n >= 1 && n <= 4) submit(n - 1) }
      document.addEventListener('keydown', keyHandler)

      async function submit(choice) {
        if (done) return
        done = true
        cancelAnimationFrame(raf)
        buttons.forEach((b) => (b.disabled = true))
        bar.parentNode?.classList.add('done') // Platz für Erklärung und „Weiter“
        let r
        try { r = await api('POST', `/api/games/${id}/answer`, { idx: q.idx, choice }) } catch (e) { toast(errText(e)); return resolve({ error: true }) }
        buttons[r.correct_index]?.classList.add('good')
        if (choice >= 0 && !r.correct) buttons[choice].classList.add('bad')
        const label = choice === -1 ? t('play.timeUp') : r.correct ? t('play.right') : t('play.wrong')
        const next = h('button', { class: 'btn small', onclick: () => resolve({ r }) }, t('play.next'))
        const report = h('button', { class: 'btn small', onclick: guard(async () => {
          await api('POST', `/api/games/${id}/report`, { round: q.round, idx: q.idx, reason: '' }); report.disabled = true; toast(t('play.reported')) }), title: t('play.report'), 'aria-label': t('play.report') }, '⚑')
        let autoNext
        const review = S.me?.reviewer ? h('button', { class: 'btn small', title: t('play.review'), 'aria-label': t('play.review'), onclick: () => {
          clearTimeout(autoNext) // beim Formular nicht automatisch weiterspringen
          const part = h('select', { 'aria-label': t('review.part.question') }, ['question', 'answers'].map((v) => h('option', { value: v }, t('review.part.' + v))))
          const kind = h('select', { 'aria-label': t('review.kind.wrong') }, ['wrong', 'wording'].map((v) => h('option', { value: v }, t('review.kind.' + v))))
          const note = h('input', { type: 'text', maxLength: 300, placeholder: t('review.note') })
          const form = h('div', { class: 'stack' }, h('div', { class: 'row' }, part, kind), note, h('div', { class: 'row' },
            h('button', { class: 'btn small primary', onclick: guard(async () => {
              await api('POST', `/api/games/${id}/review`, { round: q.round, idx: q.idx, part: part.value, kind: kind.value, note: note.value })
              form.remove(); review.disabled = true; toast(t('review.sent')) }) }, t('review.send')),
            h('button', { class: 'btn small', onclick: () => form.remove() }, t('review.cancel'))))
          feedback.append(form); note.focus()
        } }, '✎') : null
        const showReport = S.meta?.reports !== false && store.get('rp.noReport') !== '1'
        feedback.append(h('strong', {}, label), h('span', { class: 'row' }, review, showReport ? report : null, next))
        if (r.explanation) feedback.before(h('p', { class: 'muted' }, r.explanation))
        autoNext = setTimeout(() => resolve({ r }), r.explanation ? 3500 : 1600)
      }
    })
    if (keyHandler) document.removeEventListener('keydown', keyHandler)
    if (!alive()) return // schon woanders (Zurück gedrückt): nicht zurückholen
    if (answered.error) return goReplace('#/game/' + id)
    const g = answered.r.game
    if (q.idx >= q.total - 1 || g.turn !== 'me' || g.status !== 'active' || g.phase !== 'play') return goReplace('#/game/' + id)
    await sleep(50)
  }
}

/* ---------- Live-Gesellschaftsspiel (Echtzeit) ---------- */
const LIVE_MODES = ['tempo', 'survival', 'race', 'bet', 'show', 'blitz', 'estimate'], LIVE_TEAM_MODES = ['tempo', 'bet', 'blitz', 'estimate']
/** Zahl aus Freitext: „1.234,5“ (de) bzw. „1,234.5“ (en), Leerzeichen/Apostroph als Tausender; null bei Unsinn. */
function parseGuess(raw, lang = getLang()) {
  let x = String(raw ?? '').trim().replace(/[\s'’\u00a0]/g, '').replace(/^\+/, '').replace('−', '-')
  if (!/^-?[\d.,]+$/.test(x) || !/\d/.test(x)) return null
  const thou = lang === 'de' ? '.' : ',', dec = lang === 'de' ? ',' : '.'
  const other = { '.': ',', ',': '.' }
  const groups = (sep) => x.split(sep).length - 1
  if (groups(thou) && groups(dec)) { if (x.lastIndexOf(thou) > x.lastIndexOf(dec)) return null; x = x.split(thou).join('').replace(dec, '.') }
  else if (groups(thou)) { const parts = x.split(thou); x = parts.length > 2 || (parts[1].length === 3 && parts[0].replace('-', '').length <= 3 && parts[0].replace('-', '') !== '0') ? parts.join('') : parts.join('.') }
  else if (groups(dec)) { if (groups(dec) > 1) return null; x = x.replace(dec, '.') }
  const n = Number(x)
  return Number.isFinite(n) && Math.abs(n) <= 1e12 ? n : null
}
/** Anzeige einer geschätzten Zahl; Jahreszahlen (ganzzahlig 1000–2100, ohne Einheit) ohne Tausendertrenner. */
const fmtGuess = (v, unit) => (!unit && Number.isInteger(v) && v >= 1000 && v <= 2100 ? String(v) : Number(v).toLocaleString(getLang(), { maximumFractionDigits: 6 })) + (unit ? ' ' + unit : '')
const LETTERS = ['A', 'B', 'C', 'D']
const liveLink = (token) => `${location.origin}/#/live-join/${token}`

async function liveJoin(token) {
  mount(topbar(t('app.name'), false), h('div', { class: 'card stack' }, h('p', {}, t('room.joining'))))
  const r = await api('POST', '/api/live/join', { token: token || '' })
  go('#/live/' + r.id)
}

/** Server-Sent Events über fetch (Bearer-Header bleibt, kein Token in der URL); baut bei Abbruch mit Backoff neu auf. */
function connectLive(id, onState, onGone) {
  const ac = new AbortController()
  let stopped = false
  const prev = cleanup
  cleanup = () => { prev(); stopped = true; ac.abort() }
  ;(async () => {
    let delay = 500
    while (!stopped) {
      try {
        const res = await fetch(`/api/live/${id}/events`, { headers: { authorization: 'Bearer ' + S.token }, signal: ac.signal })
        if (res.status === 404 || res.status === 401 || res.status === 403) return onGone()
        if (!res.ok || !res.body) throw new Error('sse ' + res.status)
        delay = 500
        const reader = res.body.getReader(), dec = new TextDecoder()
        let buf = ''
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buf += dec.decode(value, { stream: true })
          let i
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, i); buf = buf.slice(i + 2)
            const d = /^data: (.*)$/m.exec(chunk)
            if (d && /^event: state/m.test(chunk)) onState(JSON.parse(d[1]))
          }
        }
      } catch { if (stopped) return }
      await new Promise((r) => setTimeout(r, delay)); delay = Math.min(delay * 2, 5000)
    }
  })()
}

async function live(id, my) {
  const mount = (...nodes) => place(nodes, mountedRun === runId) // jeder Live-Zustand ersetzt den Inhalt weich (kein Einblenden, kein Scroll-Sprung)
  let raf = 0, lastQr = '', offset = 0
  const prev = cleanup
  cleanup = () => { prev(); cancelAnimationFrame(raf); document.getElementById('app').classList.remove('wide') }
  const act = (path, body = {}) => guard(async () => { await api('POST', `/api/live/${id}/${path}`, body) })
  let seriesLabel = ''
  const liveBar = () => topbar(seriesLabel || t('live.title'), false)
  const SERIES_TEMPLATES = { classic: ['tempo', 'estimate', 'blitz'], risk: ['bet', 'race', 'show'], all: LIVE_MODES }
  const timerBar = (s) => {
    const bar = h('i'), box = h('div', { class: 'timer' }, bar)
    cancelAnimationFrame(raf)
    const until = s.phase_until - s.now + performance.now() // Server- und Gerätezeit gleichen sich über `now` an
    const tick = () => { const left = until - performance.now(); bar.style.transform = `scaleX(${Math.max(0, Math.min(1, left / (s.phase_ms ?? (s.status === 'question' ? s.limit_ms : 5000))))})`; if (left > 0) raf = requestAnimationFrame(tick) }
    raf = requestAnimationFrame(tick)
    return box
  }
  const teamDot = (n) => n ? h('span', { class: 'tdot t' + n, title: t('live.team', { n }) }) : null
  const teamBoard = (s) => s.team_rank ? h('div', { class: 'list' }, s.team_rank.map((r) => h('div', { class: 'item' },
    h('span', { class: 'rank' }, '#' + r.rank), teamDot(r.team), h('div', { class: 'grow' }, t('live.team', { n: r.team }), h('span', { class: 'muted' }, ' · ' + t('live.teamMembers', { n: r.members }))),
    h('span', { class: 'score' }, String(r.value))))) : null
  const players = (s, kick) => h('div', { class: 'list' }, s.players.map((p) => h('div', { class: 'item' + (p.is_me ? ' me' : '') },
    s.status === 'finished' || s.status === 'reveal' ? h('span', { class: 'rank' }, '#' + p.rank) : null, teamDot(p.team),
    h('div', { class: 'grow ell' }, p.name + (p.is_me ? ' (' + t('game.you') + ')' : '')),
    s.status === 'question' && p.answered !== undefined ? h('span', { class: 'badge ' + (p.answered ? 'good' : '') }, p.answered ? '✓' : '…') : null,
    s.mode === 'survival' && s.status !== 'lobby' ? h('span', { class: 'badge ' + (p.alive ? 'good' : 'bad') }, p.alive ? t('live.alive') : t('live.out')) : null,
    s.mode === 'race' && s.status !== 'lobby' ? h('div', { class: 'lane', title: String(p.pos) }, h('i', { style: `width:${Math.min(100, Math.round((p.pos / s.race_length) * 100))}%` })) : null,
    s.mode === 'race' && s.status !== 'lobby' ? h('span', { class: 'score' }, `${Math.min(p.pos, s.race_length)}/${s.race_length}`) : null,
    p.candidate ? h('span', { class: 'badge' }, '🎤') : null,
    s.mode === 'blitz' && s.status !== 'lobby' ? h('div', { class: 'lane', title: String(p.score) }, h('i', { style: `width:${Math.round((p.score / Math.max(1, ...s.players.map((x) => x.score))) * 100)}%` })) : null,
    (s.mode === 'tempo' || s.mode === 'bet' || s.mode === 'show' || s.mode === 'blitz' || s.mode === 'estimate') && s.status !== 'lobby' ? h('span', { class: 'score' }, String(p.score)) : null,
    kick && p.public_id && !p.is_me ? h('button', { class: 'btn small danger', 'aria-label': t('profile.remove'), onclick: act('kick', { public_id: p.public_id }) }, '✕') : null)))
  const hostBar = (s) => s.is_host && s.status !== 'finished' ? h('div', { class: 'row wrap' },
    s.status !== 'lobby' ? h('button', { class: 'btn small primary', onclick: act('next') }, t(s.status === 'question' ? 'live.endQuestion' : s.status === 'between' ? 'live.nextRound' : 'live.next')) : null,
    h('button', { class: 'btn small danger', onclick: guard(async () => { if (confirm(t('live.endConfirm'))) await api('POST', `/api/live/${id}/end`, {}) }) }, t('live.end'))) : null

  /** Serie zusammenstellen: Modi antippen (Reihenfolge = Reihenfolge des Antippens) oder Vorlage wählen. */
  const seriesPicker = (s) => {
    const cur = s.series.modes
    const toggle = (m) => cur.includes(m) ? (cur.length > 2 ? { series: cur.filter((x) => x !== m) } : null) : { series: [...cur, m] }
    return [h('p', { class: 'hint' }, t('live.series.info', { points: s.series.points.slice(0, 3).join('/') })),
      h('div', { class: 'seg wrap' }, LIVE_MODES.map((m) => h('button', { 'aria-pressed': String(cur.includes(m)), onclick: () => { const b = toggle(m); if (b) act('settings', b)() } }, (cur.includes(m) ? (cur.indexOf(m) + 1) + '. ' : '') + t('live.mode.' + m)))),
      h('div', { class: 'row wrap' }, h('span', { class: 'muted' }, t('live.series.templates')), Object.keys(SERIES_TEMPLATES).map((k) => h('button', { class: 'btn small', onclick: act('settings', { series: SERIES_TEMPLATES[k] }) }, t('live.series.t.' + k))))]
  }

  const lobby = async (s) => {
    const url = s.token ? liveLink(s.token) : ''
    let qr = null
    if (s.is_host && url) { qr = await renderQr(url); qr.className = 'qr big' }
    const seg = (key, opts, cur) => h('div', { class: 'seg wrap' }, opts.map(([v, label]) => h('button', { 'aria-pressed': String(cur === v), onclick: act('settings', { [key]: v }) }, t(label))))
    mount(topbar(t('live.title'), true),
      s.is_host ? h('div', { class: 'card stack qrcard' }, qr, h('p', { class: 'muted' }, t('live.scan')),
        h('button', { class: 'btn small', onclick: act('renew') }, t('live.renew'))) : h('div', { class: 'card stack' }, h('h3', {}, t('live.waiting')), h('p', { class: 'muted' }, t('live.waitHost'))),
      s.is_host ? h('div', { class: 'card stack' },
        h('div', { class: 'seg' }, [[false, 'live.series.single'], [true, 'live.series.on']].map(([on, label]) => h('button', { 'aria-pressed': String(!!s.series === on), onclick: act('settings', on ? { series: SERIES_TEMPLATES.classic } : { mode: s.mode }) }, t(label)))),
        s.series ? seriesPicker(s) : [seg('mode', LIVE_MODES.map((m) => [m, 'live.mode.' + m]), s.mode), h('p', { class: 'hint' }, t('live.modeInfo.' + s.mode))],
        (s.series ? s.series.modes : [s.mode]).includes('blitz') ? seg('duration', [[45, 'live.blitz.45'], [60, 'live.blitz.60'], [90, 'live.blitz.90']], s.blitz?.duration ?? 60) : null,
        (s.series ? s.series.modes : [s.mode]).some((m) => LIVE_TEAM_MODES.includes(m)) ? [seg('teams', [[0, 'live.teams.off'], [2, 'live.teams.2'], [3, 'live.teams.3'], [4, 'live.teams.4']], s.teams), h('p', { class: 'hint' }, t('live.teamsInfo'))] : null,
        seg('screen', [[true, 'live.screen.on'], [false, 'live.screen.off']], s.screen), h('p', { class: 'hint' }, t(s.screen ? 'live.screenInfo.on' : 'live.screenInfo.off'))) : null,
      s.teams && s.me ? h('div', { class: 'card stack' }, h('p', { class: 'muted' }, t('live.teamPick')), h('div', { class: 'row wrap' },
        [0, ...Array.from({ length: s.teams }, (_, i) => i + 1)].map((n) => h('button', { class: 'btn small' + ((s.me.team ?? 0) === n ? ' primary' : ''), onclick: act('team', { team: n }) }, n ? [teamDot(n), t('live.team', { n })] : t('live.teamAuto'))))) : null,
      h('h2', {}, t('room.players', { n: s.players.length, max: s.max_players })), players(s, s.is_host),
      s.is_host ? h('button', { class: 'btn primary block', disabled: s.players.length < 2, onclick: act('start') }, t('live.start')) : null,
      s.is_host ? h('button', { class: 'btn block danger', onclick: act('end') }, t('live.cancel')) : null)
  }

  const question = (s) => {
    if (s.mode === 'show') return showView(s)
    const q = s.question, reveal = s.status !== 'question'
    const display = s.is_host && s.screen // Bildschirm-Ansicht des Hosts
    const answered = s.me?.answered
    const mineChoice = s.me?.choice
    const head = h('div', { class: 'q-head' }, catChip(q.category), h('span', { class: 'muted' }, t('ladder.step', { n: s.idx + 1, total: s.total }) + (q.prize ? ' · ' + money(q.prize) : '')))
    const maxCount = Math.max(1, ...(q.counts ?? [1]))
    const opt = (text, i) => {
      const cls = 'opt lv-' + LETTERS[i].toLowerCase() + (reveal ? (i === q.correct_index ? ' good' : mineChoice === i ? ' bad' : ' dim') : (answered && s.me && !reveal ? '' : ''))
      const label = display || s.screen ? [h('kbd', {}, LETTERS[i]), display ? h('span', {}, text) : null] : [h('kbd', {}, LETTERS[i]), h('span', {}, text)]
      const canAnswer = !display && s.me && !answered && !reveal && (s.mode !== 'survival' || s.me.alive)
      return h('button', { class: cls + (display ? ' big' : '') + (s.screen && !display ? ' letter' : ''), disabled: !canAnswer, onclick: guard(async () => { await api('POST', `/api/live/${id}/answer`, { idx: s.idx, choice: i }) }) },
        ...label, reveal && display && q.counts ? h('span', { class: 'cnt' }, h('i', { style: `width:${Math.round((q.counts[i] / maxCount) * 100)}%` }), String(q.counts[i])) : null)
    }
    const status = reveal && s.me ? h('div', { class: 'feedback' }, h('strong', {}, s.me.correct === undefined ? t('play.timeUp') : s.me.correct ? t('play.right') : t('play.wrong')),
      s.mode === 'tempo' ? h('span', { class: 'score' }, '+' + (s.me.points ?? 0)) : s.mode === 'bet' ? h('span', { class: 'score' }, (s.me.points > 0 ? '+' : '') + (s.me.points ?? 0)) : s.mode === 'race' ? null : (s.me.alive ? h('span', { class: 'badge good' }, t('live.alive')) : h('span', { class: 'badge bad' }, t('live.out')))) :
      !reveal && answered ? h('div', { class: 'feedback' }, h('strong', {}, t('live.sent'))) :
      !reveal && s.me && s.mode === 'survival' && !s.me.alive ? h('div', { class: 'feedback' }, h('strong', {}, t('live.spectate'))) : null
    mount(liveBar(),
      h('div', { class: 'card qcard' + (display ? ' display' : ''), cat: q.category }, head, timerBar(s),
        !s.screen || display ? h('div', { class: 'question' + (display ? ' bigq' : '') }, q.text) : null,
        h('div', { class: 'opts' + (display ? ' grid' : s.screen ? ' grid' : '') }, q.options.map(opt)), status,
        reveal && q.explanation ? h('p', { class: 'muted' }, q.explanation) : null),
      reveal || display ? h('div', { class: 'card stack' }, s.team_rank ? h('h3', {}, t('live.teamRank')) : null, teamBoard(s), s.team_rank ? h('h3', {}, t('room.ranking')) : null, players({ ...s, players: s.players.slice(0, display ? 8 : 5) }, false)) : null,
      hostBar(s))
  }

  /** Einsatzphase: nur die Kategorie ist bekannt – wie viel riskierst du? */
  const betView = (s) => {
    const q = s.question, display = s.is_host && s.screen, mine = s.me?.bet
    const choice = (amount, label) => h('button', { class: 'opt big' + (mine === amount ? ' good' : ''), disabled: display || !s.me,
      onclick: guard(async () => { await api('POST', `/api/live/${id}/bet`, { idx: s.idx, amount }) }) }, label)
    mount(liveBar(),
      h('div', { class: 'card qcard' + (display ? ' display' : ''), cat: q.category },
        h('div', { class: 'q-head' }, catChip(q.category), h('span', { class: 'muted' }, t('ladder.step', { n: s.idx + 1, total: s.total }) + ' · ' + '●'.repeat(q.difficulty ?? 1) + '○'.repeat(3 - (q.difficulty ?? 1)))),
        timerBar(s),
        h('div', { class: 'question' + (display ? ' bigq' : '') }, t(s.bet.final ? 'live.bet.finalTitle' : 'live.bet.title')),
        s.me ? h('p', { class: 'muted' }, t('live.bet.capital', { n: s.me.score })) : null,
        h('div', { class: 'opts grid' }, [...s.bet.choices.map((c) => choice(c, String(c))), choice(s.bet.all_in, t('live.bet.allin'))]),
        h('p', { class: 'hint' }, t(s.bet.final ? 'live.bet.finalInfo' : 'live.bet.info'))),
      h('div', { class: 'card stack' }, players(s, false)),
      hostBar(s))
  }

  /** Quizshow: Kandidat auf der Leiter, Publikum stimmt ab. */
  let pick = { idx: -1, choice: -1 }
  const showView = (s) => {
    const q = s.question, sh = s.show, reveal = s.status !== 'question', display = s.is_host && s.screen
    const climb = sh.stage === 'climb', isCand = sh.is_candidate
    if (pick.idx !== s.idx) pick = { idx: s.idx, choice: -1 }
    const hidden = q.hidden ?? []
    const spectating = sh.stage === 'qualify' && s.me && s.me.alive === false
    const canVote = !display && s.me && !s.me.answered && !reveal && !spectating
    const maxCount = Math.max(1, ...(q.counts ?? [1]))
    const opt = (text, i) => {
      const mineChoice = s.me?.choice
      const cls = 'opt lv-' + LETTERS[i].toLowerCase() + (reveal ? (i === q.correct_index ? ' good' : mineChoice === i ? ' bad' : ' dim') : hidden.includes(i) ? ' dim' : pick.choice === i ? ' sel' : '')
      const label = display || s.screen ? [h('kbd', {}, LETTERS[i]), display ? h('span', {}, text) : null] : [h('kbd', {}, LETTERS[i]), h('span', {}, text)]
      const choose = () => { if (climb && isCand) { pick.choice = i; showView(s) } else guard(async () => { await api('POST', `/api/live/${id}/answer`, { idx: s.idx, choice: i }) })() }
      return h('button', { class: cls + (display ? ' big' : '') + (s.screen && !display ? ' letter' : ''), disabled: !canVote || hidden.includes(i), onclick: choose },
        ...label, sh.audience && (display || isCand) ? h('span', { class: 'cnt' }, h('i', { style: `width:${sh.audience[i]}%` }), sh.audience[i] + ' %') : reveal && display && q.counts ? h('span', { class: 'cnt' }, h('i', { style: `width:${Math.round((q.counts[i] / maxCount) * 100)}%` }), String(q.counts[i])) : null)
    }
    const steps = climb ? h('div', { class: 'steps' }, Array.from({ length: sh.steps }, (_, i) => h('i', { class: (i + 1 < sh.step || (i + 1 === sh.step && reveal && sh.done && s.show.results.at(-1)?.how === 'won') ? 'done' : '') + (i + 1 === sh.step ? ' now' : '') + (sh.safe_steps.includes(i + 1) ? ' safe' : ''), title: money(sh.prizes[i]) }))) : null
    const head = h('div', { class: 'q-head' }, catChip(q.category), h('span', { class: 'muted' }, climb ? t('ladder.step', { n: sh.step, total: sh.steps }) + ' · ' + money(q.prize) : t('show.qualify')))
    const who = sh.candidate ? h('p', { class: 'hint' }, t('show.candidate', { name: sh.candidate.name }) + (climb ? ' · ' + t('show.safe', { amount: money(sh.guaranteed) }) : '')) : null
    let msg = null
    if (reveal) {
      const last = sh.results.at(-1)
      msg = sh.stage === 'qualify' ? h('strong', {}, sh.candidate ? t('show.nextCandidate', { name: sh.candidate.name }) : t('show.noCandidate'))
        : sh.done && last ? h('strong', {}, t('show.res.' + last.how, { name: sh.candidate?.name ?? '', amount: money(last.prize) })) : h('strong', {}, t('show.continue'))
    } else if (spectating) msg = h('strong', {}, t('live.spectate'))
    else if (s.me?.answered) msg = h('strong', {}, t('live.sent'))
    const controls = climb && isCand && !reveal && !s.me?.answered ? h('div', { class: 'stack' },
      h('button', { class: 'btn primary block', disabled: pick.choice < 0, onclick: guard(async () => { await api('POST', `/api/live/${id}/answer`, { idx: s.idx, choice: pick.choice }) }) }, pick.choice < 0 ? t('show.pick') : t('show.final', { letter: LETTERS[pick.choice] })),
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn small', disabled: !sh.jokers.audience, onclick: guard(async () => { await api('POST', `/api/live/${id}/show`, { action: 'audience' }) }) }, '👥 ' + t('show.audience')),
        h('button', { class: 'btn small', disabled: !sh.jokers.fifty, onclick: guard(async () => { await api('POST', `/api/live/${id}/show`, { action: 'fifty' }) }) }, '½ ' + t('show.fifty')),
        h('button', { class: 'btn small danger', onclick: guard(async () => { if (confirm(t('show.quitConfirm', { amount: money(sh.banked) }))) await api('POST', `/api/live/${id}/show`, { action: 'quit' }) }) }, t('show.quit', { amount: money(sh.banked) })))) : null
    mount(liveBar(),
      h('div', { class: 'card qcard' + (display ? ' display' : ''), cat: q.category }, head, timerBar(s), steps,
        !s.screen || display ? h('div', { class: 'question' + (display ? ' bigq' : '') }, q.text) : null,
        who,
        h('div', { class: 'opts' + (display || s.screen ? ' grid' : '') }, q.options.map(opt)), msg ? h('div', { class: 'feedback' }, msg) : null, controls,
        reveal && q.explanation ? h('p', { class: 'muted' }, q.explanation) : null),
      reveal || display ? h('div', { class: 'card stack' }, players({ ...s, players: s.players.slice(0, display ? 8 : 5) }, false)) : null,
      hostBar(s))
  }

  /** Blitzrunde: jeder im eigenen Tempo; Handys leben von den Antwort-Rückgaben, der Bildschirm zeigt den Zwischenstand. */
  let bl = null, flash = null, lockTimer = 0
  const blitzView = (s) => {
    const display = s.is_host && s.screen
    if (display) {
      return mount(liveBar(),
        h('div', { class: 'card stack' }, h('h3', {}, t('live.mode.blitz')), timerBar(s), h('p', { class: 'muted' }, t('live.blitz.screen'))),
        h('div', { class: 'card stack' }, players(s, false)), hostBar(s))
    }
    if (!bl || !s.blitz?.me) bl = s.blitz?.me ?? null
    const me = bl
    if (!me) return mount(liveBar(), h('div', { class: 'card stack' }, h('p', { class: 'muted' }, t('live.spectate'))))
    clearTimeout(lockTimer)
    const locked = me.lock_ms > 0
    if (locked) lockTimer = setTimeout(() => { bl = { ...bl, lock_ms: 0 }; blitzView(s) }, me.lock_ms)
    const q = me.question
    const answerIt = async (i) => {
      try {
        const r = await api('POST', `/api/live/${id}/answer`, { idx: me.n, choice: i })
        flash = { choice: i, correct_index: r.correct_index, ok: r.correct }; bl = r.blitz
        blitzView(s)
        setTimeout(() => { flash = null; blitzView(s) }, 350)
      } catch (e) {
        toast(errText(e)); const st = await api('GET', `/api/live/${id}`).catch(() => null); if (st) { bl = st.live.blitz?.me ?? bl; if (st.live.status !== 'question') return render(st.live) } blitzView(s)
      }
    }
    mount(liveBar(),
      h('div', { class: 'card qcard' }, h('div', { class: 'q-head' }, q ? catChip(q.category) : null, h('span', { class: 'muted' }, t('live.blitz.score', { n: me.score }))), timerBar(s),
        q ? [h('div', { class: 'question' }, q.text),
          locked ? h('p', { class: 'hint' }, '⏸ ' + t('live.blitz.pause')) : null,
          h('div', { class: 'opts' }, q.options.map((text, i) => h('button', { class: 'opt' + (flash ? (i === flash.correct_index ? ' good' : i === flash.choice ? ' bad' : ' dim') : ''), disabled: locked || !!flash, onclick: () => answerIt(i) }, h('kbd', {}, String(i + 1)), h('span', {}, text))))]
          : h('div', { class: 'question' }, t('live.blitz.done'))),
      s.is_host ? hostBar(s) : null)
  }

  /** Schätzrunde: Zahl eintippen; Auflösung mit der richtigen Zahl und allen Tipps (Rang nach Abstand). */
  let draft = { idx: -1, text: '', focus: false }
  const estimateView = (s) => {
    const e = s.estimate, reveal = s.status !== 'question', display = s.is_host && s.screen
    if (draft.idx !== s.idx) draft = { idx: s.idx, text: '', focus: false }
    const send = guard(async () => {
      const v = parseGuess(draft.text)
      if (v === null) return toast(t('estimate.bad'))
      await api('POST', `/api/live/${id}/guess`, { idx: s.idx, value: v })
    })
    const input = h('input', { type: 'text', inputmode: 'decimal', autocomplete: 'off', class: 'guess', value: draft.text, placeholder: e.unit || t('estimate.number'), 'aria-label': t('estimate.number'),
      oninput: (ev) => { draft.text = ev.target.value }, onfocus: () => { draft.focus = true }, onblur: () => { draft.focus = false },
      onkeydown: (ev) => { if (ev.key === 'Enter') send() } })
    const head = h('div', { class: 'q-head' }, catChip(e.category), h('span', { class: 'muted' }, t('ladder.step', { n: s.idx + 1, total: s.total })))
    const canGuess = !display && s.me && !s.me.answered && !reveal
    const body = reveal ? h('div', { class: 'stack' },
      h('div', { class: 'estimate-answer' }, h('span', { class: 'muted' }, t('estimate.answer')), h('strong', {}, fmtGuess(e.answer, e.unit))),
      s.me ? h('div', { class: 'feedback' }, h('strong', {}, e.my_guess === undefined ? t('estimate.none') : t('estimate.yours', { v: fmtGuess(e.my_guess, e.unit) })), h('span', { class: 'score' }, '+' + (s.me.points ?? 0))) : null,
      h('div', { class: 'list' }, e.guesses.map((g) => h('div', { class: 'item' + (g.is_me ? ' me' : '') }, h('span', { class: 'rank' }, '#' + g.rank), h('div', { class: 'grow ell' }, g.name),
        h('span', { class: 'muted' }, fmtGuess(g.value, e.unit) + ' · ' + (g.error < 0.005 ? t('estimate.exact') : '±' + Math.round(g.error * 100) + ' %')), h('span', { class: 'score' }, '+' + g.points)))),
      e.explanation ? h('p', { class: 'muted' }, e.explanation) : null)
      : canGuess ? h('div', { class: 'stack' }, h('div', { class: 'row' }, input, h('button', { class: 'btn primary', onclick: send }, t('estimate.send'))), h('p', { class: 'hint' }, t('estimate.hint')))
      : s.me?.answered ? h('div', { class: 'feedback' }, h('strong', {}, t('estimate.sent', { v: fmtGuess(e.my_guess, e.unit) })))
      : display ? h('p', { class: 'hint' }, t('estimate.screen')) : null
    mount(liveBar(),
      h('div', { class: 'card qcard' + (display ? ' display' : ''), cat: e.category }, head, timerBar(s), h('div', { class: 'question' + (display ? ' bigq' : '') }, e.text), e.unit && !reveal ? h('p', { class: 'hint' }, t('estimate.unit', { unit: e.unit })) : null, body),
      reveal || display ? h('div', { class: 'card stack' }, s.team_rank ? h('h3', {}, t('live.teamRank')) : null, teamBoard(s), s.team_rank ? h('h3', {}, t('room.ranking')) : null, players({ ...s, players: s.players.slice(0, display ? 8 : 5) }, false)) : null,
      hostBar(s))
    if (draft.focus && canGuess) { input.focus(); const n = input.value.length; try { input.setSelectionRange(n, n) } catch { /* */ } }
  }

  /** Gesamtwertung einer Serie (Serienpunkte, Siege, Zuwachs der letzten Runde). */
  const seriesBoard = (sr) => h('div', { class: 'list' }, sr.standings.map((r) => h('div', { class: 'item' + (r.is_me ? ' me' : '') },
    h('span', { class: 'rank' }, '#' + r.rank), h('div', { class: 'grow ell' }, r.name + (r.is_me ? ' (' + t('game.you') + ')' : ''), h('span', { class: 'muted' }, ' · ' + t('live.series.wins', { n: r.wins }))),
    r.last && sr.last ? h('span', { class: 'muted' }, '+' + r.last) : null, h('span', { class: 'score' }, String(r.points)))))
  /** Zwischenwertung nach einer Runde: Platzierung der Runde, Gesamtstand, was als Nächstes kommt. */
  const betweenView = (s) => {
    const sr = s.series, next = sr.modes[sr.index + 1]
    mount(liveBar(),
      h('div', { class: 'card stack' }, h('h3', {}, t('live.series.between')), timerBar(s), h('p', { class: 'muted' }, t('live.series.nextUp', { mode: t('live.mode.' + next) }) + (s.is_host ? '' : ' · ' + t('live.series.hostNext')))),
      h('h2', {}, t('live.series.total')), seriesBoard(sr),
      s.team_rank ? [h('h2', {}, t('live.teamRank')), teamBoard(s)] : null,
      sr.last ? [h('h2', {}, t('live.series.lastRound', { mode: t('live.mode.' + sr.last.mode) })), h('div', { class: 'list' }, sr.last.ranks.map((r) => h('div', { class: 'item' + (r.is_me ? ' me' : '') }, h('span', { class: 'rank' }, '#' + r.rank), h('div', { class: 'grow ell' }, r.name), h('span', { class: 'score' }, '+' + r.pts))))] : null,
      hostBar(s))
  }

  const finished = (s) => (bl = null, mount(topbar(t('live.title'), true),
    h('div', { class: 'card stack lresult' }, h('h3', {}, t(s.series ? 'live.series.finished' : 'live.finished')), s.team_rank ? h('div', { class: 'big' }, '🏆 ' + t('live.team', { n: s.team_rank[0].team })) : s.series?.standings[0] ? h('div', { class: 'big' }, '🏆 ' + s.series.standings[0].name) : s.players[0] ? h('div', { class: 'big' }, '🏆 ' + s.players[0].name) : null),
    s.series ? [h('h2', {}, t('live.series.total')), seriesBoard(s.series)] : null,
    s.team_rank ? [h('h2', {}, t('live.teamRank')), teamBoard(s)] : null,
    s.show?.results?.length ? [h('h2', {}, t('show.results')), h('div', { class: 'list' }, s.show.results.map((r) => h('div', { class: 'item' }, h('div', { class: 'grow ell' }, r.name), h('span', { class: 'badge' }, t('show.how.' + r.how)), h('span', { class: 'score' }, money(r.prize)))))] : null,
    h('h2', {}, s.series ? t('live.series.lastRound', { mode: t('live.mode.' + s.mode) }) : t('room.ranking')), players(s, false),
    h('button', { class: 'btn block', onclick: () => go('#/') }, t('ladder.home'))))

  let rendering = false, pending = null
  const render = async (s) => {
    if (my !== runId) return
    seriesLabel = s.series && s.status !== 'lobby' && s.status !== 'finished' ? t('live.series.round', { n: s.series.index + 1, total: s.series.modes.length }) + ' · ' + t('live.mode.' + s.mode) : ''
    document.getElementById('app').classList.toggle('wide', s.is_host && s.screen && s.status !== 'lobby') // Bildschirm-Ansicht darf breit sein
    if (rendering) { pending = s; return }
    rendering = true
    try {
      if (s.status === 'lobby') { if (!document.activeElement || document.activeElement === document.body || s.token !== lastQr) { lastQr = s.token; await lobby(s) } else await lobby(s) }
      else if (s.status === 'finished') finished(s)
      else if (s.status === 'between') betweenView(s)
      else if (s.mode === 'blitz' && s.status === 'question') { if (!(bl && !(s.is_host && s.screen))) blitzView(s) }
      else if (s.mode === 'estimate' && s.estimate) estimateView(s)
      else if (s.status === 'bet' && s.question) betView(s)
      else if (s.question) question(s)
    } finally { rendering = false }
    if (pending) { const p = pending; pending = null; render(p) }
  }
  mount(topbar(t('live.title'), true), h('div', { class: 'card stack' }, h('p', {}, t('room.joining'))))
  connectLive(id, (s) => { offset = s.now - Date.now(); render(s) }, () => { toast(t('err.not_found')); go('#/') })
}

/* ---------- Bestenliste (Opt-in) ---------- */
async function top(_, my) {
  const st = { kind: store.get('rp.lbKind') || 'abs', bots: store.get('rp.lbBots') || 'incl', scope: store.get('rp.lbScope') || 'week' }
  const name = h('input', { type: 'text', maxLength: 20, placeholder: t('lb.namePlaceholder'), autocomplete: 'off' })
  const useOwn = h('input', { type: 'checkbox', onchange: () => { name.disabled = useOwn.checked } })
  const seg = (key, opts, storeKey) => h('div', { class: 'seg wrap' }, opts.map(([v, label]) => h('button', { 'aria-pressed': String(st[key] === v), onclick: () => { st[key] = v; store.set(storeKey, v); load() } }, t(label))))
  const render = (r) => {
    if (my !== runId) return
    const val = (x) => (st.kind === 'abs' ? h('span', { class: 'score' }, String(x.ok), h('span', { class: 'muted' }, ` / ${x.n}`)) : h('span', { class: 'score' }, `${x.rate} %`, h('span', { class: 'muted' }, ` (${x.ok}/${x.n})`)))
    const rows = r.top.map((x) => h('div', { class: 'item' + (x.is_me ? ' me' : '') }, h('span', { class: 'rank' }, '#' + x.rank), h('div', { class: 'grow ell' }, x.name + (x.is_me ? ' (' + t('game.you') + ')' : '')), val(x)))
    const mine = r.me ? h('p', { class: 'hint' }, r.me.rank ? t('lb.myRank', { rank: r.me.rank, total: r.total }) : r.me.young ? t('lb.young') : t('lb.needs', { n: r.me.needs })) : null
    const join = r.banned ? h('p', { class: 'hint' }, t('err.lb_banned'))
      : r.participating
        ? h('div', { class: 'stack' }, h('p', { class: 'muted' }, t('lb.participating', { name: r.name })), h('button', { class: 'btn block', onclick: guard(async () => { await api('DELETE', '/api/leaderboard/join'); await refreshMe(); load() }) }, t('lb.leave')))
        : h('div', { class: 'stack' }, h('p', { class: 'muted' }, t('lb.joinInfo')), h('label', { class: 'field' }, t('lb.name'), name),
          h('label', { class: 'row' }, useOwn, h('span', { class: 'hint' }, t('lb.useDisplay', { name: S.me.name }))),
          h('button', { class: 'btn primary block', onclick: guard(async () => { await api('POST', '/api/leaderboard/join', useOwn.checked ? { use_display_name: true } : { name: name.value }); await refreshMe(); load() }) }, t('lb.join')))
    mount(topbar(t('lb.title')),
      h('div', { class: 'card stack' }, seg('kind', [['abs', 'lb.abs'], ['rel', 'lb.rel']], 'rp.lbKind'), seg('bots', [['incl', 'lb.botsIncl'], ['excl', 'lb.botsExcl']], 'rp.lbBots'), seg('scope', [['week', 'lb.week'], ['month', 'lb.month'], ['all', 'lb.all']], 'rp.lbScope'), mine),
      rows.length ? h('div', { class: 'list' }, rows) : h('div', { class: 'empty' }, t('lb.empty')),
      h('div', { class: 'card stack' }, join, h('p', { class: 'hint' }, t('lb.rules', { rel: r.rules.min_relative, abs: r.rules.min_answers, cap: r.rules.day_cap }))))
  }
  const load = guard(async () => render(await api('GET', `/api/leaderboard?scope=${st.scope}&bots=${st.bots}&kind=${st.kind}`)))
  await load()
}

/* ---------- Millionen-Leiter (Solo) ---------- */
const money = (n) => t('ladder.money', { n: Number(n).toLocaleString(getLang()) })

async function ladder(id) {
  const { ladder: l } = await api('GET', `/api/ladders/${id}`)
  const active = l.status === 'active'
  const rows = [...l.prizes].map((p, i) => ({ n: i + 1, p })).reverse().map(({ n, p }) => h('div', {
    class: 'lrow' + (active && n === l.current ? ' now' : '') + (n <= l.answered ? ' done' : '') + (l.safe_steps.includes(n) ? ' safe' : ''),
  }, h('span', { class: 'ln' }, String(n)), h('span', { class: 'grow' }, money(p)), h('span', {}, l.safe_steps.includes(n) ? '🔒' : n <= l.answered ? '✓' : '')))
  const result = !active ? h('div', { class: 'card stack lresult' },
    h('h3', {}, t(l.status === 'quit' ? 'ladder.status_quit' : 'ladder.' + l.status)), h('div', { class: 'big' }, money(l.prize ?? 0)),
    S.me.best_ladder ? h('p', { class: 'muted' }, t('ladder.best', { prize: money(Math.max(S.me.best_ladder, l.prize ?? 0)) })) : null,
    h('button', { class: 'btn primary block', onclick: guard(async () => { const r = await api('POST', '/api/ladders', { lang: gameLang() }); go('#/ladder/' + r.id) }) }, t('ladder.again')),
    h('button', { class: 'btn block', onclick: () => go('#/') }, t('ladder.home'))) : null
  if (!active) await refreshMe()
  mount(topbar(t('ladder.title'), true),
    result,
    active ? h('div', { class: 'card stack' },
      h('p', { class: 'muted' }, t('ladder.rules')),
      h('button', { class: 'btn primary block', onclick: () => goReplace('#/lplay/' + id) }, t(l.answered ? 'ladder.continue' : 'ladder.begin', { n: l.current })),
      l.answered ? h('button', { class: 'btn block danger', onclick: guard(async () => {
        if (!confirm(t('ladder.quitConfirm', { prize: money(l.banked) }))) return
        await api('POST', `/api/ladders/${id}/quit`, {}); route() }) }, t('ladder.quit', { prize: money(l.banked) })) : null) : null,
    h('div', { class: 'card ladder' }, rows))
}

/** Eine Frage der Leiter bzw. Raumrunde stellen; `base` ist der API-Pfad der Leiter oder des Raums (gleiche Unterrouten). */
async function askOne(base, back, my, chain = false) {
  let raf = 0, keyHandler = null
  const prev = cleanup
  cleanup = () => { prev(); cancelAnimationFrame(raf); if (keyHandler) document.removeEventListener('keydown', keyHandler) }
  const alive = () => my === runId
  let q
  try { q = await api('GET', `${base}/question`) } catch (e) {
    if (e.status === 409) return goReplace(back)
    throw e
  }
  if (!alive()) return
  const result = await new Promise((resolve) => {
    let done = false
    const bar = h('i')
    const buttons = q.options.map((text, i) => h('button', { class: 'opt', onclick: () => submit(i) }, h('kbd', {}, String(i + 1)), h('span', {}, text)))
    const feedback = h('div', { class: 'feedback' })
    mount(
      topbar(t(base.includes('/rooms/') ? 'room.title' : 'ladder.title'), true),
      h('div', { class: 'card qcard', cat: q.category },
        h('div', { class: 'q-head' }, catChip(q.category), h('span', { class: 'muted' }, t('ladder.step', { n: q.step, total: q.total }) + (q.prize ? ' · ' + money(q.prize) : ''))),
        h('div', { class: 'timer' }, bar), h('div', { class: 'question' }, q.text), h('div', { class: 'opts' }, buttons), feedback))
    const deadline = performance.now() + q.remaining_ms
    const tick = () => {
      const left = deadline - performance.now()
      bar.style.transform = `scaleX(${Math.max(0, left / q.limit_ms)})`
      if (left <= 0) submit(-1); else raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    keyHandler = (e) => { const n = Number(e.key); if (n >= 1 && n <= 4) submit(n - 1) }
    document.addEventListener('keydown', keyHandler)

    async function submit(choice) {
      if (done) return
      done = true
      cancelAnimationFrame(raf)
      buttons.forEach((b) => (b.disabled = true))
      bar.parentNode?.classList.add('done') // Platz für Erklärung und „Weiter“
      let r
      try { r = await api('POST', `${base}/answer`, { step: q.step, choice }) } catch (e) { toast(errText(e)); return resolve() }
      buttons[r.correct_index]?.classList.add('good')
      if (choice >= 0 && !r.correct) buttons[choice].classList.add('bad')
      const label = choice === -1 ? t('play.timeUp') : r.correct ? t('play.right') : t('play.wrong')
      const showReport = S.meta?.reports !== false && store.get('rp.noReport') !== '1'
      const report = h('button', { class: 'btn small', title: t('play.report'), 'aria-label': t('play.report'), onclick: guard(async () => {
        await api('POST', `${base}/report`, { step: q.step, reason: '' }); report.disabled = true; toast(t('play.reported')) }) }, '⚑')
      const review = S.me?.reviewer ? h('button', { class: 'btn small', title: t('play.review'), 'aria-label': t('play.review'), onclick: () => {
        const part = h('select', {}, ['question', 'answers'].map((v) => h('option', { value: v }, t('review.part.' + v))))
        const kind = h('select', {}, ['wrong', 'wording'].map((v) => h('option', { value: v }, t('review.kind.' + v))))
        const note = h('input', { type: 'text', maxLength: 300, placeholder: t('review.note') })
        const form = h('div', { class: 'stack' }, h('div', { class: 'row' }, part, kind), note, h('div', { class: 'row' },
          h('button', { class: 'btn small primary', onclick: guard(async () => {
            await api('POST', `${base}/review`, { step: q.step, part: part.value, kind: kind.value, note: note.value })
            form.remove(); review.disabled = true; toast(t('review.sent')) }) }, t('review.send')),
          h('button', { class: 'btn small', onclick: () => form.remove() }, t('review.cancel'))))
        feedback.append(form); note.focus()
      } }, '✎') : null
      const over = r.over
      feedback.append(h('strong', {}, label), h('span', { class: 'row' }, review, showReport ? report : null,
        h('button', { class: 'btn small primary', onclick: () => resolve(r) }, over ? t('ladder.result') : t('play.next'))))
      if (r.explanation) feedback.before(h('p', { class: 'muted' }, r.explanation))
    }
  })
  if (keyHandler) document.removeEventListener('keydown', keyHandler)
  if (!alive()) return
  if (chain && result && !result.over) return askOne(base, back, my, chain) // Raumrunden: direkt zur nächsten Frage
  goReplace(back)
}

const lplay = (id, my) => askOne(`/api/ladders/${id}`, '#/ladder/' + id, my)
const rplay = (id, my) => askOne(`/api/rooms/${id}`, '#/room/' + id, my, true)

/* ---------- Mehrspieler-Räume (asynchron) ---------- */
const modeName = (m) => t('room.mode.' + m)

async function joinRoom(code) {
  const r = await api('POST', '/api/rooms/join', { code })
  go('#/room/' + r.id)
}
const roomLink = (code) => `${location.origin}/#/join/${code}`

async function room(id, my) {
  const load = async () => {
    const { room: r } = await api('GET', `/api/rooms/${id}`)
    if (my !== runId) return
    const me = r.players.find((p) => p.is_me)
    const rows = (r.status === 'finished' ? [...r.players].sort((a, b) => a.rank - b.rank) : r.players).map((p) => h('div', { class: 'item' },
      r.status === 'finished' ? h('span', { class: 'rank' }, '#' + p.rank) : null,
      h('div', { class: 'grow' }, h('div', { class: 'ell' }, p.name + (p.is_host ? ' 👑' : '') + (p.is_me ? ' (' + t('game.you') + ')' : '')),
        h('div', { class: 'muted' }, r.status === 'lobby' ? '' : p.done ? t('room.done') : t('room.progress', { n: p.pos, total: r.total }))),
      p.score !== null && r.status !== 'lobby' ? h('span', { class: 'score' }, r.mode === 'ladder' ? money(p.score) : `${p.score}/${r.total}`) : null))
    const actions = []
    if (r.status === 'lobby') {
      actions.push(
        h('div', { class: 'code' }, r.code),
        h('button', { class: 'btn block', onclick: () => share(roomLink(r.code), t('app.name')) }, '🔗 ' + t('room.share')),
        r.is_host
          ? h('button', { class: 'btn primary block', disabled: r.players.length < 2, onclick: guard(async () => { await api('POST', `/api/rooms/${id}/start`, {}); route() }) }, t('room.start'))
          : h('p', { class: 'muted' }, t('room.waitHost')),
        h('button', { class: 'btn block danger', onclick: guard(async () => { await api('POST', `/api/rooms/${id}/leave`, {}); go('#/') }) }, t(r.is_host ? 'room.dissolve' : 'room.leave')))
    } else if (r.status === 'active') {
      if (!me.done) {
        actions.push(h('button', { class: 'btn primary block', onclick: () => goReplace('#/rplay/' + id) }, t(me.pos ? 'ladder.continue' : 'ladder.begin', { n: me.pos + 1 })))
        if (r.mode === 'ladder' && me.pos) actions.push(h('button', { class: 'btn block danger', onclick: guard(async () => {
          if (!confirm(t('ladder.quitConfirm', { prize: money(me.score) }))) return
          await api('POST', `/api/rooms/${id}/quit`, {}); route() }) }, t('ladder.quit', { prize: money(me.score) })))
      } else actions.push(h('p', { class: 'muted' }, t('room.waitOthers')))
    } else actions.push(h('button', { class: 'btn block', onclick: () => go('#/') }, t('ladder.home')))
    mount(topbar(modeName(r.mode) + ' · ' + r.code, true),
      h('div', { class: 'card stack' }, h('p', { class: 'muted' }, t('room.info.' + r.mode, { n: r.total || (r.mode === 'quiz' ? 12 : 15) })),
        r.level && r.level !== 'basic' ? h('div', { class: 'hint' }, t('level.badge', { level: t('tier.' + r.level) })) : null),
      r.status === 'finished' ? h('h2', {}, t('room.ranking')) : h('h2', {}, t('room.players', { n: r.players.length, max: r.max_players })),
      h('div', { class: 'list' }, rows), h('div', { class: 'card stack' }, actions))
  }
  await guard(load)()
  poll(guard(load), 8000)
}

async function join(code) {
  mount(topbar(t('app.name'), false), h('div', { class: 'card stack' }, h('p', {}, t('room.joining'))))
  await joinRoom(code || '')
}

function roomItem(r) {
  const badge = r.status === 'finished' ? t('room.finishedRank', { rank: r.my_rank }) : r.status === 'lobby' ? t('room.lobby') : r.my_done ? t('room.waitOthers') : t('room.yourTurn')
  return h('button', { class: 'item', onclick: () => go('#/room/' + r.id) }, h('div', { class: 'avatar sm' }, r.mode === 'ladder' ? '💎' : '👥'),
    h('div', { class: 'grow' }, h('div', { class: 'ell' }, modeName(r.mode) + ' · ' + r.code), h('div', { class: 'muted' }, badge)), h('span', { class: 'badge' }, t('room.playersN', { n: r.players })))
}

/* ---------- Profil ---------- */
function importControls() {
  const file = h('input', { type: 'file', accept: 'application/json,.json', hidden: true, onchange: guard(async (e) => {
    const f = e.target.files[0]
    if (!f) return
    let data
    try { data = JSON.parse(await f.text()) } catch { data = null }
    if (data?.format !== 'ratespass-profile' || typeof data.token !== 'string') throw new ApiError(0, 'bad_file')
    if (data.player?.public_id && Array.isArray(data.contacts)) {
      store.set(LC_KEY, JSON.stringify({ owner: data.player.public_id, list: data.contacts.filter((c) => parseCode(c?.public_id)).map((c) => ({ public_id: c.public_id, name: String(c.name ?? '') })) }))
    }
    await adoptToken(data.token)
  }) })
  const code = h('input', { type: 'text', placeholder: 'ABCD-EFGH', maxLength: 12, autocapitalize: 'characters', autocomplete: 'off' })
  return h('div', { class: 'stack' },
    h('button', { class: 'btn block', onclick: () => file.click() }, t('profile.import')), file,
    h('label', { class: 'field' }, t('profile.transferEnter'), h('div', { class: 'row' }, code,
      h('button', { class: 'btn', onclick: guard(async () => { const r = await api('POST', '/api/transfer/redeem', { code: code.value }, { auth: false }); await adoptToken(r.token) }) }, t('profile.transferUse')))))
}
async function adoptToken(token) {
  S.token = token; store.set('rp.token', token); S.me = null
  await refreshMe(true)
  toast(t('profile.saved')); go('#/')
}

/** Spielstufe und Extra-Kategorien: jeder stellt selbst ein; im Duell gilt die niedrigste Einstellung beider. */
function levelCard() {
  const p = S.me, tiers = S.meta.tiers, levels = S.meta.levels ?? ['basic', 'nerd', 'expert']
  const rank = (l) => levels.indexOf(l)
  const off = new Set(p.disabled_cats ?? [])
  const save = guard(async () => { const r = await api('PATCH', '/api/me', { level: p.level, disabled_cats: [...off] }); S.me = { ...S.me, ...r.player }; toast(t('profile.saved')) })
  const cats = h('div', { class: 'stack' })
  const draw = () => cats.replaceChildren(...levels.filter((l) => l !== 'basic' && rank(l) <= rank(p.level)).map((l) => h('div', { class: 'stack' },
    h('div', { class: 'hint' }, t('tier.' + l)),
    h('div', { class: 'row wrap' }, Object.keys(tiers).filter((c) => tiers[c] === l).map((c) => h('label', { class: 'row chipcheck', cat: c },
      h('input', { type: 'checkbox', checked: !off.has(c), onchange: (e) => { e.target.checked ? off.delete(c) : off.add(c); save() } }), h('span', {}, t('cat.' + c))))))))
  const seg = h('div', { class: 'seg wrap' }, levels.map((l) => h('button', { 'aria-pressed': String(p.level === l), onclick: (e) => {
    p.level = l; seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === e.currentTarget))); desc.textContent = t('level.' + l + 'Desc'); draw(); save() } }, t('tier.' + l))))
  const desc = h('p', { class: 'hint' }, t('level.' + p.level + 'Desc'))
  draw()
  return [h('h2', {}, t('level.title')), h('div', { class: 'card stack' }, h('p', { class: 'muted' }, t('level.info')), seg, desc, cats)]
}

async function profile() {
  const p = S.me
  const name = h('input', { type: 'text', value: p.name, maxLength: 24 })
  const birth = h('input', { type: 'number', inputMode: 'numeric', min: 1900, max: new Date().getFullYear() - 5, placeholder: '—', value: p.birth_year ?? '' })
  const uname = h('input', { type: 'text', autocomplete: 'username', autocapitalize: 'none', maxLength: 24 })
  const pass = h('input', { type: 'password', autocomplete: 'new-password' })
  const uiLang = h('div', { class: 'seg', role: 'group' }, languages().map((l) => h('button', { 'aria-pressed': String(l === getLang()), onclick: () => {
    store.set('rp.lang', l); setLang(l); api('PATCH', '/api/me', { lang: l }).catch(() => {}); route() } }, dict[l]['lang.name'])))
  const transfer = h('div', { class: 'stack' })
  const contacts = S.contacts.length
    ? h('div', { class: 'list' }, S.contacts.map((c) => h('div', { class: 'item' }, avatar(c), h('div', { class: 'grow ell' }, c.name),
      h('button', { class: 'btn small', onclick: guard(async () => { const r = await api('POST', '/api/games', { opponent: c.public_id, lang: gameLang() }); go('#/game/' + r.id) }) }, t('profile.challenge')),
      h('button', { class: 'btn small danger', 'aria-label': t('profile.remove'), onclick: guard(async () => { await api('DELETE', '/api/contacts/' + c.public_id); S.contacts = S.contacts.filter((x) => x.public_id !== c.public_id); setLocalContacts(S.contacts); route() }) }, '✕'))))
    : h('div', { class: 'empty' }, t('new.noContacts'))
  const account = p.has_account
    ? h('div', { class: 'stack' }, h('div', {}, t('profile.loggedInAs', { name: p.username })),
        h('button', { class: 'btn block', onclick: guard(async () => { await disablePush().catch(() => {}); await api('POST', '/api/logout', {}); forgetIdentity(); go('#/') }) }, t('profile.logout')))
    : h('div', { class: 'stack' }, h('p', { class: 'muted' }, t('profile.accountInfo')),
        h('label', { class: 'field' }, t('profile.username'), uname), h('label', { class: 'field' }, t('profile.password'), pass),
        h('button', { class: 'btn primary block', onclick: guard(async () => { await api('POST', '/api/account', { username: uname.value, password: pass.value }); await refreshMe(); toast(t('profile.saved')); route() }) }, t('profile.createAccount')),
        h('details', {}, h('summary', { class: 'muted' }, t('profile.haveAccount')),
          h('div', { class: 'stack' }, h('button', { class: 'btn block', onclick: guard(async () => {
            const r = await api('POST', '/api/login', { username: uname.value, password: pass.value }, { auth: false }); await adoptToken(r.token) }) }, t('profile.login')))))

  mount(topbar(t('profile.title')),
    h('div', { class: 'card stack' },
      h('div', { class: 'row' }, avatar(p), h('div', { class: 'grow' }, h('label', { class: 'field' }, t('profile.name'), name))),
      h('label', { class: 'field' }, t('profile.birthYear'), birth), h('p', { class: 'hint' }, t('profile.birthHint')),
      h('button', { class: 'btn block', onclick: guard(async () => { const r = await api('PATCH', '/api/me', { name: name.value, birth_year: birth.value ? Number(birth.value) : null }); await refreshMe(); toast(t(r.lb_follow_lost ? 'lb.followLost' : 'profile.saved')) }) }, t('profile.save')),
      h('label', { class: 'field' }, t('profile.uiLang'), uiLang)),
    S.meta?.reports !== false ? h('label', { class: 'row' }, h('input', { type: 'checkbox', checked: store.get('rp.noReport') !== '1',
      onchange: (e) => { e.target.checked ? store.del('rp.noReport') : store.set('rp.noReport', '1') } }), h('span', { class: 'hint' }, t('profile.reportBtn'))) : null,
    p.reviewer ? h('p', { class: 'hint' }, t('profile.reviewer')) : null,
    levelCard(),
    h('h2', {}, t('profile.code')),
    h('div', { class: 'card stack' }, h('div', { class: 'code' }, p.public_id), h('button', { class: 'btn block', onclick: () => share(inviteUrl(), t('app.name')) }, '🔗 ' + t('profile.share'))),
    h('h2', {}, t('profile.contacts')), contacts,
    h('button', { class: 'btn block', onclick: () => go('#/friends') }, '＋ ' + t('friends.addFriend')),
    h('p', { class: 'hint' }, t('friends.localNote')),
    h('h2', {}, t('push.title')), h('div', { class: 'card' }, pushCard()),
    h('h2', {}, t('privacy.title')),
    h('div', { class: 'card stack' }, h('p', { class: 'muted' }, S.consent?.at ? t('privacy.accepted', { date: new Date(S.consent.at).toLocaleDateString(getLang()), v: String(S.consent.accepted).slice(0, 8) }) : t('privacy.none')),
      h('a', { class: 'btn block', href: '/legal.html' }, t('privacy.read')),
      h('button', { class: 'btn block danger', onclick: guard(async () => {
        if (!confirm(t('privacy.revokeConfirm'))) return
        await api('DELETE', '/api/me'); await disablePush().catch(() => {}); forgetIdentity(); go('#/') }) }, t('privacy.revoke'))),
    h('h2', {}, t('profile.account')), h('div', { class: 'card' }, account),
    h('h2', {}, t('profile.move')),
    h('div', { class: 'card stack' }, h('p', { class: 'muted' }, t('profile.moveInfo')),
      h('button', { class: 'btn block', onclick: guard(downloadProfile) }, '⬇ ' + t('profile.export')),
      h('button', { class: 'btn block', onclick: guard(async () => {
        const r = await api('POST', '/api/transfer', {})
        transfer.replaceChildren(h('div', { class: 'code' }, r.code.slice(0, 4) + '-' + r.code.slice(4)), h('p', { class: 'hint' }, t('profile.transferValid'))) }) }, t('profile.transferMake')), transfer,
      importControls()),
    h('h2', {}, t('profile.more')),
    h('div', { class: 'list' },
      linkItem(t('profile.contribute'), '#/contribute'), linkItem(t('profile.licenses'), '#/licenses'),
      h('a', { class: 'item', href: '/api/dataset.jsonl', download: 'ratespass-questions.jsonl' }, h('div', { class: 'grow' }, t('profile.dataset'))),
      h('a', { class: 'item', href: '/legal.html' }, h('div', { class: 'grow' }, t('profile.legal')))),
    h('div', {}, h('button', { class: 'btn block danger', onclick: guard(async () => {
      if (!confirm(t('profile.deleteConfirm'))) return
      await api('DELETE', '/api/me'); await disablePush().catch(() => {}); forgetIdentity(); go('#/') }) }, t('profile.delete'))))
}
const linkItem = (label, hash) => h('button', { class: 'item', onclick: () => go(hash) }, h('div', { class: 'grow' }, label), '›')

async function downloadProfile() {
  const data = await api('GET', '/api/export')
  const a = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' })), download: `ratespass-${S.me.public_id}.json` })
  document.body.append(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(a.href), 10000)
}

/* ---------- Freunde hinzufügen: QR / Code / Scan ---------- */
async function renderQr(text) {
  await loadScript('/vendor/qrcode.js')
  const qr = window.qrcode(0, 'M')
  qr.addData(text); qr.make()
  const n = qr.getModuleCount(), quiet = 4, cell = 8, px = (n + quiet * 2) * cell
  const canvas = h('canvas', { width: px, height: px, role: 'img', 'aria-label': 'QR' })
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, px, px)
  ctx.fillStyle = '#111'
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) ctx.fillRect((c + quiet) * cell, (r + quiet) * cell, cell, cell)
  return canvas
}

async function startScan(video, onCode) {
  await loadScript('/vendor/jsQR.js')
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
  video.setAttribute('playsinline', '')
  video.muted = true
  video.srcObject = stream
  await video.play()
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  let stopped = false, last = 0
  const stop = () => { stopped = true; stream.getTracks().forEach((tr) => tr.stop()); video.srcObject = null }
  const loop = (ts) => {
    if (stopped) return
    if (ts - last > 120 && video.videoWidth) {
      last = ts
      const k = Math.min(1, 480 / video.videoWidth)
      canvas.width = Math.round(video.videoWidth * k); canvas.height = Math.round(video.videoHeight * k)
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
      const hit = window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' })
      if (hit && parseCode(hit.data)) { stop(); onCode(hit.data); return }
    }
    requestAnimationFrame(loop)
  }
  requestAnimationFrame(loop)
  return stop
}

async function friends() {
  let stopScan = () => {}
  const prev = cleanup
  cleanup = () => { prev(); stopScan() }
  const result = h('div', { class: 'stack' })
  const body = h('div', { class: 'stack' })
  const tabs = h('div', { class: 'seg', role: 'tablist' })

  const lookup = guard(async (raw) => {
    const code = parseCode(raw)
    if (!code) return toast(t('friends.notFound'))
    if (code === S.me.public_id) return toast(t('friends.self'))
    let who
    try { who = await api('GET', '/api/players/' + code, undefined, { auth: false }) } catch (e) { if (e.status === 404) return toast(t('friends.notFound')); throw e }
    const known = () => S.contacts.some((c) => c.public_id === who.public_id)
    const draw = () => result.replaceChildren(h('div', { class: 'card stack fade' },
      h('div', { class: 'row' }, avatar(who), h('div', { class: 'grow' }, h('strong', {}, who.name), h('div', { class: 'muted' }, known() ? t('friends.already') : t('friends.found')))),
      known() ? null : h('button', { class: 'btn block', onclick: guard(async () => { await api('POST', '/api/contacts', { public_id: who.public_id }); await refreshMe(); toast(t('friends.added', { name: who.name })); draw() }) }, t('friends.add')),
      h('button', { class: 'btn primary block', onclick: guard(async () => {
        if (!known()) { await api('POST', '/api/contacts', { public_id: who.public_id }); await refreshMe() }
        const r = await api('POST', '/api/games', { opponent: who.public_id, lang: gameLang() }); go('#/game/' + r.id) }) }, known() ? t('friends.challenge') : t('friends.addPlay'))))
    draw()
  })

  async function show(tab) {
    stopScan(); stopScan = () => {}
    store.set('rp.friendsTab', tab)
    for (const b of tabs.children) b.setAttribute('aria-pressed', String(b.dataset.tab === tab))
    result.replaceChildren()
    if (tab === 'mine') {
      const holder = h('div', { class: 'qr' }, h('div', { class: 'spinner' }))
      body.replaceChildren(holder, h('p', { class: 'hint' }, t('friends.qrHint')), h('div', { class: 'code' }, S.me.public_id),
        h('button', { class: 'btn primary block', onclick: () => share(inviteUrl(), t('app.name')) }, '🔗 ' + t('profile.share')),
        h('button', { class: 'btn block', onclick: guard(async () => { await navigator.clipboard.writeText(S.me.public_id); toast(t('friends.codeCopied')) }) }, t('friends.copyCode')))
      try { holder.replaceChildren(await renderQr(inviteUrl())) } catch { holder.replaceChildren(h('p', { class: 'hint' }, inviteUrl())) }
    } else if (tab === 'enter') {
      const input = h('input', { type: 'text', placeholder: t('friends.placeholder'), autocomplete: 'off', autocapitalize: 'characters', spellcheck: false, 'aria-label': t('friends.enter') })
      const go1 = () => lookup(input.value)
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go1() })
      input.addEventListener('input', () => { if (parseCode(input.value)) go1() })
      body.replaceChildren(h('div', { class: 'row' }, input, h('button', { class: 'btn', onclick: go1 }, t('friends.lookup'))))
      input.focus()
    } else {
      const video = h('video', { 'aria-label': t('friends.scan') })
      const note = h('p', { class: 'hint' }, t('friends.camHint'))
      const start = h('button', { class: 'btn primary block', onclick: async () => {
        start.disabled = true
        try {
          stopScan = await startScan(video, (text) => { video.parentElement.classList.remove('live'); start.hidden = false; start.disabled = false; lookup(text) })
          video.parentElement.classList.add('live'); start.hidden = true
        } catch (e) { console.warn(e); note.textContent = t('friends.noCamera'); start.disabled = false }
      } }, t('friends.camStart'))
      body.replaceChildren(h('div', { class: 'scanbox' }, video), note, start)
    }
  }
  for (const [tab, label] of [['mine', t('friends.mine')], ['enter', t('friends.enter')], ['scan', t('friends.scan')]]) {
    tabs.append(h('button', { 'data-tab': tab, role: 'tab', 'aria-pressed': 'false', onclick: () => show(tab) }, label))
  }
  mount(topbar(t('friends.title')), h('div', { class: 'card stack' }, tabs, body), result, h('p', { class: 'hint' }, t('friends.localNote')))
  await show(store.get('rp.friendsTab') || 'mine')
}

/* ---------- Einladung ---------- */
async function invite(code) {
  let who
  try { who = await api('GET', '/api/players/' + encodeURIComponent(code), undefined, { auth: false }) } catch { who = null }
  if (!who) return mount(topbar(t('app.name'), false), h('div', { class: 'empty' }, t('invite.unknown'), h('p', {}, h('button', { class: 'btn', onclick: () => go('#/') }, t('back')))))
  mount(topbar(t('app.name'), false), h('div', { class: 'card stack' }, h('div', { class: 'row' }, avatar(who), h('h3', {}, t('invite.title', { name: who.name }))),
    who.public_id === S.me.public_id ? null : h('button', { class: 'btn primary block', onclick: guard(async () => {
      await api('POST', '/api/contacts', { public_id: who.public_id }); await refreshMe()
      const r = await api('POST', '/api/games', { opponent: who.public_id, lang: gameLang() }); go('#/game/' + r.id) }) }, t('invite.accept'))))
}

/* ---------- Frage einreichen ---------- */
async function contribute() {
  const cats = S.meta.categories
  const f = {
    lang: h('select', {}, [...new Set([...(S.meta.langs ?? []).map((l) => l.lang), 'de', 'en'])].map((l) => h('option', { value: l, selected: l === getLang() }, langName(l)))),
    category: h('select', {}, cats.map((c) => h('option', { value: c }, t('cat.' + c)))),
    difficulty: h('select', {}, [1, 2, 3].map((d) => h('option', { value: d, selected: d === 2 }, t('contrib.d' + d)))),
    text: h('textarea', { maxLength: 300 }), correct: h('input', { type: 'text', maxLength: 80 }),
    wrong: [1, 2, 3].map(() => h('input', { type: 'text', maxLength: 80 })), explanation: h('input', { type: 'text', maxLength: 300 }),
    ack: h('input', { type: 'checkbox' }),
  }
  const mine = h('div', { class: 'list' })
  const loadMine = async () => {
    const r = await api('GET', '/api/submissions')
    mine.replaceChildren(...r.submissions.map((s) => h('div', { class: 'item' }, h('div', { class: 'grow ell' }, s.text), h('span', { class: 'badge ' + (s.status === 'active' ? 'good' : s.status === 'rejected' ? 'bad' : '') }, t('status.' + s.status)))))
  }
  const field = (label, el) => h('label', { class: 'field' }, label, el)
  mount(topbar(t('contrib.title')),
    h('div', { class: 'card stack' }, h('p', { class: 'muted' }, t('contrib.info')),
      field(t('contrib.lang'), f.lang), field(t('contrib.category'), f.category), field(t('contrib.difficulty'), f.difficulty),
      field(t('contrib.text'), f.text), field(t('contrib.correct'), f.correct), f.wrong.map((w, i) => field(t('contrib.wrong', { n: i + 1 }), w)),
      field(t('contrib.explanation'), f.explanation),
      h('label', { class: 'row' }, f.ack, h('span', { class: 'hint' }, t('contrib.ack'))),
      h('button', { class: 'btn primary block', onclick: guard(async () => {
        await api('POST', '/api/submissions', { lang: f.lang.value, category: f.category.value, difficulty: Number(f.difficulty.value), text: f.text.value, correct: f.correct.value,
          wrong: f.wrong.map((w) => w.value), explanation: f.explanation.value || undefined, license_ack: f.ack.checked })
        toast(t('contrib.thanks')); f.text.value = f.correct.value = f.explanation.value = ''; f.wrong.forEach((w) => (w.value = '')); await loadMine() }) }, t('contrib.send'))),
    h('h2', {}, t('contrib.mine')), mine)
  await guard(loadMine)()
}

/* ---------- Lizenzen ---------- */
async function licenses() {
  const r = await api('GET', '/api/licenses', undefined, { auth: false })
  mount(topbar(t('lic.title')), h('div', { class: 'card stack' }, h('p', { class: 'muted' }, t('lic.intro')),
    r.sources.map((s) => h('div', { class: 'row' }, h('div', { class: 'grow' }, h('strong', {}, t('src.' + s.source)),
      h('div', { class: 'muted' }, s.attribution || ''), h('a', { href: s.license_url, target: '_blank', rel: 'noopener' }, s.license)), h('span', { class: 'badge' }, t('lic.count', { n: s.n }))))),
  h('p', { class: 'hint' }, 'Open Trivia DB: https://opentdb.com · Wikidata: https://www.wikidata.org'))
}

/* ---------- Push-Benachrichtigungen ---------- */
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
const keyBytes = (b64) => Uint8Array.from(atob(b64.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
const sameBytes = (a, b) => !!a && a.byteLength === b.byteLength && new Uint8Array(a).every((v, i) => v === b[i])

async function pushStatus() {
  if (!pushSupported()) return 'unsupported'
  if (Notification.permission === 'denied') return 'denied'
  const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription()
  return sub && Notification.permission === 'granted' ? 'on' : 'off'
}
async function enablePush() {
  if ((await Notification.requestPermission()) !== 'granted') throw new ApiError(0, 'denied')
  const { key } = await api('GET', '/api/push/key', undefined, { auth: false })
  const appKey = keyBytes(key)
  const reg = await navigator.serviceWorker.ready
  let sub = await reg.pushManager.getSubscription()
  if (sub && !sameBytes(sub.options.applicationServerKey, appKey)) { await sub.unsubscribe(); sub = null }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: appKey })
  await api('POST', '/api/push/subscribe', sub.toJSON())
}
async function disablePush() {
  if (!pushSupported()) return
  const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription()
  if (!sub) return
  await api('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {})
  await sub.unsubscribe()
}
/** Bindet ein bestehendes Geräte-Abo an die aktuelle Identität (nach Login, Transfer oder Neustart des Servers);
 *  hat der Server einen neuen VAPID-Schlüssel (z. B. nach Datenverlust), wird automatisch neu abonniert. */
async function resyncPush() {
  if (!pushSupported() || Notification.permission !== 'granted') return
  const reg = await navigator.serviceWorker.ready
  let sub = await reg.pushManager.getSubscription()
  if (!sub) return
  try {
    const appKey = keyBytes((await api('GET', '/api/push/key', undefined, { auth: false })).key)
    if (!sameBytes(sub.options.applicationServerKey, appKey)) {
      await sub.unsubscribe()
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: appKey })
    }
    await api('POST', '/api/push/subscribe', sub.toJSON())
  } catch { /* nächster Start versucht es erneut */ }
}

function pushCard() {
  const box = h('div', { class: 'stack' })
  const draw = async () => {
    const st = await pushStatus()
    const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.matchMedia('(display-mode: standalone)').matches
    box.replaceChildren(...[h('p', { class: 'muted' }, t('push.info')),
      st === 'unsupported' || ios && st !== 'on' ? h('p', { class: 'hint' }, ios ? t('push.iosHint') : t('push.unsupported')) : null,
      st === 'denied' ? h('p', { class: 'hint' }, t('push.denied')) : null,
      st === 'on' ? h('div', { class: 'row' }, h('span', { class: 'badge good' }, t('push.on'))) : null,
      st === 'off' ? h('button', { class: 'btn primary block', onclick: guard(async () => { await enablePush(); toast(t('profile.saved')); draw() }) }, '🔔 ' + t('push.enable')) : null,
      st === 'on' ? h('div', { class: 'row' },
        h('button', { class: 'btn grow', onclick: guard(async () => { const r = await api('POST', '/api/push/test', {}); toast(r.sent ? t('push.sent') : t('push.noneSent')) }) }, t('push.test')),
        h('button', { class: 'btn grow', onclick: guard(async () => { await disablePush(); draw() }) }, t('push.disable'))) : null].filter(Boolean))
  }
  draw().catch(() => {})
  return box
}

/* ---------- Start ---------- */
setLang(detectLang())
if (location.pathname.startsWith('/i/')) {
  const code = location.pathname.split('/')[2]
  history.replaceState(null, '', '/#/invite/' + code)
}
if ('serviceWorker' in navigator) {
  // Neue Version: Eine installierte App bleibt oft tagelang im Speicher und würde sonst den alten Code behalten. Wird ein neuer Service Worker aktiv,
  // lädt die App beim nächsten Seitenwechsel (bzw. sofort, wenn sie gerade im Hintergrund ist) neu; beim Zurückkehren in die App wird nach Updates gesucht.
  const hadController = !!navigator.serviceWorker.controller
  navigator.serviceWorker.register('/sw.js').then((reg) => {
    document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}) })
  }).catch(() => {})
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) return // Erstinstallation
    updateReady = true
    if (document.hidden) location.reload()
  })
  // Der Service Worker meldet Pushes, während die App sichtbar ist: Ansicht aktualisieren statt Benachrichtigung zeigen.
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type !== 'push-refresh') return
    const page = (location.hash.slice(1).split('/')[1] ?? '')
    if (page === '' || page === 'game') route()
  })
}
route()
