import crypto from 'node:crypto'
import { CATEGORIES, CATEGORY_TIERS, TIERS, isCategory, LICENSES, REGIONS, SERVABLE_SQL } from './categories.ts'
import { config } from './config.ts'
import { all, get, run, tx, now } from './db.ts'
import { HttpError, Router, rateLimit, type Ctx } from './http.ts'
import {
  cleanName, createPlayer, createSession, hashPassword, randomCode, sha256, verifyPassword, type PlayerRow,
} from './auth.ts'
import * as game from './game.ts'
import * as ladder from './ladder.ts'
import * as rooms from './rooms.ts'
import * as ai from './ai.ts'
import * as lb from './leaderboard.ts'
import * as live from './live.ts'
import { sofaQuestions } from './sofa.ts'
import { consentState, consentStats, currentPrivacy, recordConsent } from './privacy.ts'
import { erasePlayer } from './erase.ts'
import {
  adminEnabled, clearFailures, closeSession, COOKIE, loginBlocked, openSession, parseCookie,
  recordFailure, sameOriginOk, sessionCookie, tokenOk, validSession,
} from './admin.ts'
import { deliver, validEndpoint, validKeys, vapidPublicKey } from './push.ts'
import { applyPatch, datasetLines, exportCommunityBatch, insertQuestion, licenseSummary, questionUid, validateContent, type QContent, type QPatch, type QRow } from './questions.ts'
import { cleanSettings } from './settings.ts'
import { cleanBirthYear, overview, questionStats, suggestDifficulty } from './stats.ts'
import { fileReview, listReviews, questionOut, resolveReview } from './reviews.ts'

export const router = new Router()
const me = (c: Ctx) => c.player!
const pub = (p: Pick<PlayerRow, 'public_id' | 'name'>) => ({ public_id: p.public_id, name: p.name })
const LANG_RE = /^[a-z]{2,3}$/

function supportedLangs() {
  return all<{ lang: string; n: number }>(
    `SELECT lang, COUNT(*) n FROM questions WHERE status='active' AND ${SERVABLE_SQL} GROUP BY lang HAVING n>=? ORDER BY n DESC`, config.minLangQuestions)
}
function pickLang(want: unknown, fallback: string) {
  const langs = supportedLangs().map((l) => l.lang)
  const l = typeof want === 'string' ? want : fallback
  if (langs.includes(l)) return l
  if (langs.length) return langs.includes('en') ? 'en' : langs[0]
  throw new HttpError(503, 'no_questions')
}

const profile = (p: PlayerRow) => ({
  ...pub(p), lang: p.lang, has_account: !!p.username, username: p.username, created_at: p.created_at, reviewer: !!p.reviewer,
  level: p.level, disabled_cats: JSON.parse(p.disabled_cats) as string[], best_ladder: p.best_ladder, birth_year: p.birth_year, lb_name: p.lb_name, lb_follow: !!p.lb_follow, lb_banned: !!p.lb_banned,
})

/* ---------- Öffentliches ---------- */
router.get('/api/meta', () => ({
  categories: CATEGORIES, tiers: CATEGORY_TIERS, levels: TIERS, regions: REGIONS, reports: config.playerReports,
  langs: supportedLangs(),
  time_limit_ms: game.TIME_LIMIT_MS, rounds: game.ROUNDS, per_round: game.PER_ROUND,
}), { auth: false })

router.get('/api/licenses', () => ({ sources: licenseSummary(), licenses: LICENSES }), { auth: false })

router.get('/api/dataset.jsonl', (c) => {
  c.res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'content-disposition': 'attachment; filename="ratespass-questions.jsonl"',
    'cache-control': 'public, max-age=300',
  })
  c.res.end(datasetLines().join('\n') + '\n')
  return undefined
}, { auth: false })

router.get('/api/players/:public_id', (c) => {
  rateLimit(`lookup:${c.ip}`, 60, 60_000)
  const p = get<PlayerRow>('SELECT * FROM players WHERE public_id=? AND deleted=0 AND is_bot=0', c.params.public_id.toUpperCase())
  if (!p) throw new HttpError(404, 'unknown_player')
  return pub(p)
}, { auth: false })

/* ---------- Identität ---------- */
router.post('/api/players', (c) => {
  rateLimit(`create:${c.ip}`, config.playerCreateLimit, 3_600_000)
  const name = c.body.name ? cleanName(c.body.name) : `Spieler-${crypto.randomInt(1000, 10000)}`
  const lang = typeof c.body.lang === 'string' && LANG_RE.test(c.body.lang) ? c.body.lang : 'de'
  return tx(() => {
    if (config.requireConsent) { // Zustimmung zur aktuellen Datenschutzerklärung ist Voraussetzung für das Anlegen eines Profils
      const cur = currentPrivacy().version
      if (c.body.consent?.version !== cur) throw new HttpError(409, 'privacy_changed')
      if (c.body.consent?.age_ok !== true) throw new HttpError(400, 'consent_required')
    }
    const p = createPlayer(name, lang)
    if (config.requireConsent) recordConsent(p.id, c.body.consent.version, true, lang)
    return { token: createSession(p.id, 'anonymous'), player: profile(p) }
  })
}, { auth: false })

