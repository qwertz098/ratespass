/* Demo-Server im Browser: bildet die API von Ratespaß nach (Spielregeln wie in server/game.ts, Bot als Gegner). */
const DEMO = (() => {
  const CATS = ['general', 'geography', 'history', 'science', 'nature', 'sports', 'film_tv', 'music', 'literature', 'art', 'games', 'tech']
  const TIERS = { scifi_fantasy: 'nerd', coding: 'nerd', anime: 'nerd', retro_games: 'nerd' } // alle anderen: basic
  const ALL_CATS = [...CATS, ...Object.keys(TIERS)]
  const SKILL = { 1: 0.85, 2: 0.65, 3: 0.45 }
  const LIMIT = 20000
  const rnd = (n) => Math.floor(Math.random() * n)
  const shuffle = (a) => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = rnd(i + 1); [a[i], a[j]] = [a[j], a[i]] } return a }
  const code = () => Array.from({ length: 8 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[rnd(32)]).join('')
  const KEY = 'rp.demo.state'
  const NAMES = ['Lena', 'Noah', 'Emma', 'Ben', 'Sofia', 'Luca', 'Mila', 'Paul']

  let st
  try { st = JSON.parse(localStorage.getItem(KEY)) } catch { st = null }
  if (!st || st.v !== 1) st = {
    v: 1, seq: 0, games: [],
    me: { public_id: code(), name: 'Gast-' + (1000 + rnd(9000)), lang: 'de', created_at: Date.now() },
    contacts: [{ public_id: 'MIA3F7HJ', name: 'Mia' }, { public_id: 'JON9X2KP', name: 'Jonas' }],
    subs: [],
  }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(st)) } catch { /* ignorieren */ } }

  const pool = (lang) => QS.filter((q) => q[lang] && (q.r === 0 || lang === 'de'))
  const content = (q, lang) => ({ text: q[lang][0], answers: q[lang].slice(1) })
  const profile = () => ({ ...st.me, has_account: false, username: null, reviewer: true, tiers: ['basic', ...(st.tiers ?? [])] })
  const err = (status, error, message) => ({ status, body: { error, message } })

  const used = (g) => new Set(g.rounds.flatMap((r) => r.qs.map((x) => x.i)))
  function categoryOptions(g) {
    const u = used(g), p = pool(g.lang)
    const open = ALL_CATS.filter((c) => !TIERS[c] || (st.tiers ?? []).includes(TIERS[c]))
    let ok = open.filter((c) => p.filter((q) => q.c === c && !u.has(q.i)).length >= 3)
    if (!ok.length) ok = open.filter((c) => p.filter((q) => q.c === c).length >= 3)
    const sp = shuffle(ok.filter((c) => TIERS[c]))[0] // eine freigeschaltete Nerd-Kategorie wird immer mit angeboten
    return shuffle([...(sp ? [sp] : []), ...shuffle(ok.filter((c) => c !== sp))].slice(0, 3))
  }
  function selectQuestions(g, cat) {
    const u = used(g), p = pool(g.lang).filter((q) => q.c === cat)
    const fresh = p.filter((q) => !u.has(q.i))
    const cands = fresh.length >= 3 ? fresh : p
    const picked = []
    for (const d of shuffle([1, 2, 3])) { const q = shuffle(cands.filter((x) => x.d === d && !picked.includes(x)))[0]; if (q) picked.push(q) }
    for (const q of shuffle(cands)) if (picked.length < 3 && !picked.includes(q)) picked.push(q)
    return picked.slice(0, 3).sort((a, b) => a.d - b.d).map((q) => ({ i: q.i, perm: shuffle([0, 1, 2, 3]), served: null }))
  }
  function startRound(g, n, picker) {
    g.round = n; g.phase = 'pick'; g.turn = picker
    g.rounds.push({ n, picker, category: null, options: categoryOptions(g), qs: [], me: [null, null, null], opp: [null, null, null] })
    settle(g)
  }
  const cur = (g) => g.rounds[g.round - 1]
  function pick(g, cat) {
    const r = cur(g)
    r.category = cat; r.qs = selectQuestions(g, cat); g.phase = 'play'
  }
  function finish(g, reason) {
    g.status = 'finished'; g.turn = null; g.phase = 'play'; g.end_reason = reason
    const s = score(g, true)
    g.winner = s.me === s.opp ? 'draw' : s.me > s.opp ? 'me' : 'opp'
  }
  function endTurn(g, who) {
    const r = cur(g)
    if (who === r.picker) { g.turn = who === 'me' ? 'opp' : 'me'; g.phase = 'play' }
    else if (g.round >= 6) finish(g, 'completed')
    else startRound(g, g.round + 1, who)
  }
  /** Der Bot ist sofort am Zug und spielt, bis ein Mensch dran ist. */
  function settle(g) {
    while (g.status === 'active' && g.turn === 'opp') {
      const r = cur(g)
      if (g.phase === 'pick') { pick(g, shuffle(r.options)[0]); continue }
      for (let i = 0; i < 3; i++) if (r.opp[i] === null) r.opp[i] = Math.random() < SKILL[QS[r.qs[i].i].d]
      endTurn(g, 'opp')
    }
    g.updated_at = Date.now()
  }
  function score(g, all) {
    let me = 0, opp = 0
    for (const r of g.rounds) for (let i = 0; i < 3; i++) {
      if (r.me[i]) me++
      if (r.opp[i] && (all || r.me[i] !== null)) opp++
    }
    return { me, opp }
  }
  const pinfo = (g) => ({ me: { id: 1, name: st.me.name, public_id: st.me.public_id, is_bot: false }, opp: g.opp })
  function view(g) {
    const done = g.status === 'finished'
    const myTurn = g.turn === 'me'
    return {
      id: g.id, status: g.status, lang: g.lang, round: g.round, rounds_total: 6, phase: g.phase, turn: g.turn,
      ...pinfo(g),
      options: myTurn && g.phase === 'pick' ? cur(g).options : null,
      rounds: g.rounds.map((r) => ({ n: r.n, category: r.category, picker: r.picker, me: r.me.slice(),
        opp: r.opp.map((v, i) => (done || r.me[i] !== null ? v : null)) })),
      score: score(g, done), winner: done ? g.winner : null, end_reason: g.end_reason ?? null,
      created_at: g.created_at, updated_at: g.updated_at,
    }
  }
  const find = (id) => st.games.find((g) => g.id === Number(id))

  function newGame(opponent, lang) {
    let name = 'Robo', pid = 'BOT00000', bot = true
    if (opponent === 'random') { name = NAMES[rnd(NAMES.length)]; pid = code() }
    else if (opponent !== 'bot') { const c = st.contacts.find((x) => x.public_id === opponent); if (!c) return err(404, 'unknown_player'); name = c.name; pid = c.public_id }
    const g = { id: ++st.seq, lang, status: 'active', round: 0, phase: 'pick', turn: 'me', rounds: [], opp: { id: 2, name, public_id: pid, is_bot: bot && opponent === 'bot' },
      created_at: Date.now(), updated_at: Date.now() }
    st.games.unshift(g)
    startRound(g, 1, 'me')
    return { body: { id: g.id } }
  }

  function needMyTurn(g, play) {
    if (!g) return err(404, 'not_found')
    if (g.status !== 'active' || g.turn !== 'me' || (play && g.phase !== 'play')) return err(409, 'not_your_turn')
    return null
  }
  function handle(method, path, body) {
    let m
    if (path === '/api/meta') return { body: { categories: ALL_CATS, tiers: Object.fromEntries(ALL_CATS.map((c) => [c, TIERS[c] ?? 'basic'])), regions: ['global', 'dach'], reports: true, langs: [{ lang: 'de', n: pool('de').length }, { lang: 'en', n: pool('en').length }], time_limit_ms: LIMIT, rounds: 6, per_round: 3 } }
    if (path === '/api/players' && method === 'POST') { if (body?.name) st.me.name = String(body.name).slice(0, 24); if (body?.lang) st.me.lang = body.lang; save(); return { body: { token: 'demo-token', player: profile() } } }
    if (path === '/api/unlock' && method === 'POST') { // Demo: Code NERD schaltet die Nerd-Kategorien frei
      if (String(body?.code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '') !== 'NERD') return err(404, 'bad_unlock_code')
      st.tiers = [...new Set([...(st.tiers ?? []), 'nerd'])]; save(); return { body: { tier: 'nerd', tiers: ['basic', ...st.tiers] } }
    }
    if (path === '/api/me' && method === 'GET') return { body: { player: profile(), contacts: st.contacts } }
    if (path === '/api/me' && method === 'PATCH') {
      if (body.name !== undefined) { const n = String(body.name).trim(); if (n.length < 2 || n.length > 24) return err(400, 'bad_name'); st.me.name = n }
      if (body.lang) st.me.lang = body.lang
      save(); return { body: { player: profile() } }
    }
    if (path === '/api/licenses') return { body: { sources: [{ source: 'original', license: 'CC-BY-SA-4.0', attribution: 'Ratespaß-Projekt (eigene Formulierungen, Faktenwissen)', n: QS.length, license_url: 'https://creativecommons.org/licenses/by-sa/4.0/' }], licenses: { 'CC-BY-SA-4.0': 'https://creativecommons.org/licenses/by-sa/4.0/' } } }
    if (path === '/api/contacts' && method === 'POST') {
      const id = String(body.public_id || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
      if (id.length !== 8) return err(404, 'unknown_player')
      if (!st.contacts.some((c) => c.public_id === id)) st.contacts.push({ public_id: id, name: 'Freund ' + id.slice(0, 4) })
      save(); return { body: { ok: true } }
    }
    if ((m = path.match(/^\/api\/contacts\/(\w+)$/)) && method === 'DELETE') { st.contacts = st.contacts.filter((c) => c.public_id !== m[1]); save(); return { body: { ok: true } } }
    if ((m = path.match(/^\/api\/players\/(\w+)$/))) {
      const id = m[1].toUpperCase().replace(/[^A-Z0-9]/g, '')
      if (id.length !== 8) return err(404, 'unknown_player')
      const c = st.contacts.find((x) => x.public_id === id)
      return { body: { public_id: id, name: c ? c.name : 'Freund ' + id.slice(0, 4) } }
    }
    if (path === '/api/transfer' && method === 'POST') return { body: { code: code(), expires_at: Date.now() + 600000 } }
    if (path === '/api/export') return { body: { format: 'ratespass-profile', version: 1, token: 'demo-token', player: profile(), contacts: st.contacts } }
    if (path === '/api/submissions' && method === 'GET') return { body: { submissions: st.subs } }
    if (path === '/api/submissions' && method === 'POST') {
      if (body.license_ack !== true) return err(400, 'license_ack_required')
      if (String(body.text || '').trim().length < 8) return err(400, 'invalid_question', 'Fragetext 8–300 Zeichen')
      st.subs.unshift({ id: Date.now(), lang: body.lang, category: body.category, text: body.text, status: 'pending', created_at: Date.now() }); save(); return { body: { ok: true } }
    }
    if (path === '/api/login' || path === '/api/account') return err(400, 'generic', 'In der Demo nicht verfügbar')
    if (path === '/api/logout') return { body: { ok: true } }
    if (path.startsWith('/api/push/')) return err(400, 'bad_subscription')
    if (path === '/api/games' && method === 'GET') {
      return { body: { games: st.games.map((g) => { const v = view(g); return { id: v.id, status: v.status, lang: v.lang, round: v.round, turn: v.turn, phase: v.phase, opp: v.opp, score: v.score, winner: v.winner, updated_at: v.updated_at } }) } }
    }
    if (path === '/api/games' && method === 'POST') return newGame(String(body.opponent || 'bot'), body.lang === 'en' ? 'en' : 'de')
    if ((m = path.match(/^\/api\/games\/(\d+)(?:\/(\w+))?$/))) {
      const g = find(m[1]), act = m[2]
      if (!g) return err(404, 'not_found')
      if (!act) return { body: { game: view(g) } }
      if (act === 'pick') {
        const e = needMyTurn(g, false); if (e) return e
        if (g.phase !== 'pick' || !cur(g).options.includes(body.category)) return err(400, 'bad_category')
        pick(g, body.category); save(); return { body: { game: view(g) } }
      }
      if (act === 'question') {
        const e = needMyTurn(g, true); if (e) return e
        const r = cur(g), idx = r.me.filter((v) => v !== null).length, x = r.qs[idx]
        if (!x.served) x.served = Date.now()
        const c = content(QS[x.i], g.lang)
        return { body: { idx, total: 3, round: g.round, category: r.category, text: c.text, options: x.perm.map((k) => c.answers[k]), limit_ms: LIMIT, remaining_ms: Math.max(0, LIMIT - (Date.now() - x.served)) } }
      }
      if (act === 'answer') {
        const e = needMyTurn(g, true); if (e) return e
        const r = cur(g), idx = r.me.filter((v) => v !== null).length
        if (body.idx !== idx) return err(409, 'wrong_question')
        const x = r.qs[idx], correctIdx = x.perm.indexOf(0)
        const choice = Date.now() - x.served > LIMIT + 4000 ? -1 : body.choice
        r.me[idx] = choice === correctIdx
        if (idx === 2) endTurn(g, 'me')
        settle(g); save()
        return { body: { correct: choice === correctIdx, correct_index: correctIdx, explanation: null, game: view(g) } }
      }
      if (act === 'resign') { if (g.status === 'active') { finish(g, 'resigned'); g.winner = 'opp' } save(); return { body: { game: view(g) } } }
      if (act === 'bot') return { body: { game: view(g) } }
      if (act === 'report' || act === 'review') return { body: { ok: true } }
    }
    return err(404, 'not_found')
  }

  const realFetch = window.fetch.bind(window)
  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href)
    if (!url.pathname.startsWith('/api/')) return realFetch(input, init)
    let body
    try { body = init.body ? JSON.parse(init.body) : {} } catch { body = {} }
    await new Promise((r) => setTimeout(r, 60))
    const res = handle((init.method || 'GET').toUpperCase(), url.pathname, body)
    return new Response(JSON.stringify(res.body), { status: res.status || 200, headers: { 'content-type': 'application/json' } })
  }
  return { reset: () => { try { localStorage.removeItem(KEY) } catch { /* ignorieren */ } location.reload() } }
})()
