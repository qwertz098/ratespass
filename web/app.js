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

function mount(...nodes) {
  $app.replaceChildren(h('div', { class: 'fade' }, ...nodes))
  window.scrollTo(0, 0)
}
const loading = () => $app.replaceChildren(h('div', { class: 'spinner', 'aria-label': t('loading') }))

function poll(fn, ms) {
  const id = setInterval(() => { if (!document.hidden) fn() }, ms)
  const onVis = () => { if (!document.hidden) fn() }
  document.addEventListener('visibilitychange', onVis)
  const prev = cleanup
  cleanup = () => { prev(); clearInterval(id); document.removeEventListener('visibilitychange', onVis) }
}

async function route() {
  cleanup(); cleanup = () => {}
  const my = ++runId
  const [, page = '', arg] = (location.hash || '#/').slice(1).split('/')
  try {
    if (!S.me) { loading(); if (!(await boot())) return }
    if (my !== runId) return
    const pages = { '': home, new: newGame, game: gameView, play, profile, contribute, licenses, invite }
    await (pages[page] ?? home)(arg, my)
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
  if (!S.token) {
    const r = await api('POST', '/api/players', { lang: getLang() }, { auth: false })
    S.token = r.token; store.set('rp.token', r.token)
  }
  try { await refreshMe() } catch (e) { if (e instanceof ApiError && e.status === 401) { sessionLost(); return false } throw e }
  return true
}
async function refreshMe() {
  const r = await api('GET', '/api/me')
  S.me = r.player; S.contacts = r.contacts
}
function sessionLost() {
  S.me = null
  mount(topbar(t('session.title'), false), h('div', { class: 'card stack' },
    h('p', { class: 'muted' }, t('session.info')),
    importControls(),
    h('button', { class: 'btn block', onclick: () => { store.del('rp.token'); S.token = null; route() } }, t('session.fresh'))))
}

/* ---------- Startseite ---------- */
async function home(_, my) {
  const render = (games) => {
    if (my !== runId) return
    const mine = games.filter((g) => g.status === 'active' && g.turn === 'me')
    const theirs = games.filter((g) => g.status === 'active' && g.turn === 'opp')
    const waiting = games.filter((g) => g.status === 'waiting')
    const done = games.filter((g) => g.status === 'finished')
    const section = (title, list) => list.length ? [h('h2', {}, title), h('div', { class: 'list' }, list.map(gameItem))] : []
    mount(
      h('div', { class: 'top' }, h('h1', { class: 'brand' }, 'Rates', h('b', {}, 'paß')),
        h('button', { class: 'iconbtn', 'aria-label': t('profile.title'), onclick: () => go('#/profile') }, avatar(S.me, 'sm'))),
      h('button', { class: 'btn primary block', onclick: () => go('#/new') }, '＋ ' + t('home.new')),
      games.length ? null : h('div', { class: 'empty' }, t('home.empty')),
      section(t('home.yourTurn'), mine), section(t('home.theirTurn'), theirs), section(t('home.waiting'), waiting), section(t('home.finished'), done))
  }
  const load = guard(async () => render((await api('GET', '/api/games')).games))
  await load()
  poll(load, 10000)
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
  const langSel = h('select', { id: 'gl', onchange: (e) => store.set('rp.gameLang', e.target.value) },
    (S.meta.langs ?? []).map((l) => h('option', { value: l.lang, selected: l.lang === gameLang() }, langName(l.lang))))
  const option = (title, sub, icon, fn) => h('button', { class: 'item', onclick: fn },
    h('div', { class: 'avatar sm' }, icon), h('div', { class: 'grow' }, h('div', {}, title), h('div', { class: 'muted' }, sub)))
  mount(topbar(t('new.title')),
    h('div', { class: 'list' },
      option(t('new.random'), t('new.randomSub'), '🎲', () => start('random')),
      option(t('new.bot'), t('new.botSub'), '🤖', () => start('bot')),
      option(t('new.invite'), t('new.inviteSub'), '🔗', () => share(inviteUrl(), t('app.name')))),
    h('h2', {}, t('new.questionLang')), h('div', { class: 'card' }, langSel),
    h('h2', {}, t('new.contacts')),
    S.contacts.length
      ? h('div', { class: 'list' }, S.contacts.map((c) => h('button', { class: 'item', onclick: () => start(c.public_id) }, avatar(c), h('div', { class: 'grow' }, c.name), h('span', { class: 'badge' }, t('profile.challenge')))))
      : h('div', { class: 'empty' }, t('new.noContacts')))
}
const langName = (code) => { try { return new Intl.DisplayNames([getLang()], { type: 'language' }).of(code) } catch { return code } }

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
      onclick: guard(async () => { await api('POST', `/api/games/${id}/pick`, { category: c }); go('#/play/' + id) }) }, t('cat.' + c))))]
  if (g.turn === 'me') return [h('button', { class: 'btn primary block', onclick: () => go('#/play/' + id) }, t(g.rounds.find((r) => r.n === g.round)?.me.some((x) => x !== null) ? 'game.continue' : 'game.play'))]
  return [h('div', { class: 'row' }, avatar(g.opp, 'sm'), h('div', {}, t('game.oppTurn', { name: g.opp?.name })))]
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
      if (e.status === 409) return go('#/game/' + id)
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
        h('div', { class: 'card', cat: q.category },
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
        let r
        try { r = await api('POST', `/api/games/${id}/answer`, { idx: q.idx, choice }) } catch (e) { toast(errText(e)); return resolve({ error: true }) }
        buttons[r.correct_index]?.classList.add('good')
        if (choice >= 0 && !r.correct) buttons[choice].classList.add('bad')
        const label = choice === -1 ? t('play.timeUp') : r.correct ? t('play.right') : t('play.wrong')
        const next = h('button', { class: 'btn small', onclick: () => resolve({ r }) }, t('play.next'))
        const report = h('button', { class: 'btn small', onclick: guard(async () => {
          await api('POST', `/api/games/${id}/report`, { round: q.round, idx: q.idx, reason: '' }); report.disabled = true; toast(t('play.reported')) }), title: t('play.report'), 'aria-label': t('play.report') }, '⚑')
        feedback.append(h('strong', {}, label), h('span', { class: 'row' }, report, next))
        if (r.explanation) feedback.before(h('p', { class: 'muted' }, r.explanation))
        setTimeout(() => resolve({ r }), r.explanation ? 3500 : 1600)
      }
    })
    if (keyHandler) document.removeEventListener('keydown', keyHandler)
    if (answered.error || !alive()) return go('#/game/' + id)
    const g = answered.r.game
    if (q.idx >= q.total - 1 || g.turn !== 'me' || g.status !== 'active' || g.phase !== 'play') return go('#/game/' + id)
    await sleep(50)
  }
}