/* ---------- Datenschutz & Zustimmung ---------- */
router.get('/api/privacy', () => { const p = currentPrivacy(); return { version: p.version, de: p.de, en: p.en, missing: p.missing } }, { auth: false })

router.post('/api/consent', (c) => {
  const r = recordConsent(me(c).id, c.body?.version, c.body?.age_ok, me(c).lang)
  if (r === 'changed') throw new HttpError(409, 'privacy_changed')
  if (r === 'age') throw new HttpError(400, 'consent_required')
  return { consent: consentState(me(c).id) }
})

router.get('/api/me', (c) => ({
  player: profile(me(c)), consent: consentState(me(c).id),
  contacts: all<PlayerRow>(
    'SELECT p.* FROM contacts c JOIN players p ON p.id=c.contact_id WHERE c.player_id=? AND p.deleted=0 ORDER BY p.name', me(c).id).map(pub),
}))

router.patch('/api/me', (c) => {
  const p = me(c)
  let lbFollowLost = false
  if (c.body.name !== undefined) {
    run('UPDATE players SET name=? WHERE id=?', cleanName(c.body.name), p.id)
    lbFollowLost = !lb.followRename(p.id)
  }
  if (c.body.lang !== undefined) {
    if (!LANG_RE.test(c.body.lang)) throw new HttpError(400, 'bad_lang')
    run('UPDATE players SET lang=? WHERE id=?', c.body.lang, p.id)
  }
  if (c.body.birth_year !== undefined) run('UPDATE players SET birth_year=? WHERE id=?', cleanBirthYear(c.body.birth_year), p.id)
  if (c.body.level !== undefined || c.body.disabled_cats !== undefined) {
    const s = cleanSettings(c.body.level ?? p.level, c.body.disabled_cats ?? JSON.parse(p.disabled_cats))
    run('UPDATE players SET level=?, disabled_cats=? WHERE id=?', s.level, JSON.stringify(s.disabled), p.id)
  }
  return { player: profile(get<PlayerRow>('SELECT * FROM players WHERE id=?', p.id)!), ...(lbFollowLost ? { lb_follow_lost: true } : {}) }
})

router.delete('/api/me', (c) => {
  erasePlayer(me(c))
  return { ok: true }
})

const USERNAME_RE = /^[a-z0-9_.-]{3,24}$/
router.post('/api/account', async (c) => {
  const p = me(c)
  const username = String(c.body.username ?? '').toLowerCase()
  const password = String(c.body.password ?? '')
  if (!USERNAME_RE.test(username)) throw new HttpError(400, 'bad_username')
  if (password.length < 8 || password.length > 200) throw new HttpError(400, 'bad_password')
  if (p.username) throw new HttpError(409, 'already_has_account')
  const hash = await hashPassword(password)
  try {
    run('UPDATE players SET username=?, pw_hash=? WHERE id=?', username, hash, p.id)
  } catch (e: any) {
    if (String(e?.message).includes('UNIQUE')) throw new HttpError(409, 'username_taken')
    throw e
  }
  return { player: profile(get<PlayerRow>('SELECT * FROM players WHERE id=?', p.id)!) }
})

let dummyHash: Promise<string> | undefined
router.post('/api/login', async (c) => {
  rateLimit(`login:${c.ip}`, 10, 900_000)
  const username = String(c.body.username ?? '').toLowerCase()
  rateLimit(`login-user:${username}`, 10, 900_000)
  const p = get<PlayerRow>('SELECT * FROM players WHERE username=? AND deleted=0', username)
  dummyHash ??= hashPassword('dummy-password')
  const ok = await verifyPassword(String(c.body.password ?? ''), p?.pw_hash ?? (await dummyHash))
  if (!p || !ok) throw new HttpError(401, 'bad_credentials')
  return { token: createSession(p.id, 'login'), player: profile(p) }
}, { auth: false })

router.post('/api/logout', (c) => {
  const m = /^Bearer (\S+)$/.exec(c.req.headers.authorization ?? '')
  if (m) run('DELETE FROM sessions WHERE token_hash=?', sha256(m[1]))
  return { ok: true }
})

/* ---------- Gerätewechsel ---------- */
router.get('/api/export', (c) => {
  const p = me(c)
  const games = all<game.GameRow>("SELECT * FROM games WHERE (p1=? OR p2=?) AND status IN ('finished','active') ORDER BY id", p.id, p.id)
  return {
    format: 'ratespass-profile', version: 1, exported_at: new Date().toISOString(),
    warning: 'Diese Datei enthält einen geheimen Zugangsschlüssel (token). Nicht teilen.',
    token: createSession(p.id, 'export'),
    player: profile(p),
    contacts: all<PlayerRow>('SELECT p.* FROM contacts c JOIN players p ON p.id=c.contact_id WHERE c.player_id=? AND p.deleted=0', p.id).map(pub),
    games: games.map((g) => game.gameView(g, p.id)),
  }
})

