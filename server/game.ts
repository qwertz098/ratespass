import crypto from 'node:crypto'
import { all, get, run, tx, now } from './db.ts'
import { createPlayer, type PlayerRow } from './auth.ts'
import { config } from './config.ts'
import { CATEGORIES, SERVABLE_SQL, tierOf, type Tier } from './categories.ts'
import { effectiveFor } from './settings.ts'
import { sweepLadders } from './ladder.ts'
import { HttpError } from './http.ts'
import { notifyPlayer, type PushKind } from './push.ts'
import type { QRow } from './questions.ts'

export const ROUNDS = 6
export const PER_ROUND = 3
export const TIME_LIMIT_MS = 20_000
const GRACE_MS = 4_000

export interface GameRow {
  id: number; p1: number; p2: number | null; lang: string
  status: 'waiting' | 'active' | 'finished' | 'abandoned'
  round: number; turn: number | null; phase: 'pick' | 'play' | null
  level: Tier | null; cats: string | null // Snapshot der wirksamen Stufe/Kategorien (null: Spiel aus der Zeit vor v5 → nur Basis)
  winner: number | null; end_reason: string | null; created_at: number; updated_at: number
}

const shuffle = <T>(a: T[]): T[] => {
  const r = [...a]
  for (let i = r.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1)
    ;[r[i], r[j]] = [r[j], r[i]]
  }
  return r
}

const nameOf = (id: number | null) => (id ? get<{ name: string }>('SELECT name FROM players WHERE id=?', id)?.name ?? '' : '')

export const getGame = (id: number) => get<GameRow>('SELECT * FROM games WHERE id=?', id)
function mustGame(id: number, pid: number): GameRow {
  const g = getGame(id)
  if (!g || (g.p1 !== pid && g.p2 !== pid)) throw new HttpError(404, 'not_found')
  return g
}
const other = (g: GameRow, pid: number) => (g.p1 === pid ? g.p2 : g.p1)

export function ensureBot(): number {
  const b = get<{ id: number }>('SELECT id FROM players WHERE is_bot=1 LIMIT 1')
  if (b) return b.id
  const p = createPlayer('Robo', 'de')
  run('UPDATE players SET is_bot=1 WHERE id=?', p.id)
  return p.id
}

/** Kategorien mit genug noch nicht in diesem Spiel verwendeten Fragen; sonst (kleiner Pool) alle mit genug Fragen. */
function categoriesFor(g: GameRow): string[] {
  const allowed = new Set<string>(g.cats ? (JSON.parse(g.cats) as string[]) : CATEGORIES.filter((c) => tierOf(c) === 'basic'))
  return categoriesPool(g).filter((c) => allowed.has(c))
}
function categoriesPool(g: GameRow): string[] {
  const fresh = all<{ category: string }>(
    `SELECT category FROM questions WHERE lang=? AND status='active' AND ${SERVABLE_SQL}
       AND group_id NOT IN (SELECT q.group_id FROM round_questions rq JOIN questions q ON q.id=rq.question_id WHERE rq.game_id=?)
     GROUP BY category HAVING COUNT(*)>=?`, g.lang, g.id, PER_ROUND).map((r) => r.category)
  if (fresh.length) return fresh
  return all<{ category: string }>(
    `SELECT category FROM questions WHERE lang=? AND status='active' AND ${SERVABLE_SQL} GROUP BY category HAVING COUNT(*)>=?`, g.lang, PER_ROUND).map((r) => r.category)
}

/** Drei zufällige Kategorien; gibt es wirksame Nerd-/Experten-Kategorien, ist mindestens eine davon im Angebot. */
function pickOptions(cats: string[]): string[] {
  const mixed = shuffle(cats)
  const special = mixed.find((c) => tierOf(c) !== 'basic')
  const rest = mixed.filter((c) => c !== special)
  return shuffle([...(special ? [special] : []), ...rest].slice(0, 3))
}