/* ---------- Profil ---------- */
function importControls() {
  const file = h('input', { type: 'file', accept: 'application/json,.json', hidden: true, onchange: guard(async (e) => {
    const f = e.target.files[0]
    if (!f) return
    let data
    try { data = JSON.parse(await f.text()) } catch { data = null }
    if (data?.format !== 'ratespass-profile' || typeof data.token !== 'string') throw new ApiError(0, 'bad_file')
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
  await refreshMe()
  toast(t('profile.saved')); go('#/')
}

async function profile() {
  const p = S.me
  const name = h('input', { type: 'text', value: p.name, maxLength: 24 })
  const uname = h('input', { type: 'text', autocomplete: 'username', autocapitalize: 'none', maxLength: 24 })
  const pass = h('input', { type: 'password', autocomplete: 'new-password' })
  const uiLang = h('div', { class: 'seg', role: 'group' }, languages().map((l) => h('button', { 'aria-pressed': String(l === getLang()), onclick: () => {
    store.set('rp.lang', l); setLang(l); api('PATCH', '/api/me', { lang: l }).catch(() => {}); route() } }, dict[l]['lang.name'])))
  const transfer = h('div', { class: 'stack' })
  const contacts = S.contacts.length
    ? h('div', { class: 'list' }, S.contacts.map((c) => h('div', { class: 'item' }, avatar(c), h('div', { class: 'grow ell' }, c.name),
      h('button', { class: 'btn small', onclick: guard(async () => { const r = await api('POST', '/api/games', { opponent: c.public_id, lang: gameLang() }); go('#/game/' + r.id) }) }, t('profile.challenge')),
      h('button', { class: 'btn small danger', 'aria-label': t('profile.remove'), onclick: guard(async () => { await api('DELETE', '/api/contacts/' + c.public_id); await refreshMe(); route() }) }, '✕'))))
    : h('div', { class: 'empty' }, t('new.noContacts'))
  const account = p.has_account
    ? h('div', { class: 'stack' }, h('div', {}, t('profile.loggedInAs', { name: p.username })),
        h('button', { class: 'btn block', onclick: guard(async () => { await api('POST', '/api/logout', {}); store.del('rp.token'); S.token = null; S.me = null; go('#/') }) }, t('profile.logout')))
    : h('div', { class: 'stack' }, h('p', { class: 'muted' }, t('profile.accountInfo')),
        h('label', { class: 'field' }, t('profile.username'), uname), h('label', { class: 'field' }, t('profile.password'), pass),
        h('button', { class: 'btn primary block', onclick: guard(async () => { await api('POST', '/api/account', { username: uname.value, password: pass.value }); await refreshMe(); toast(t('profile.saved')); route() }) }, t('profile.createAccount')),
        h('details', {}, h('summary', { class: 'muted' }, t('profile.haveAccount')),
          h('div', { class: 'stack' }, h('button', { class: 'btn block', onclick: guard(async () => {
            const r = await api('POST', '/api/login', { username: uname.value, password: pass.value }, { auth: false }); await adoptToken(r.token) }) }, t('profile.login')))))

  mount(topbar(t('profile.title')),
    h('div', { class: 'card stack' },
      h('div', { class: 'row' }, avatar(p), h('div', { class: 'grow' }, h('label', { class: 'field' }, t('profile.name'), name))),
      h('button', { class: 'btn block', onclick: guard(async () => { await api('PATCH', '/api/me', { name: name.value }); await refreshMe(); toast(t('profile.saved')) }) }, t('profile.save')),
      h('label', { class: 'field' }, t('profile.uiLang'), uiLang)),
    h('h2', {}, t('profile.code')),
    h('div', { class: 'card stack' }, h('div', { class: 'code' }, p.public_id), h('button', { class: 'btn block', onclick: () => share(inviteUrl(), t('app.name')) }, '🔗 ' + t('profile.share'))),
    h('h2', {}, t('profile.contacts')), contacts,
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
      await api('DELETE', '/api/me'); store.del('rp.token'); S.token = null; S.me = null; go('#/') }) }, t('profile.delete'))))
}
const linkItem = (label, hash) => h('button', { class: 'item', onclick: () => go(hash) }, h('div', { class: 'grow' }, label), '›')

async function downloadProfile() {
  const data = await api('GET', '/api/export')
  const a = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' })), download: `ratespass-${S.me.public_id}.json` })
  document.body.append(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(a.href), 10000)
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

/* ---------- Start ---------- */
setLang(detectLang())
if (location.pathname.startsWith('/i/')) {
  const code = location.pathname.split('/')[2]
  history.replaceState(null, '', '/#/invite/' + code)
}
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {})
route()