router.post('/api/transfer', (c) => {
  const p = me(c)
  rateLimit(`transfer:${p.id}`, 10, 3_600_000)
  run('DELETE FROM transfer_codes WHERE player_id=? OR expires_at<?', p.id, now())
  const code = randomCode(8)
  const expires_at = now() + 10 * 60_000
  run('INSERT INTO transfer_codes(code,player_id,expires_at) VALUES(?,?,?)', code, p.id, expires_at)
  return { code, expires_at }
})

router.post('/api/transfer/redeem', (c) => {
  rateLimit(`redeem:${c.ip}`, 10, 900_000)
  const code = String(c.body.code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  return tx(() => {
    const t = get<{ player_id: number }>('SELECT player_id FROM transfer_codes WHERE code=? AND expires_at>?', code, now())
    if (!t) throw new HttpError(404, 'bad_code')
    run('DELETE FROM transfer_codes WHERE code=?', code)
    const p = get<PlayerRow>('SELECT * FROM players WHERE id=? AND deleted=0', t.player_id)!
    return { token: createSession(p.id, 'transfer'), player: profile(p) }
  })
}, { auth: false })

/* ---------- Kontakte ---------- */
router.post('/api/contacts', (c) => {
  const p = me(c)
  const o = get<PlayerRow>('SELECT * FROM players WHERE public_id=? AND deleted=0 AND is_bot=0', String(c.body.public_id ?? '').toUpperCase())
  if (!o || o.id === p.id) throw new HttpError(404, 'unknown_player')
  tx(() => {
    run('INSERT OR IGNORE INTO contacts(player_id,contact_id,created_at) VALUES(?,?,?)', p.id, o.id, now())
    run('INSERT OR IGNORE INTO contacts(player_id,contact_id,created_at) VALUES(?,?,?)', o.id, p.id, now())
  })
  return { contact: pub(o) }
})

router.delete('/api/contacts/:public_id', (c) => {
  run('DELETE FROM contacts WHERE player_id=? AND contact_id=(SELECT id FROM players WHERE public_id=?)', me(c).id, c.params.public_id.toUpperCase())
  return { ok: true }
})

/* ---------- Spiele ---------- */
router.get('/api/games', (c) => ({ games: game.listGames(me(c)) }))

router.post('/api/games', (c) => {
  const p = me(c)
  const opponent = String(c.body.opponent ?? '')
  if (!opponent) throw new HttpError(400, 'bad_opponent')
  const id = game.createGame(p, opponent === 'bot' || opponent === 'random' ? opponent : opponent.toUpperCase(), pickLang(c.body.lang, p.lang))
  return { id }
})

const gid = (c: Ctx) => {
  const n = Number(c.params.id)
  if (!Number.isInteger(n)) throw new HttpError(400, 'bad_id')
  return n
}
router.get('/api/games/:id', (c) => ({ game: game.getGameView(gid(c), me(c)) }))
router.post('/api/games/:id/pick', (c) => {
  game.pickCategory(gid(c), me(c), String(c.body.category ?? ''))
  return { game: game.getGameView(gid(c), me(c)) }
})
router.get('/api/games/:id/question', (c) => game.currentQuestion(gid(c), me(c)))
router.post('/api/games/:id/answer', (c) => {
  const result = game.submitAnswer(gid(c), me(c), c.body.idx, c.body.choice)
  return { ...result, game: game.getGameView(gid(c), me(c)) }
})
router.post('/api/games/:id/bot', (c) => {
  const g = game.getGame(gid(c))
  if (g?.status === 'active') game.takeOverWithBot(gid(c), me(c)) // untätigen Gegner im laufenden Duell durch einen Bot ersetzen
  else game.convertToBot(gid(c), me(c)) // wartendes Zufallsspiel sofort gegen den Bot spielen
  return { game: game.getGameView(gid(c), me(c)) }
})
router.post('/api/games/:id/resign', (c) => {
  game.resign(gid(c), me(c))
  return { game: game.getGameView(gid(c), me(c)) }
})
router.post('/api/games/:id/report', (c) => {
  if (!config.playerReports) throw new HttpError(403, 'reports_disabled')
  game.reportQuestion(gid(c), me(c), c.body.round, c.body.idx, c.body.reason)
  return { ok: true }
})

/** Überarbeitungs-Meldung (nur Reviewer): Frage oder Antworten sind „falsch“ oder die „Formulierung“ soll geändert werden. */
router.post('/api/games/:id/review', (c) => {
  const p = me(c)
  if (!p.reviewer) throw new HttpError(403, 'not_reviewer')
  rateLimit(`review:${p.id}`, 120, 3_600_000)
  const questionId = game.answeredQuestionId(gid(c), p, c.body.round, c.body.idx)
  fileReview(questionId, p.id, c.body.part, c.body.kind, c.body.note)
  return { ok: true }
})

/* ---------- Live-Gesellschaftsspiel (Echtzeit, Beitritt per QR des Hosts) ---------- */
router.post('/api/live', (c) => {
  const p = me(c)
  rateLimit(`live:${p.id}`, 20, 3_600_000)
  const r = live.createLive(p, c.body?.mode, c.body?.screen, pickLang(c.body?.lang, p.lang))
  return { id: r.id, live: live.getView(r.id, p) }
})
router.post('/api/live/join', (c) => {
  rateLimit(`livejoin:${c.ip}`, 60, 900_000)
  const id = live.joinByToken(me(c), c.body?.token)
  return { id, live: live.getView(id, me(c)) }
})
router.get('/api/live/:id', (c) => ({ live: live.getView(gid(c), me(c)) }))
router.get('/api/live/:id/events', (c) => { live.subscribe(gid(c), me(c), c.res); return undefined })
router.post('/api/live/:id/settings', (c) => { live.configure(me(c), gid(c), { mode: c.body?.mode, screen: c.body?.screen, teams: c.body?.teams }); return { live: live.getView(gid(c), me(c)) } })
router.post('/api/live/:id/renew', (c) => { live.renewToken(me(c), gid(c)); return { live: live.getView(gid(c), me(c)) } })
router.post('/api/live/:id/start', (c) => { live.start(me(c), gid(c)); return { live: live.getView(gid(c), me(c)) } })
router.post('/api/live/:id/next', (c) => { live.next(me(c), gid(c)); return { live: live.getView(gid(c), me(c)) } })
router.post('/api/live/:id/end', (c) => { live.end(me(c), gid(c)); return { live: live.getView(gid(c), me(c)) } })
router.post('/api/live/:id/kick', (c) => { live.kick(me(c), gid(c), c.body?.public_id); return { live: live.getView(gid(c), me(c)) } })
router.post('/api/live/:id/team', (c) => { live.setTeam(me(c), gid(c), c.body?.team); return { live: live.getView(gid(c), me(c)) } })
router.post('/api/live/:id/bet', (c) => { live.placeBet(me(c), gid(c), c.body?.idx, c.body?.amount); return { ok: true } })
router.post('/api/live/:id/answer', (c) => { live.answer(me(c), gid(c), c.body?.idx, c.body?.choice); return { ok: true } })

/* ---------- Bestenliste (Opt-in) ---------- */
router.get('/api/leaderboard', (c) => {
  const q = c.url.searchParams
  const scope = (lb.SCOPES as readonly string[]).includes(q.get('scope') ?? '') ? (q.get('scope') as lb.Scope) : 'week'
  const r = lb.ranking(scope, q.get('bots') === 'excl', q.get('kind') === 'rel' ? 'rel' : 'abs', me(c).id, Math.min(100, Number(q.get('limit')) || 50))
  return { ...r, participating: !!me(c).lb_name, name: me(c).lb_name, banned: !!me(c).lb_banned }
})
router.post('/api/leaderboard/join', (c) => {
  rateLimit(`lbjoin:${me(c).id}`, 20, 3_600_000)
  return { name: lb.join(me(c).id, c.body?.name, c.body?.use_display_name === true) }
})
router.delete('/api/leaderboard/join', (c) => {
  lb.leave(me(c).id)
  return { ok: true }
})

/* ---------- Millionen-Leiter (Solo) ---------- */
router.post('/api/ladders', (c) => {
  const p = me(c)
  rateLimit(`ladder:${p.id}`, 60, 3_600_000)
  const id = ladder.startLadder(p, pickLang(c.body?.lang, p.lang))
  return { id, ladder: ladder.getLadderView(id, p) }
})
router.get('/api/ladders/:id', (c) => ({ ladder: ladder.getLadderView(gid(c), me(c)) }))
router.get('/api/ladders/:id/question', (c) => ladder.currentQuestion(gid(c), me(c)))
router.post('/api/ladders/:id/answer', (c) => ladder.submitAnswer(gid(c), me(c), c.body.step, c.body.choice))
router.post('/api/ladders/:id/quit', (c) => ({ ladder: ladder.quit(gid(c), me(c)) }))
router.post('/api/ladders/:id/report', (c) => {
  if (!config.playerReports) throw new HttpError(403, 'reports_disabled')
  const qid = ladder.answeredQuestionId(gid(c), me(c), c.body.step)
  run('INSERT OR IGNORE INTO reports(question_id,player_id,reason,created_at) VALUES(?,?,?,?)', qid, me(c).id, String(c.body.reason ?? '').slice(0, 200), now())
  if (get<{ n: number }>('SELECT COUNT(*) n FROM reports WHERE question_id=?', qid)!.n >= 3) run("UPDATE questions SET status='disabled' WHERE id=? AND status='active'", qid)
  return { ok: true }
})
router.post('/api/ladders/:id/review', (c) => {
  const p = me(c)
  if (!p.reviewer) throw new HttpError(403, 'not_reviewer')
  rateLimit(`review:${p.id}`, 120, 3_600_000)
  fileReview(ladder.answeredQuestionId(gid(c), p, c.body.step), p.id, c.body.part, c.body.kind, c.body.note)
  return { ok: true }
})

/* ---------- Mehrspieler-Räume (asynchron) ---------- */
router.get('/api/sofa', (c) => {
  rateLimit(`sofa:${me(c).id}`, 60, 3_600_000)
  const q = c.url.searchParams
  return { questions: sofaQuestions(me(c), pickLang(q.get('lang') ?? undefined, me(c).lang), q.get('n')) }
})
router.get('/api/rooms', (c) => ({ rooms: rooms.listRooms(me(c)) }))
router.post('/api/rooms', (c) => {
  const p = me(c)
  rateLimit(`room:${p.id}`, 30, 3_600_000)
  const id = rooms.createRoom(p, c.body?.mode, pickLang(c.body?.lang, p.lang))
  return { id, room: rooms.getRoomView(id, p) }
})
router.post('/api/rooms/join', (c) => {
  const p = me(c)
  rateLimit(`roomjoin:${c.ip}`, 30, 900_000)
  const id = rooms.joinRoom(p, c.body?.code)
  return { id, room: rooms.getRoomView(id, p) }
})
router.get('/api/rooms/:id', (c) => ({ room: rooms.getRoomView(gid(c), me(c)) }))
router.post('/api/rooms/:id/start', (c) => {
  rooms.startRoom(me(c), gid(c))
  return { room: rooms.getRoomView(gid(c), me(c)) }
})
router.post('/api/rooms/:id/leave', (c) => {
  rooms.leaveRoom(me(c), gid(c))
  return { ok: true }
})
router.get('/api/rooms/:id/question', (c) => rooms.currentQuestion(gid(c), me(c)))
router.post('/api/rooms/:id/answer', (c) => rooms.submitAnswer(gid(c), me(c), c.body.step, c.body.choice))
router.post('/api/rooms/:id/quit', (c) => ({ room: rooms.quit(gid(c), me(c)) }))
router.post('/api/rooms/:id/report', (c) => {
  if (!config.playerReports) throw new HttpError(403, 'reports_disabled')
  const qid = rooms.answeredQuestionId(gid(c), me(c), c.body.step)
  run('INSERT OR IGNORE INTO reports(question_id,player_id,reason,created_at) VALUES(?,?,?,?)', qid, me(c).id, String(c.body.reason ?? '').slice(0, 200), now())
  if (get<{ n: number }>('SELECT COUNT(*) n FROM reports WHERE question_id=?', qid)!.n >= 3) run("UPDATE questions SET status='disabled' WHERE id=? AND status='active'", qid)
  return { ok: true }
})
router.post('/api/rooms/:id/review', (c) => {
  const p = me(c)
  if (!p.reviewer) throw new HttpError(403, 'not_reviewer')
  rateLimit(`review:${p.id}`, 120, 3_600_000)
  fileReview(rooms.answeredQuestionId(gid(c), p, c.body.step), p.id, c.body.part, c.body.kind, c.body.note)
  return { ok: true }
})

/* ---------- Web-Push ---------- */
router.get('/api/push/key', () => ({ key: vapidPublicKey() }), { auth: false })

router.post('/api/push/subscribe', (c) => {
  const p = me(c)
  const { endpoint, keys } = c.body ?? {}
  if (!validEndpoint(endpoint) || !validKeys(keys?.p256dh, keys?.auth)) throw new HttpError(400, 'bad_subscription')
  tx(() => {
    run(`INSERT INTO push_subs(endpoint,player_id,p256dh,auth,created_at) VALUES(?,?,?,?,?)
         ON CONFLICT(endpoint) DO UPDATE SET player_id=excluded.player_id, p256dh=excluded.p256dh, auth=excluded.auth, fails=0`,
    endpoint, p.id, keys.p256dh, keys.auth, now())
    run(`DELETE FROM push_subs WHERE player_id=? AND endpoint NOT IN
         (SELECT endpoint FROM push_subs WHERE player_id=? ORDER BY created_at DESC LIMIT 10)`, p.id, p.id)
  })
  return { ok: true }
})

router.post('/api/push/unsubscribe', (c) => {
  run('DELETE FROM push_subs WHERE endpoint=? AND player_id=?', String(c.body?.endpoint ?? ''), me(c).id)
  return { ok: true }
})

router.post('/api/push/test', async (c) => {
  const p = me(c)
  rateLimit(`pushtest:${p.id}`, 5, 3_600_000)
  const de = p.lang === 'de'
  const sent = await deliver(p.id, {
    title: 'Ratespaß', body: de ? 'Benachrichtigungen funktionieren ✅' : 'Notifications are working ✅', url: '/#/', tag: 'test',
  })
  return { sent }
})

/* ---------- Community ---------- */
router.post('/api/submissions', (c) => {
  const p = me(c)
  const b = c.body
  if (b.license_ack !== true) throw new HttpError(400, 'license_ack_required')
  if (!LANG_RE.test(b.lang ?? '')) throw new HttpError(400, 'bad_lang')
  if (!isCategory(b.category)) throw new HttpError(400, 'bad_category')
  if (![1, 2, 3].includes(b.difficulty)) throw new HttpError(400, 'bad_difficulty')
  const content: QContent = {
    text: String(b.text ?? ''), correct: String(b.correct ?? ''),
    wrong: Array.isArray(b.wrong) ? b.wrong.map(String) : [], explanation: b.explanation ? String(b.explanation) : undefined,
  }
  const err = validateContent(content)
  if (err) throw new HttpError(400, 'invalid_question', err)
  const today = get<{ n: number }>('SELECT COUNT(*) n FROM questions WHERE submitted_by=? AND created_at>?', p.id, now() - 86_400_000)!.n
  if (today >= 10) throw new HttpError(429, 'daily_limit')
  const ok = insertQuestion({
    group: 'c:' + crypto.randomBytes(8).toString('hex'), lang: b.lang, category: b.category, difficulty: b.difficulty, content,
    source: 'community', license: 'CC-BY-SA-4.0', attribution: 'Community contribution', status: 'pending', submitted_by: p.id,
  })
  if (!ok) throw new HttpError(409, 'duplicate')
  return { ok: true }
})

router.get('/api/submissions', (c) => ({
  submissions: all<Pick<QRow, 'id' | 'lang' | 'category' | 'text' | 'status' | 'created_at'>>(
    'SELECT id, lang, category, text, status, created_at FROM questions WHERE submitted_by=? ORDER BY id DESC LIMIT 50', me(c).id),
}))

/* ---------- Moderation ---------- */
const COOKIE_MAX = () => Math.floor(config.adminSessionMs / 1000)
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Zugang per Session-Cookie (Browser-Login mit dem Token) oder direkt per `X-Admin-Token` (Skripte).
 * Falsche Token-Versuche zählen für beide Wege in dieselbe Sperre je IP.
 */
function admin(c: Ctx) {
  if (!adminEnabled()) throw new HttpError(404, 'not_found')
  rateLimit(`admin:${c.ip}`, 120, 60_000)
  if (validSession(parseCookie(c.req.headers.cookie, COOKIE))) {
    if (c.req.method !== 'GET' && !sameOriginOk(c.req)) throw new HttpError(403, 'forbidden_origin')
    return
  }
  const tok = c.req.headers['x-admin-token']
  if (typeof tok === 'string' && tok) {
    if (loginBlocked(c.ip)) throw new HttpError(429, 'rate_limited')
    if (tokenOk(tok)) return
    recordFailure(c.ip)
  }
  throw new HttpError(401, 'unauthorized')
}

router.post('/api/admin/login', async (c) => {
  if (!adminEnabled()) throw new HttpError(404, 'not_found')
  if (loginBlocked(c.ip)) throw new HttpError(429, 'rate_limited')
  if (!tokenOk(String(c.body?.token ?? '').slice(0, 500))) {
    recordFailure(c.ip)
    await delay(400) // bremst automatisierte Versuche zusätzlich
    throw new HttpError(401, 'bad_credentials')
  }
  clearFailures(c.ip)
  c.res.setHeader('set-cookie', sessionCookie(openSession(), c.req, COOKIE_MAX()))
  return { ok: true }
}, { auth: false })

router.post('/api/admin/logout', (c) => {
  closeSession(parseCookie(c.req.headers.cookie, COOKIE))
  c.res.setHeader('set-cookie', `${COOKIE}=; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=0`)
  return { ok: true }
}, { auth: false })

router.get('/api/admin/me', (c) => {
  admin(c)
  return { ok: true }
}, { auth: false })

router.get('/api/admin/queue', (c) => {
  admin(c)
  const status = c.url.searchParams.get('status') === 'disabled' ? 'disabled' : 'pending'
  const rows = all<QRow & { reports: number; reasons: string | null }>(
    `SELECT q.*, (SELECT COUNT(*) FROM reports r WHERE r.question_id=q.id) reports,
            (SELECT group_concat(reason, ' | ') FROM reports r WHERE r.question_id=q.id AND reason<>'') reasons
     FROM questions q WHERE q.status=? ORDER BY q.id LIMIT 100`, status)
  return { questions: rows.map((q) => ({ ...q, wrong: JSON.parse(q.wrong) })) }
}, { auth: false })

router.post('/api/admin/questions/:id', (c) => {
  admin(c)
  const id = Number(c.params.id)
  const q = get<QRow>('SELECT * FROM questions WHERE id=?', id)
  if (!q) throw new HttpError(404, 'not_found')
  const status = ({ approve: 'active', activate: 'active', reject: 'rejected', disable: 'disabled', save: q.status } as Record<string, string>)[c.body.action]
  if (!status) throw new HttpError(400, 'bad_action')
  const patch = c.body.patch as QPatch | undefined
  if (patch) applyPatch(q, patch)
  run('UPDATE questions SET status=? WHERE id=?', status, id)
  if (status === 'active' && c.body.action !== 'save') run('DELETE FROM reports WHERE question_id=?', id)
  return { ok: true }
}, { auth: false })

/** Freigegebene, noch nicht exportierte Community-Fragen als Batch-Datei (zum Einchecken ins Repo). ?mark=1 vermerkt sie als exportiert. */
router.get('/api/admin/community-batch', (c) => {
  admin(c)
  const batch = exportCommunityBatch({ mark: c.url.searchParams.get('mark') === '1', dir: config.batchDir, source: c.url.searchParams.get('source') === 'llm' ? 'llm' : 'community' })
  if (!batch) throw new HttpError(404, 'nothing_to_export')
  c.res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-disposition': `attachment; filename="${batch.batch}.json"`, 'cache-control': 'no-store',
  })
  c.res.end(JSON.stringify(batch, null, 1))
  return undefined
}, { auth: false })