function startRound(g: GameRow, n: number) {
  const picker = n % 2 === 1 ? g.p1 : g.p2!
  const cats = categoriesFor(g)
  if (!cats.length) throw new HttpError(503, 'no_questions')
  run('INSERT INTO rounds(game_id,n,picker,options) VALUES(?,?,?,?)', g.id, n, picker, JSON.stringify(pickOptions(cats)))
  run("UPDATE games SET round=?, turn=?, phase='pick', updated_at=? WHERE id=?", n, picker, now(), g.id)
}

function activeCount(pid: number) {
  return get<{ n: number }>("SELECT COUNT(*) n FROM games WHERE (p1=? OR p2=?) AND status IN ('waiting','active')", pid, pid)!.n
}
function guardLimit(pid: number) {
  if (activeCount(pid) >= config.maxActiveGames) throw new HttpError(429, 'too_many_games')
}

function insertGame(p1: number, p2: number | null, lang: string) {
  const t = now()
  const eff = effectiveFor([p1, p2])
  const r = run('INSERT INTO games(p1,p2,lang,status,level,cats,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', p1, p2, lang, p2 ? 'active' : 'waiting', eff.level, JSON.stringify(eff.cats), t, t)
  const g = getGame(Number(r.lastInsertRowid))!
  if (p2) startRound(g, 1)
  return g.id
}

export const knows = (a: number, b: number) =>
  !!get('SELECT 1 FROM contacts WHERE player_id=? AND contact_id=?', a, b) ||
  !!get('SELECT 1 FROM games WHERE (p1=? AND p2=?) OR (p1=? AND p2=?) LIMIT 1', a, b, b, a)

export function createGame(me: PlayerRow, opponent: string, lang: string): number {
  return tx(() => {
    guardLimit(me.id)
    let id: number
    if (opponent === 'bot') id = insertGame(me.id, ensureBot(), lang)
    else if (opponent === 'random') {
      const w = get<{ id: number; p1: number }>(
        "SELECT id, p1 FROM games WHERE status='waiting' AND lang=? AND p1<>? ORDER BY created_at LIMIT 1", lang, me.id)
      if (w) {
        const eff = effectiveFor([w.p1, me.id]) // zählt die niedrigste Einstellung beider
        run("UPDATE games SET p2=?, status='active', level=?, cats=? WHERE id=?", me.id, eff.level, JSON.stringify(eff.cats), w.id)
        startRound(getGame(w.id)!, 1)
        notifyPlayer(w.p1, 'matched', w.id, me.name)
        id = w.id
      } else id = insertGame(me.id, null, lang)
    } else {
      const o = get<PlayerRow>('SELECT * FROM players WHERE public_id=? AND deleted=0 AND is_bot=0', opponent)
      if (!o || o.id === me.id) throw new HttpError(404, 'unknown_player')
      if (!knows(me.id, o.id)) throw new HttpError(403, 'not_a_contact')
      // Ein laufendes Duell je Gegner: gibt es schon eins (egal wer es angelegt hat), wird dieses geöffnet statt ein weiteres anzulegen
      const open = get<{ id: number }>("SELECT id FROM games WHERE status IN ('waiting','active') AND ((p1=? AND p2=?) OR (p1=? AND p2=?)) ORDER BY updated_at DESC LIMIT 1", me.id, o.id, o.id, me.id)
      if (open) return open.id
      id = insertGame(me.id, o.id, lang)
      notifyPlayer(o.id, 'challenge', id, me.name)
    }
    settle(id)
    return id
  })
}

const isBot = (id: number | null) => !!id && !!get('SELECT 1 FROM players WHERE id=? AND is_bot=1', id)
const takeoverMs = () => config.duel.takeoverHours * 3_600_000

/** Darf `viewer` ein laufendes Duell mit einem Bot im Namen des untätigen Gegners fortsetzen? */
const canTakeOver = (g: GameRow, viewer: number) => {
  const opp = other(g, viewer)
  return g.status === 'active' && !!opp && g.turn === opp && !isBot(opp) && now() - g.updated_at >= takeoverMs()
}

