import crypto from 'node:crypto'
import { CATEGORIES, isCategory, LICENSES } from './categories.ts'
import { config } from './config.ts'
import { all, get, run, tx, now } from './db.ts'
import { HttpError, Router, rateLimit, type Ctx } from './http.ts'
import {
  cleanName, createPlayer, createSession, hashPassword, randomCode, sha256, verifyPassword, type PlayerRow,
} from './auth.ts'
import * as game from './game.ts'
import { deliver, validEndpoint, validKeys, vapidPublicKey } from './push.ts'
import { datasetLines, exportCommunityBatch, insertQuestion, licenseSummary, questionUid, validateContent, type QContent, type QRow } from './questions.ts'

export const router = new Router()
const me = (c: Ctx) => c.player!
const pub = (p: Pick<PlayerRow, 'public_id' | 'name'>) => ({ public_id: p.public_id, name: p.name })
const LANG_RE = /^[a-z]{2,3}$/

function supportedLangs() {
  return all<{ lang: string; n: number }>(
    "SELECT lang, COUNT(*) n FROM questions WHERE status='active' GROUP BY lang HAVING n>=? ORDER BY n DESC", config.minLangQuestions)
}
function pickLang(want: unknown, fallback: string) {
  const langs = supportedLangs().map((l) => l.lang)
  const l = typeof want === 'string' ? want : fallback
  if (langs.includes(l)) return l
  if (langs.length) return langs.includes('en') ? 'en' : langs[0]
  throw new HttpError(503, 'no_questions')
}

const profile = (p: PlayerRow) => ({
  ...pub(p), lang: p.lang, has_account: !!p.username, username: p.username, created_at: p.created_at,
})

/* ---------- Öffentliches ---------- */
router.get('/api/meta', () => ({
  categories: CATEGORIES,
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
  rateLimit(`create:${c.ip}`, 20, 3_600_000)
  const name = c.body.name ? cleanName(c.body.name) : `Spieler-${crypto.randomInt(1000, 10000)}`
  const lang = typeof c.body.lang === 'string' && LANG_RE.test(c.body.lang) ? c.body.lang : 'de'
  return tx(() => {
    const p = createPlayer(name, lang)
    return { token: createSession(p.id, 'anonymous'), player: profile(p) }
  })
}, { auth: false })

router.get('/api/me', (c) => ({
  player: profile(me(c)),
  contacts: all<PlayerRow>(
    'SELECT p.* FROM contacts c JOIN players p ON p.id=c.contact_id WHERE c.player_id=? AND p.deleted=0 ORDER BY p.name', me(c).id).map(pub),
}))

router.patch('/api/me', (c) => {
  const p = me(c)
  if (c.body.name !== undefined) run('UPDATE players SET name=? WHERE id=?', cleanName(c.body.name), p.id)
  if (c.body.lang !== undefined) {
    if (!LANG_RE.test(c.body.lang)) throw new HttpError(400, 'bad_lang')
    run('UPDATE players SET lang=? WHERE id=?', c.body.lang, p.id)
  }
  return { player: profile(get<PlayerRow>('SELECT * FROM players WHERE id=?', p.id)!) }
})

router.delete('/api/me', (c) => {
  tx(() => {
    const p = me(c)
    for (const g of all<{ id: number }>("SELECT id FROM games WHERE (p1=? OR p2=?) AND status IN ('waiting','active')", p.id, p.id)) game.resign(g.id, p)
    run("UPDATE players SET deleted=1, name='—', username=NULL, pw_hash=NULL WHERE id=?", p.id)
    run('DELETE FROM sessions WHERE player_id=?', p.id)
    run('DELETE FROM push_subs WHERE player_id=?', p.id)
    run('DELETE FROM transfer_codes WHERE player_id=?', p.id)
    run('DELETE FROM contacts WHERE player_id=? OR contact_id=?', p.id, p.id)
    run('DELETE FROM seen WHERE player_id=?', p.id)
    run('DELETE FROM reports WHERE player_id=?', p.id)
    run('UPDATE questions SET submitted_by=NULL WHERE submitted_by=?', p.id)
  })
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
  game.convertToBot(gid(c), me(c))
  return { game: game.getGameView(gid(c), me(c)) }
})
router.post('/api/games/:id/resign', (c) => {
  game.resign(gid(c), me(c))
  return { game: game.getGameView(gid(c), me(c)) }
})
router.post('/api/games/:id/report', (c) => {
  game.reportQuestion(gid(c), me(c), c.body.round, c.body.idx, c.body.reason)
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
function admin(c: Ctx) {
  if (!config.adminToken) throw new HttpError(404, 'not_found')
  const a = Buffer.from(sha256(String(c.req.headers['x-admin-token'] ?? '')))
  const b = Buffer.from(sha256(config.adminToken))
  rateLimit(`admin:${c.ip}`, 120, 60_000)
  if (!crypto.timingSafeEqual(a, b)) throw new HttpError(401, 'unauthorized')
}

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
  const status = ({ approve: 'active', activate: 'active', reject: 'rejected', disable: 'disabled' } as Record<string, string>)[c.body.action]
  if (!status) throw new HttpError(400, 'bad_action')
  const patch = c.body.patch as Partial<QContent & { category: string; difficulty: number }> | undefined
  if (patch) {
    const content: QContent = {
      text: patch.text ?? q.text, correct: patch.correct ?? q.correct,
      wrong: patch.wrong ?? JSON.parse(q.wrong), explanation: patch.explanation ?? q.explanation ?? undefined,
    }
    const err = validateContent(content)
    if (err) throw new HttpError(400, 'invalid_question', err)
    if (patch.category !== undefined && !isCategory(patch.category)) throw new HttpError(400, 'bad_category')
    run('UPDATE questions SET uid=?, text=?, correct=?, wrong=?, explanation=?, category=?, difficulty=? WHERE id=?',
      questionUid(q.lang, content.text), content.text, content.correct, JSON.stringify(content.wrong), content.explanation ?? null,
      patch.category ?? q.category, patch.difficulty ?? q.difficulty, id)
  }
  run('UPDATE questions SET status=? WHERE id=?', status, id)
  if (status === 'active') run('DELETE FROM reports WHERE question_id=?', id)
  return { ok: true }
}, { auth: false })

/** Freigegebene, noch nicht exportierte Community-Fragen als Batch-Datei (zum Einchecken ins Repo). ?mark=1 vermerkt sie als exportiert. */
router.get('/api/admin/community-batch', (c) => {
  admin(c)
  const batch = exportCommunityBatch({ mark: c.url.searchParams.get('mark') === '1', dir: config.batchDir })
  if (!batch) throw new HttpError(404, 'nothing_to_export')
  c.res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-disposition': `attachment; filename="${batch.batch}.json"`, 'cache-control': 'no-store',
  })
  c.res.end(JSON.stringify(batch, null, 1))
  return undefined
}, { auth: false })

router.get('/api/admin/stats', (c) => {
  admin(c)
  return {
    questions: all('SELECT lang, category, status, COUNT(*) n FROM questions GROUP BY lang, category, status'),
    players: get('SELECT COUNT(*) n FROM players WHERE is_bot=0 AND deleted=0'),
    games: all('SELECT status, COUNT(*) n FROM games GROUP BY status'),
    batches: all('SELECT * FROM batches ORDER BY imported_at'),
  }
}, { auth: false })