/* --- Überarbeitung: Meldungen, Suche, Reviewer, Korrektur-Export --- */
router.get('/api/admin/reviews', (c) => {
  admin(c)
  const st = c.url.searchParams.get('status')
  return { reviews: listReviews(st === 'resolved' || st === 'dismissed' ? st : 'open') }
}, { auth: false })

/** Admin markiert selbst eine Frage zur Überarbeitung. */
router.post('/api/admin/reviews', (c) => {
  admin(c)
  return { id: fileReview(Number(c.body.question_id), null, c.body.part, c.body.kind, c.body.note) }
}, { auth: false })

router.post('/api/admin/reviews/:id', (c) => {
  admin(c)
  const id = Number(c.params.id)
  const action = c.body.action
  if (action !== 'resolve' && action !== 'dismiss') throw new HttpError(400, 'bad_action')
  const rev = get<{ question_id: number }>("SELECT question_id FROM reviews WHERE id=? AND status='open'", id)
  if (!rev) throw new HttpError(404, 'not_found')
  tx(() => {
    if (action === 'resolve' && c.body.patch) applyPatch(get<QRow>('SELECT * FROM questions WHERE id=?', rev.question_id)!, c.body.patch as QPatch)
    resolveReview(id, action === 'resolve' ? 'resolved' : 'dismissed')
  })
  return { ok: true }
}, { auth: false })