/**
 * Wartet man seit `takeoverHours` auf den Gegner, kann man mit einem Bot weiterspielen: Der Bot ersetzt den Gegner im Spiel,
 * der bisherige Verlauf (Antworten, Rundenwahl) geht auf den Bot über. Der ersetzte Spieler wird benachrichtigt.
 */
export function takeOverWithBot(gameId: number, me: PlayerRow) {
  tx(() => {
    const g = mustGame(gameId, me.id)
    if (g.status !== 'active') throw new HttpError(409, 'not_waiting')
    if (!canTakeOver(g, me.id)) throw new HttpError(409, 'too_early')
    const opp = other(g, me.id)!, bot = ensureBot()
    run(g.p1 === opp ? 'UPDATE games SET p1=?, turn=?, updated_at=? WHERE id=?' : 'UPDATE games SET p2=?, turn=?, updated_at=? WHERE id=?', bot, bot, now(), g.id)
    run('UPDATE answers SET player_id=? WHERE game_id=? AND player_id=?', bot, g.id, opp)
    run('UPDATE rounds SET picker=? WHERE game_id=? AND picker=?', bot, g.id, opp)
    notifyPlayer(opp, 'replaced', g.id, me.name)
    settle(g.id)
  })
}

export function convertToBot(gameId: number, me: PlayerRow) {
  tx(() => {
    const g = mustGame(gameId, me.id)
    if (g.status !== 'waiting' || g.p1 !== me.id) throw new HttpError(409, 'not_waiting')
    run("UPDATE games SET p2=?, status='active' WHERE id=?", ensureBot(), g.id)
    startRound(getGame(g.id)!, 1)
    settle(g.id)
  })
}

interface RQ { question_id: number; perm: string }
function roundQuestions(gid: number, round: number) {
  return all<RQ & { idx: number }>('SELECT idx, question_id, perm FROM round_questions WHERE game_id=? AND round=? ORDER BY idx', gid, round)
}

function selectQuestions(g: GameRow, category: string) {
  const used = new Set(all<{ group_id: string }>(
    'SELECT q.group_id FROM round_questions rq JOIN questions q ON q.id=rq.question_id WHERE rq.game_id=?', g.id).map((r) => r.group_id))
  const seen = (pid: number | null) =>
    new Set(pid ? all<{ group_id: string }>('SELECT group_id FROM seen WHERE player_id=?', pid).map((r) => r.group_id) : [])
  const s1 = seen(g.p1), s2 = seen(g.p2)
  const allCands = all<Pick<QRow, 'id' | 'group_id' | 'difficulty'>>(
    `SELECT id, group_id, difficulty FROM questions WHERE lang=? AND category=? AND status='active' AND ${SERVABLE_SQL}`, g.lang, category)
  const fresh = allCands.filter((q) => !used.has(q.group_id))
  const cands = fresh.length >= PER_ROUND ? fresh : allCands
  const score = (q: { group_id: string }) => +s1.has(q.group_id) + +s2.has(q.group_id)
  const pool = shuffle(cands).sort((a, b) => score(a) - score(b)).slice(0, 12)
  const picked: typeof pool = []
  for (const d of shuffle([1, 2, 3])) {
    const q = pool.find((x) => x.difficulty === d && !picked.includes(x))
    if (q) picked.push(q)
  }
  for (const q of pool) if (picked.length < PER_ROUND && !picked.includes(q)) picked.push(q)
  return picked.slice(0, PER_ROUND).sort((a, b) => a.difficulty - b.difficulty)
}

