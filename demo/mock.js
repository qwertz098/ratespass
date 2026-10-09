/* Demo-Server im Browser: bildet die API von Ratespaß nach (Spielregeln wie in server/game.ts, Bot als Gegner). */
const DEMO = (() => {
  const CATS = ['general', 'geography', 'history', 'science', 'nature', 'sports', 'film_tv', 'music', 'literature', 'art', 'games', 'tech']
  const TIERS = { scifi_fantasy: 'nerd', coding: 'nerd', anime: 'nerd', retro_games: 'nerd', expert_mint: 'expert', expert_humanities: 'expert', expert_arts: 'expert', expert_it: 'expert' } // alle anderen: basic
  const LEVELS = ['basic', 'nerd', 'expert']
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
  const profile = () => ({ ...st.me, has_account: false, username: null, reviewer: true, level: st.level ?? 'basic', disabled_cats: st.disabled ?? [], best_ladder: st.best ?? 0, birth_year: st.birth ?? null, lb_name: st.lb ?? null })
  const err = (status, error, message) => ({ status, body: { error, message } })

  const used = (g) => new Set(g.rounds.flatMap((r) => r.qs.map((x) => x.i)))
  function categoryOptions(g) {
    const u = used(g), p = pool(g.lang)
    const rank = LEVELS.indexOf(st.level ?? 'basic') // Demo: Bot-Gegner übernimmt deine Einstellung
    const open = ALL_CATS.filter((c) => !TIERS[c] || (LEVELS.indexOf(TIERS[c]) <= rank && !(st.disabled ?? []).includes(c)))
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
      id: g.id, status: g.status, lang: g.lang, round: g.round, rounds_total: 6, level: st.level ?? 'basic', phase: g.phase, turn: g.turn,
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
  /* ---------- Millionen-Leiter ---------- */
  const LPRIZES = [100, 200, 300, 500, 1000, 2000, 4000, 8000, 16000, 32000, 64000, 125000, 250000, 500000, 1000000]
  const llimit = (step) => (step <= 5 ? 30000 : step <= 10 ? 45000 : 60000)
  const lguar = (n) => (n >= 10 ? LPRIZES[9] : n >= 5 ? LPRIZES[4] : 0)
  function lfinish(l, status, prize) { l.status = status; l.prize = prize; st.best = Math.max(st.best ?? 0, prize); save() }
  function lanswer(l, step, choice) {
    const s = l.steps[step - 1], correctIdx = s.perm.indexOf(0), correct = choice === correctIdx
    s.choice = choice; s.correct = correct
    if (!correct) lfinish(l, 'lost', lguar(l.answered))
    else { l.answered = step; if (step >= 15) lfinish(l, 'won', LPRIZES[14]); else save() }
    return { correct, correct_index: correctIdx }
  }
  const lview = (l) => ({
    id: l.id, status: l.status, lang: l.lang, level: st.level ?? 'basic', answered: l.answered, current: l.status === 'active' ? l.answered + 1 : null,
    prizes: LPRIZES, safe_steps: [5, 10], guaranteed: l.status === 'active' ? lguar(l.answered) : null,
    banked: l.status === 'active' ? (LPRIZES[l.answered - 1] ?? 0) : null, prize: l.prize,
    history: l.steps.filter((x) => x.choice !== undefined).map((x, i) => ({ step: i + 1, correct: !!x.correct })),
  })

  /* ---------- Mehrspieler-Räume (Demo: zwei Bots sind schon beigetreten und spielen sofort durch) ---------- */
  const RQUIZ = [1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3]
  const rview = (r) => {
    const fin = r.status === 'finished'
    const rank = [...r.players].sort((a, b) => b.score - a.score || a.ms - b.ms)
    return { id: r.id, code: r.code, mode: r.mode, lang: r.lang, status: r.status, level: st.level ?? 'basic', total: r.total, is_host: true, deadline: null, max_players: 6,
      players: r.players.map((p) => ({ name: p.name, public_id: p.public_id, is_me: !!p.is_me, is_host: !!p.is_me, pos: p.pos, done: p.done, score: fin || p.is_me ? p.score : null, ms: fin || p.is_me ? p.ms : null, rank: fin ? rank.indexOf(p) + 1 : null })),
      ...(r.mode === 'ladder' ? { prizes: LPRIZES, safe_steps: [5, 10] } : {}), updated_at: r.updated_at }
  }
  function rcheck(r) { if (r.players.every((p) => p.done)) { r.status = 'finished'; save() } }
  function rstart(r) {
    const rank = LEVELS.indexOf(st.level ?? 'basic')
    const open = ALL_CATS.filter((c) => !TIERS[c] || (LEVELS.indexOf(TIERS[c]) <= rank && !(st.disabled ?? []).includes(c)))
    const diffs = r.mode === 'quiz' ? RQUIZ : LPRIZES.map((_, i) => (i < 5 ? 1 : i < 10 ? 2 : 3)), used = new Set()
    r.qs = diffs.map((d) => {
      let c = pool(r.lang).filter((q) => open.includes(q.c) && q.d === d && !used.has(q.i))
      if (!c.length) c = pool(r.lang).filter((q) => open.includes(q.c) && !used.has(q.i))
      const q = shuffle(c)[0]; used.add(q.i); return { i: q.i, perm: shuffle([0, 1, 2, 3]), served: null }
    })
    r.total = r.qs.length; r.status = 'active'
    for (const p of r.players.filter((x) => !x.is_me)) { // Bots spielen sofort durch
      p.pos = r.total; p.done = true; p.ms = 40000 + rnd(120000)
      p.score = r.mode === 'quiz' ? 4 + rnd(8) : [0, 100, 500, 1000, 4000, 16000, 32000][rnd(7)]
    }
  }
  function handle(method, path, body) {
    let m
    if (path === '/api/meta') return { body: { categories: ALL_CATS, tiers: Object.fromEntries(ALL_CATS.map((c) => [c, TIERS[c] ?? 'basic'])), levels: LEVELS, regions: ['global', 'dach'], reports: true, langs: [{ lang: 'de', n: pool('de').length }, { lang: 'en', n: pool('en').length }], time_limit_ms: LIMIT, rounds: 6, per_round: 3 } }
    if (path === '/api/privacy') {
      const doc = (l) => ({ title: l === 'de' ? 'Impressum & Datenschutz (Demo)' : 'Legal notice & privacy (demo)',
        summary: l === 'de' ? ['Demo: Alle Daten bleiben in deinem Browser (localStorage), es wird nichts an einen Server gesendet.', 'In der echten App: anonymes Profil, kein Tracking, Widerruf jederzeit.'] : ['Demo: all data stays in your browser (localStorage); nothing is sent to a server.', 'In the real app: anonymous profile, no tracking, withdrawal at any time.'],
        sections: [{ title: l === 'de' ? 'Demo' : 'Demo', paras: [l === 'de' ? 'Dies ist eine klickbare Demo ohne Server. Die echte Datenschutzerklärung wird vom Betreiber über Umgebungsvariablen konfiguriert.' : 'This is a clickable demo without a server. The real privacy policy is configured by the operator via environment variables.'] }] })
      return { body: { version: 'demo-version', de: doc('de'), en: doc('en'), missing: [] } }
    }
    if (path === '/api/consent' && method === 'POST') { st.consent = Date.now(); save(); return { body: { consent: { current: 'demo-version', accepted: 'demo-version', at: st.consent } } } }
    if (path === '/api/players' && method === 'POST') {
      if (body?.consent) st.consent = Date.now()
      if (body?.name) st.me.name = String(body.name).slice(0, 24); if (body?.lang) st.me.lang = body.lang; save(); return { body: { token: 'demo-token', player: profile() } } }
    if (path === '/api/me' && method === 'GET') return { body: { player: profile(), contacts: st.contacts, consent: { current: 'demo-version', accepted: st.consent ? 'demo-version' : null, at: st.consent ?? null } } }
    if (path === '/api/me' && method === 'PATCH') {
      if (body.name !== undefined) { const n = String(body.name).trim(); if (n.length < 2 || n.length > 24) return err(400, 'bad_name'); st.me.name = n }
      if (body.lang) st.me.lang = body.lang
      if (body.birth_year !== undefined) st.birth = body.birth_year || null
      if (body.level !== undefined) { if (!LEVELS.includes(body.level)) return err(400, 'bad_level'); st.level = body.level }
      if (body.disabled_cats !== undefined) st.disabled = body.disabled_cats.filter((c) => TIERS[c])
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
    if (path.startsWith('/api/live')) return err(501, 'demo_unavailable') // Echtzeit braucht den echten Server
    /* Bestenliste (Demo: Beispieldaten + dein eigener Stand aus der Demo) */
    if (path === '/api/leaderboard' && method === 'GET') {
      const sample = [['Quizkönig', 412, 540], ['Wissensdurst', 388, 470], ['Rätselfuchs', 351, 520], ['Nachteule', 300, 380], ['Neunmalklug', 262, 400]]
      const mine = st.lb ? { name: st.lb, ok: st.lbOk ?? 0, n: st.lbN ?? 0 } : null
      const all = [...sample.map(([name, ok, n]) => ({ name, ok, n })), ...(mine && mine.n >= 50 ? [{ ...mine, me: true }] : [])]
      all.sort((a, b) => b.ok - a.ok)
      const top = all.map((x, i) => ({ rank: i + 1, name: x.name, ok: x.ok, n: x.n, rate: Math.round((x.ok / x.n) * 1000) / 10, is_me: !!x.me }))
      return { body: { top, me: mine ? { rank: top.find((x) => x.is_me)?.rank ?? null, ok: mine.ok, n: mine.n, rate: mine.n ? Math.round((mine.ok / mine.n) * 1000) / 10 : null, needs: Math.max(0, 50 - mine.n), young: false } : null,
        total: top.length, rules: { min_answers: 50, min_relative: 100, day_cap: 400 }, participating: !!st.lb, name: st.lb ?? null, banned: false } }
    }
    if (path === '/api/leaderboard/join' && method === 'POST') { const n = String(body?.name ?? '').trim(); if (n.length < 3 || n.length > 20) return err(400, 'bad_lb_name'); st.lb = n; save(); return { body: { name: n } } }
    if (path === '/api/leaderboard/join' && method === 'DELETE') { st.lb = null; save(); return { body: { ok: true } } }
    /* Mehrspieler-Räume */
    if (path === '/api/rooms' && method === 'GET') return { body: { rooms: (st.rooms ?? []).map((r) => { const v = rview(r), me = v.players.find((p) => p.is_me); return { id: r.id, code: r.code, mode: r.mode, status: r.status, players: v.players.length, my_done: me.done, my_rank: me.rank, updated_at: r.updated_at } }) } }
    if (path === '/api/rooms' && method === 'POST') {
      st.rooms ??= []
      const r = { id: ++st.seq, code: code().slice(0, 6), mode: body.mode === 'ladder' ? 'ladder' : 'quiz', lang: body.lang === 'en' ? 'en' : 'de', status: 'lobby', total: 0, updated_at: Date.now(),
        players: [{ name: st.me.name, public_id: st.me.public_id, is_me: true, pos: 0, done: false, score: 0, ms: 0 }, { name: 'Mia', public_id: 'MIA3F7HJ', pos: 0, done: false, score: 0, ms: 0 }, { name: 'Jonas', public_id: 'JON9X2KP', pos: 0, done: false, score: 0, ms: 0 }], qs: [] }
      st.rooms.unshift(r); save(); return { body: { id: r.id, room: rview(r) } }
    }
    if (path === '/api/rooms/join' && method === 'POST') return err(404, 'unknown_room')
    if ((m = path.match(/^\/api\/rooms\/(\d+)(?:\/(\w+))?$/))) {
      const r = (st.rooms ?? []).find((x) => x.id === Number(m[1])), act = m[2], me = r && r.players.find((p) => p.is_me)
      if (!r) return err(404, 'not_found')
      if (!act) return { body: { room: rview(r) } }
      if (act === 'report' || act === 'review') return { body: { ok: true } }
      if (act === 'leave') { st.rooms = st.rooms.filter((x) => x !== r); save(); return { body: { ok: true } } }
      if (act === 'start') { if (r.status !== 'lobby') return err(409, 'room_started'); rstart(r); save(); return { body: { room: rview(r) } } }
      if (r.status !== 'active' || me.done) return err(409, 'room_over')
      const idx = me.pos, lim = r.mode === 'quiz' ? 20000 : llimit(idx + 1)
      if (act === 'quit') { if (r.mode !== 'ladder') return err(400, 'bad_mode'); me.done = true; me.score = LPRIZES[me.pos - 1] ?? 0; rcheck(r); return { body: { room: rview(r) } } }
      if (act === 'question') {
        const x = r.qs[idx]; if (!x.served) { x.served = Date.now(); save() }
        const q = QS[x.i], c = content(q, r.lang)
        return { body: { step: idx + 1, total: r.total, prize: r.mode === 'ladder' ? LPRIZES[idx] : null, category: q.c, text: c.text, options: x.perm.map((k) => c.answers[k]), limit_ms: lim, remaining_ms: Math.max(0, lim - (Date.now() - x.served)) } }
      }
      if (act === 'answer') {
        if (body.step !== idx + 1 || !r.qs[idx].served) return err(409, 'wrong_question')
        const x = r.qs[idx], correctIdx = x.perm.indexOf(0), choice = Date.now() - x.served > lim + 4000 ? -1 : body.choice, ok = choice === correctIdx
        me.pos = idx + 1; me.ms += Math.min(lim, Date.now() - x.served)
        if (r.mode === 'quiz') { if (ok) me.score++; me.done = me.pos >= r.total }
        else if (ok) { me.score = LPRIZES[idx]; me.done = me.pos >= r.total } else { me.score = lguar(idx); me.done = true }
        r.updated_at = Date.now(); rcheck(r); save()
        return { body: { correct: ok, correct_index: correctIdx, explanation: null, over: me.done, room: rview(r) } }
      }
    }
    /* Millionen-Leiter (Solo): gleiche Regeln wie server/ladder.ts */
    if (path === '/api/ladders' && method === 'POST') {
      st.ladders ??= []
      let l = st.ladders.find((x) => x.status === 'active')
      if (!l) { l = { id: ++st.seq, status: 'active', answered: 0, prize: null, lang: body.lang === 'en' ? 'en' : 'de', steps: [] }; st.ladders.push(l); save() }
      return { body: { id: l.id, ladder: lview(l) } }
    }
    if ((m = path.match(/^\/api\/ladders\/(\d+)(?:\/(\w+))?$/))) {
      const l = (st.ladders ?? []).find((x) => x.id === Number(m[1])), act = m[2]
      if (!l) return err(404, 'not_found')
      if (!act) return { body: { ladder: lview(l) } }
      if (act === 'report' || act === 'review') return { body: { ok: true } }
      if (l.status !== 'active') return err(409, 'ladder_over')
      const step = l.answered + 1
      if (act === 'quit') { lfinish(l, 'quit', LPRIZES[l.answered - 1] ?? 0); return { body: { ladder: lview(l) } } }
      if (act === 'question') {
        let s = l.steps[step - 1]
        if (!s) {
          const rank = LEVELS.indexOf(st.level ?? 'basic')
          const open = ALL_CATS.filter((c) => !TIERS[c] || (LEVELS.indexOf(TIERS[c]) <= rank && !(st.disabled ?? []).includes(c)))
          const d = step <= 5 ? 1 : step <= 10 ? 2 : 3, used = new Set(l.steps.map((x) => x.i))
          let c = pool(l.lang).filter((q) => open.includes(q.c) && q.d === d && !used.has(q.i))
          if (!c.length) c = pool(l.lang).filter((q) => open.includes(q.c) && !used.has(q.i))
          s = { i: shuffle(c)[0].i, perm: shuffle([0, 1, 2, 3]), served: Date.now() }; l.steps[step - 1] = s; save()
        }
        const lim = llimit(step)
        if (Date.now() - s.served > lim + 4000) { lanswer(l, step, -1); return err(409, 'ladder_over') }
        const q = QS[s.i], c = content(q, l.lang)
        return { body: { step, total: 15, prize: LPRIZES[step - 1], category: q.c, text: c.text, options: s.perm.map((k) => c.answers[k]), limit_ms: lim, remaining_ms: Math.max(0, lim - (Date.now() - s.served)) } }
      }
      if (act === 'answer') {
        if (body.step !== step || !l.steps[step - 1]) return err(409, 'wrong_question')
        const s = l.steps[step - 1], choice = Date.now() - s.served > llimit(step) + 4000 ? -1 : body.choice
        const res = lanswer(l, step, choice)
        return { body: { ...res, explanation: null, ladder: lview(l) } }
      }
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
        st.lbN = (st.lbN ?? 0) + 1; if (choice === correctIdx) st.lbOk = (st.lbOk ?? 0) + 1 // Demo: eigener Stand für die Bestenliste
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