router.get('/api/admin/search', (c) => {
  admin(c)
  const q = c.url.searchParams.get('q')?.trim().slice(0, 100) ?? ''
  const lang = c.url.searchParams.get('lang')
  const region = c.url.searchParams.get('region')
  const where: string[] = []
  const args: (string | number)[] = []
  if (q) {
    if (/^#\d+$/.test(q)) { where.push('q.id=?'); args.push(Number(q.slice(1))) }
    else { where.push("(q.text LIKE ? ESCAPE '\\' OR q.correct LIKE ? ESCAPE '\\')"); const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`; args.push(like, like) }
  }
  if (lang && LANG_RE.test(lang)) { where.push('q.lang=?'); args.push(lang) }
  if (region && (REGIONS as readonly string[]).includes(region)) { where.push('q.region=?'); args.push(region) }
  const rows = all<QRow & { open_reviews: number }>(
    `SELECT q.*, (SELECT COUNT(*) FROM reviews r WHERE r.question_id=q.id AND r.status='open') open_reviews
     FROM questions q ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY q.id LIMIT 30`, ...args)
  return { questions: rows.map(questionOut) }
}, { auth: false })

router.get('/api/admin/reviewers', (c) => {
  admin(c)
  return { reviewers: all('SELECT public_id, name FROM players WHERE reviewer=1 AND deleted=0 ORDER BY name') }
}, { auth: false })

router.post('/api/admin/reviewers', (c) => {
  admin(c)
  const r = run('UPDATE players SET reviewer=1 WHERE public_id=? AND deleted=0 AND is_bot=0', String(c.body.public_id ?? '').trim().toUpperCase())
  if (!r.changes) throw new HttpError(404, 'unknown_player')
  return { ok: true }
}, { auth: false })

router.delete('/api/admin/reviewers/:public_id', (c) => {
  admin(c)
  run('UPDATE players SET reviewer=0 WHERE public_id=?', c.params.public_id.toUpperCase())
  return { ok: true }
}, { auth: false })

/** Alle Admin-Korrekturen seit `after` (Edit-ID); `tools/apply-edits.ts` überträgt sie in die Batch-Dateien im Repo. */
router.get('/api/admin/edits', (c) => {
  admin(c)
  const after = Number(c.url.searchParams.get('after') ?? 0) || 0
  return { edits: all<{ id: number; group_id: string; lang: string; batch: string | null; old: string; new: string; created_at: number }>(
    'SELECT * FROM edits WHERE id>? ORDER BY id', after).map((e) => ({ ...e, old: JSON.parse(e.old), new: JSON.parse(e.new) })) }
}, { auth: false })

/* --- KI-Schnittstelle: Fragen erzeugen, Schwierigkeit schätzen, Verteilung steuern --- */
router.get('/api/admin/ai/status', (c) => {
  admin(c)
  return ai.status()
}, { auth: false })

router.post('/api/admin/ai/settings', (c) => {
  admin(c)
  if (c.body?.diff !== undefined || c.body?.min_per_category !== undefined) ai.setTarget(c.body.diff, c.body.min_per_category)
  if (c.body?.auto !== undefined) ai.setAuto(!!c.body.auto)
  return ai.status()
}, { auth: false })

router.post('/api/admin/ai/generate', async (c) => {
  admin(c)
  rateLimit('ai:admin', 60, 3_600_000)
  if (c.body?.category) return { results: [await ai.generate({ category: String(c.body.category), difficulty: Number(c.body.difficulty) || 2, count: Number(c.body.count) || 10 })] }
  return { results: await ai.fillGaps(Math.min(100, Number(c.body?.count) || 20)) } // ohne Angabe: größte Lücken des Plans füllen
}, { auth: false })

router.post('/api/admin/ai/estimate', async (c) => {
  admin(c)
  rateLimit('ai:admin', 60, 3_600_000)
  return ai.estimate({ limit: Number(c.body?.limit) || 30, category: c.body?.category ? String(c.body.category) : undefined })
}, { auth: false })

router.post('/api/admin/ai/apply', (c) => {
  admin(c)
  return ai.applyEstimates(Math.min(1, Math.max(0, Number(c.body?.min_confidence ?? 0.7))))
}, { auth: false })

/* --- Bestenliste: Auffälligkeiten prüfen, Teilnehmer sperren --- */
router.get('/api/admin/lb/flags', (c) => {
  admin(c)
  return { flags: lb.flags(Number(c.url.searchParams.get('min_n')) || 200), banned: all('SELECT public_id, name, lb_name FROM players WHERE lb_banned=1 AND deleted=0') }
}, { auth: false })
router.post('/api/admin/lb/ban', (c) => {
  admin(c)
  lb.ban(String(c.body?.public_id ?? ''), c.body?.banned !== false)
  return { ok: true }
}, { auth: false })

/** Lösungen vs. Alter: Auswertung der Antworten aller Spieler (ohne Bots), Altersgruppen nur ab 5 Antworten. */
router.get('/api/admin/stats/overview', (c) => {
  admin(c)
  return overview()
}, { auth: false })

router.get('/api/admin/stats/questions', (c) => {
  admin(c)
  const q = c.url.searchParams
  return questionStats({
    category: q.get('category') || undefined, lang: q.get('lang') || undefined, difficulty: Number(q.get('difficulty')) || undefined,
    minN: Number(q.get('min_n')) || 1, sort: q.get('sort') || 'gap', limit: Math.min(200, Number(q.get('limit')) || 50),
  })
}, { auth: false })

/** Schwierigkeit an die gemessene Lösungsquote angleichen (Einzelfrage per group_id oder alle Vorschläge ab `min_n` Antworten). Wird in `edits` protokolliert. */
router.post('/api/admin/stats/apply-difficulty', (c) => {
  admin(c)
  const minN = Math.max(10, Number(c.body?.min_n) || 30)
  const groups = c.body?.group_id ? [String(c.body.group_id)] : questionStats({ minN, sort: 'gap', limit: 5000 }).questions.filter((x) => x.suggested && x.suggested !== x.difficulty).map((x) => x.group_id)
  let changed = 0
  for (const g of groups) {
    const row = get<QRow>('SELECT * FROM questions WHERE group_id=? ORDER BY lang LIMIT 1', g)
    if (!row) continue
    const s = suggestDifficulty(g, minN)
    if (s && s !== row.difficulty) { applyPatch(row, { difficulty: s }); changed++ }
  }
  return { changed }
}, { auth: false })

router.get('/api/admin/stats', (c) => {
  admin(c)
  return {
    questions: all('SELECT lang, category, region, status, COUNT(*) n FROM questions GROUP BY lang, category, region, status'),
    open_reviews: get('SELECT COUNT(*) n FROM reviews WHERE status=\'open\''),
    players: get('SELECT COUNT(*) n FROM players WHERE is_bot=0 AND deleted=0'),
    games: all('SELECT status, COUNT(*) n FROM games GROUP BY status'),
    batches: all('SELECT * FROM batches ORDER BY imported_at'),
    consents: consentStats(), privacy_missing: currentPrivacy().missing,
  }
}, { auth: false })