function doPick(g: GameRow, pid: number, category: string) {
  if (g.status !== 'active' || g.phase !== 'pick' || g.turn !== pid) throw new HttpError(409, 'not_your_turn')
  const round = get<{ options: string }>('SELECT options FROM rounds WHERE game_id=? AND n=?', g.id, g.round)!
  if (!(JSON.parse(round.options) as string[]).includes(category)) throw new HttpError(400, 'bad_category')
  const qs = selectQuestions(g, category)
  if (qs.length < PER_ROUND) throw new HttpError(503, 'no_questions')
  qs.forEach((q, i) =>
    run('INSERT INTO round_questions(game_id,round,idx,question_id,perm) VALUES(?,?,?,?,?)',
      g.id, g.round, i, q.id, JSON.stringify(shuffle([0, 1, 2, 3]))))
  run('UPDATE rounds SET category=? WHERE game_id=? AND n=?', category, g.id, g.round)
  run("UPDATE games SET phase='play', updated_at=? WHERE id=?", now(), g.id)
}

export function pickCategory(gameId: number, me: PlayerRow, category: string) {
  tx(() => {
    doPick(mustGame(gameId, me.id), me.id, category)
    settle(gameId)
  })
}

const completed = (gid: number, round: number, pid: number) =>
  get<{ n: number }>('SELECT COUNT(*) n FROM answers WHERE game_id=? AND round=? AND player_id=? AND choice IS NOT NULL', gid, round, pid)!.n

function shownOptions(q: QRow, perm: number[]) {
  const all4 = [q.correct, ...(JSON.parse(q.wrong) as string[])]
  return perm.map((i) => all4[i])
}

export function currentQuestion(gameId: number, me: PlayerRow) {
  return tx(() => {
    for (;;) {
      const g = mustGame(gameId, me.id)
      if (g.status !== 'active' || g.phase !== 'play' || g.turn !== me.id) throw new HttpError(409, 'not_your_turn')
      const idx = completed(g.id, g.round, me.id)
      const rq = roundQuestions(g.id, g.round)[idx]
      const q = get<QRow>('SELECT * FROM questions WHERE id=?', rq.question_id)!
      let a = get<{ served_at: number }>('SELECT served_at FROM answers WHERE game_id=? AND round=? AND idx=? AND player_id=?', g.id, g.round, idx, me.id)
      if (!a) {
        run('INSERT INTO answers(game_id,round,idx,player_id,served_at) VALUES(?,?,?,?,?)', g.id, g.round, idx, me.id, now())
        a = { served_at: now() }
      }
      const elapsed = now() - a.served_at
      if (elapsed > TIME_LIMIT_MS + GRACE_MS) {
        recordAnswer(g, me.id, idx, -1, elapsed)
        settle(g.id)
        continue
      }
      const round = get<{ category: string }>('SELECT category FROM rounds WHERE game_id=? AND n=?', g.id, g.round)!
      return {
        idx, total: PER_ROUND, round: g.round, category: round.category,
        text: q.text, options: shownOptions(q, JSON.parse(rq.perm)),
        limit_ms: TIME_LIMIT_MS, remaining_ms: Math.max(0, TIME_LIMIT_MS - elapsed),
      }
    }
  })
}

function recordAnswer(g: GameRow, pid: number, idx: number, choice: number, ms: number) {
  const rq = roundQuestions(g.id, g.round)[idx]
  const q = get<QRow>('SELECT * FROM questions WHERE id=?', rq.question_id)!
  const perm = JSON.parse(rq.perm) as number[]
  const correctIdx = perm.indexOf(0)
  const correct = choice === correctIdx ? 1 : 0
  run(
    `INSERT INTO answers(game_id,round,idx,player_id,served_at,choice,correct,ms) VALUES(?,?,?,?,?,?,?,?)
     ON CONFLICT(game_id,round,idx,player_id) DO UPDATE SET choice=excluded.choice, correct=excluded.correct, ms=excluded.ms`,
    g.id, g.round, idx, pid, now() - ms, choice, correct, ms)
  run('INSERT OR IGNORE INTO seen(player_id,group_id) VALUES(?,?)', pid, q.group_id)
  if (completed(g.id, g.round, pid) >= PER_ROUND) endTurn(g, pid)
  return { correct: !!correct, correct_index: correctIdx, explanation: q.explanation, question_id: q.id }
}

export function submitAnswer(gameId: number, me: PlayerRow, idx: unknown, choice: unknown) {
  return tx(() => {
    const g = mustGame(gameId, me.id)
    if (g.status !== 'active' || g.phase !== 'play' || g.turn !== me.id) throw new HttpError(409, 'not_your_turn')
    if (!Number.isInteger(idx) || !Number.isInteger(choice) || (choice as number) < -1 || (choice as number) > 3) throw new HttpError(400, 'bad_answer')
    if (idx !== completed(g.id, g.round, me.id)) throw new HttpError(409, 'wrong_question')
    const a = get<{ served_at: number }>('SELECT served_at FROM answers WHERE game_id=? AND round=? AND idx=? AND player_id=?', g.id, g.round, idx as number, me.id)
    if (!a) throw new HttpError(409, 'not_served')
    const ms = now() - a.served_at
    const res = recordAnswer(g, me.id, idx as number, ms > TIME_LIMIT_MS + GRACE_MS ? -1 : (choice as number), Math.min(ms, TIME_LIMIT_MS))
    settle(g.id)
    return res
  })
}

function endTurn(g: GameRow, pid: number) {
  const round = get<{ picker: number }>('SELECT picker FROM rounds WHERE game_id=? AND n=?', g.id, g.round)!
  if (pid === round.picker) {
    run("UPDATE games SET turn=?, phase='play', updated_at=? WHERE id=?", other(g, pid), now(), g.id)
    notifyPlayer(other(g, pid), 'turn', g.id, nameOf(pid))
  } else if (g.round >= ROUNDS) {
    finishGame(g, 'completed', undefined, pid)
  } else {
    startRound(g, g.round + 1)
  }
}

function totals(gid: number) {
  return all<{ player_id: number; c: number; ms: number }>(
    'SELECT player_id, SUM(correct) c, SUM(ms) ms FROM answers WHERE game_id=? AND choice IS NOT NULL GROUP BY player_id', gid)
}

function finishGame(g: GameRow, reason: string, forcedWinner?: number, actor?: number) {
  const t = totals(g.id)
  const a = t.find((x) => x.player_id === g.p1)?.c ?? 0
  const b = t.find((x) => x.player_id === g.p2)?.c ?? 0
  const winner = forcedWinner ?? (a === b ? null : a > b ? g.p1 : g.p2)
  run("UPDATE games SET status='finished', turn=NULL, phase=NULL, winner=?, end_reason=?, updated_at=? WHERE id=?", winner, reason, now(), g.id)
  for (const pid of [g.p1, g.p2]) {
    if (!pid || pid === actor) continue
    const kind: PushKind = reason === 'resigned' ? 'resigned' : reason === 'timeout' ? 'timeout' : winner === null ? 'draw' : winner === pid ? 'won' : 'lost'
    notifyPlayer(pid, kind, g.id, nameOf(other(g, pid)))
  }
}

export function resign(gameId: number, me: PlayerRow) {
  tx(() => {
    const g = mustGame(gameId, me.id)
    if (g.status === 'waiting') run("UPDATE games SET status='abandoned', turn=NULL, phase=NULL, updated_at=? WHERE id=?", now(), g.id)
    else if (g.status === 'active') finishGame(g, 'resigned', other(g, me.id)!, me.id)
    else throw new HttpError(409, 'already_over')
  })
}

/** Frage-ID einer Frage, die `me` in diesem Spiel bereits beantwortet hat (Voraussetzung für Meldungen). */
export function answeredQuestionId(gameId: number, me: PlayerRow, round: unknown, idx: unknown): number {
  const g = mustGame(gameId, me.id)
  if (!Number.isInteger(round) || !Number.isInteger(idx)) throw new HttpError(400, 'bad_report')
  const answered = get('SELECT 1 FROM answers WHERE game_id=? AND round=? AND idx=? AND player_id=? AND choice IS NOT NULL', g.id, round as number, idx as number, me.id)
  const rq = roundQuestions(g.id, round as number)[idx as number]
  if (!answered || !rq) throw new HttpError(400, 'bad_report')
  return rq.question_id
}

export function reportQuestion(gameId: number, me: PlayerRow, round: unknown, idx: unknown, reason: unknown) {
  const questionId = answeredQuestionId(gameId, me, round, idx)
  run('INSERT OR IGNORE INTO reports(question_id,player_id,reason,created_at) VALUES(?,?,?,?)',
    questionId, me.id, String(reason ?? '').slice(0, 200), now())
  const n = get<{ n: number }>('SELECT COUNT(*) n FROM reports WHERE question_id=?', questionId)!.n
  if (n >= 3) run("UPDATE questions SET status='disabled' WHERE id=? AND status='active'", questionId)
}

/* ---------- Bot ---------- */
const BOT_SKILL: Record<number, number> = { 1: 0.85, 2: 0.65, 3: 0.45 }

function botTurn(g: GameRow) {
  const bot = g.turn!
  if (g.phase === 'pick') {
    const round = get<{ options: string }>('SELECT options FROM rounds WHERE game_id=? AND n=?', g.id, g.round)!
    doPick(g, bot, shuffle(JSON.parse(round.options) as string[])[0])
    return
  }
  const rqs = roundQuestions(g.id, g.round)
  for (let idx = completed(g.id, g.round, bot); idx < PER_ROUND; idx++) {
    const q = get<QRow>('SELECT * FROM questions WHERE id=?', rqs[idx].question_id)!
    const correctIdx = (JSON.parse(rqs[idx].perm) as number[]).indexOf(0)
    const choice = Math.random() < BOT_SKILL[q.difficulty] ? correctIdx : shuffle([0, 1, 2, 3].filter((i) => i !== correctIdx))[0]
    recordAnswer(getGame(g.id)!, bot, idx, choice, 2000 + crypto.randomInt(10_000))
  }
}

/** Lässt Bots ihre Züge spielen, bis ein Mensch dran ist. */
export function settle(gameId: number) {
  for (let i = 0; i < 20; i++) {
    const g = getGame(gameId)!
    if (g.status !== 'active' || !g.turn) return
    if (!get('SELECT 1 FROM players WHERE id=? AND is_bot=1', g.turn)) return
    botTurn(g)
  }
}

/* ---------- Sichten ---------- */
interface PInfo { id: number; name: string; public_id: string; is_bot: boolean }
const pinfo = (id: number | null): PInfo | null => {
  if (!id) return null
  const p = get<PlayerRow>('SELECT * FROM players WHERE id=?', id)!
  return { id: p.id, name: p.deleted ? '—' : p.name, public_id: p.public_id, is_bot: !!p.is_bot }
}

export function gameView(g: GameRow, viewer: number) {
  const oppId = other(g, viewer)
  const rounds = all<{ n: number; picker: number; category: string | null; options: string }>('SELECT * FROM rounds WHERE game_id=? ORDER BY n', g.id)
  const ans = all<{ round: number; idx: number; player_id: number; correct: number | null; choice: number | null }>(
    'SELECT round, idx, player_id, correct, choice FROM answers WHERE game_id=? AND choice IS NOT NULL', g.id)
  const mine = (round: number, idx: number) => ans.find((a) => a.round === round && a.idx === idx && a.player_id === viewer)
  const res = (round: number, pid: number | null, mineOnly: boolean) =>
    Array.from({ length: PER_ROUND }, (_, idx) => {
      const a = ans.find((x) => x.round === round && x.idx === idx && x.player_id === pid)
      if (!a) return null
      if (!mineOnly || g.status === 'finished' || mine(round, idx)) return !!a.correct
      return null
    })
  const view = rounds.map((r) => ({
    n: r.n, category: r.category, picker: r.picker === viewer ? 'me' : 'opp',
    me: res(r.n, viewer, false), opp: oppId ? res(r.n, oppId, true) : [null, null, null],
  }))
  const sum = (k: 'me' | 'opp') => view.reduce((s, r) => s + r[k].filter(Boolean).length, 0)
  const myTurn = g.turn === viewer
  return {
    id: g.id, status: g.status, lang: g.lang, round: g.round, rounds_total: ROUNDS, level: g.level ?? 'basic',
    phase: g.phase, turn: g.turn === null ? null : myTurn ? 'me' : 'opp',
    me: pinfo(viewer), opp: pinfo(oppId),
    options: myTurn && g.phase === 'pick' ? JSON.parse(rounds.find((r) => r.n === g.round)!.options) : null,
    rounds: view, score: { me: sum('me'), opp: sum('opp') },
    winner: g.status !== 'finished' ? null : g.winner === null ? 'draw' : g.winner === viewer ? 'me' : 'opp',
    end_reason: g.end_reason, created_at: g.created_at, updated_at: g.updated_at,
    can_takeover: canTakeOver(g, viewer), idle_hours: g.status === 'active' && oppId && g.turn === oppId ? Math.floor((now() - g.updated_at) / 3_600_000) : 0,
  }
}

export function getGameView(gameId: number, me: PlayerRow) {
  return gameView(mustGame(gameId, me.id), me.id)
}

const listItem = (g: GameRow, me: PlayerRow) => {
  const v = gameView(g, me.id)
  return { id: v.id, status: v.status, lang: v.lang, round: v.round, turn: v.turn, phase: v.phase, opp: v.opp,
    score: v.score, winner: v.winner, updated_at: v.updated_at }
}

/** Startseite: laufende und wartende Spiele, dazu je Gegner nur das zuletzt beendete Spiel; `history` zählt die älteren (Verlauf). */
export function listGames(me: PlayerRow) {
  const rows = all<GameRow>(
    `SELECT * FROM games g WHERE (p1=? OR p2=?) AND (status IN ('waiting','active') OR
       (status='finished' AND id = (SELECT h.id FROM games h WHERE h.status='finished' AND ((h.p1=g.p1 AND h.p2=g.p2) OR (h.p1=g.p2 AND h.p2=g.p1)) ORDER BY h.updated_at DESC, h.id DESC LIMIT 1)))
     ORDER BY updated_at DESC LIMIT 60`, me.id, me.id)
  const finished = get<{ n: number }>("SELECT COUNT(*) n FROM games WHERE (p1=? OR p2=?) AND status='finished'", me.id, me.id)!.n
  const shown = rows.filter((g) => g.status === 'finished').length
  return { games: rows.map((g) => listItem(g, me)), history: Math.max(0, finished - shown) }
}

/** Verlauf: alle beendeten Spiele (neueste zuerst, höchstens 100). */
export function listHistory(me: PlayerRow) {
  return all<GameRow>("SELECT * FROM games WHERE (p1=? OR p2=?) AND status='finished' ORDER BY updated_at DESC, id DESC LIMIT 100", me.id, me.id).map((g) => listItem(g, me))
}

/** Zeitüberschreitungen: Wartende Spiele verfallen, inaktive Spieler geben auf. */
export function sweep() {
  sweepLadders()
  tx(() => {
    const t = now()
    run("UPDATE games SET status='abandoned', turn=NULL, phase=NULL WHERE status='waiting' AND created_at<?", t - 86_400_000)
    const stale = all<GameRow>("SELECT * FROM games WHERE status='active' AND updated_at<?", t - config.duel.forfeitDays * 86_400_000)
    for (const g of stale) finishGame(g, 'timeout', other(g, g.turn!)!)
    // Erinnerung an die Person am Zug: einmal je Zug (`reminded_at` merkt sich den `updated_at`-Stand, für den erinnert wurde)
    const idle = all<GameRow>("SELECT * FROM games WHERE status='active' AND turn IS NOT NULL AND updated_at<? AND (reminded_at IS NULL OR reminded_at<>updated_at)", t - config.duel.remindHours * 3_600_000)
    for (const g of idle) {
      run('UPDATE games SET reminded_at=updated_at WHERE id=?', g.id)
      if (!isBot(g.turn)) notifyPlayer(g.turn, 'remind', g.id, nameOf(other(g, g.turn!)))
    }
  })
}
