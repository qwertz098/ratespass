// Live-Gesellschaftsspiel: alle spielen gleichzeitig, der Initiator (Host) leitet. Beitritt nur per QR-Code des Hosts
// (unratbarer Token, gilt nur in der Lobby und läuft ab). Echtzeit per Server-Sent Events; der Zustand liegt in SQLite, Zeitgeber
// laufen im Prozess und werden nach einem Neustart aus der Datenbank wieder aufgenommen (Einzelinstanz-Annahme).
//  - tempo: feste Zahl Fragen, richtig = 500–1000 Punkte je nach Tempo.
//  - survival: Millionen-Leiter-Schwierigkeit; wer falsch oder gar nicht antwortet, scheidet aus; Rest steigt weiter.
// Anzeige: `screen` = Host-Gerät zeigt Frage/Auswertung groß, Handys zeigen nur A–D; sonst zeigt jedes Handy die Frage.
// Die richtige Antwort wird erst in der Auflösungsphase gesendet.
import crypto from 'node:crypto'
import type http from 'node:http'
import { config } from './config.ts'
import { all, get, run, tx, now } from './db.ts'
import { HttpError } from './http.ts'
import { type PlayerRow } from './auth.ts'
import { effectiveFor } from './settings.ts'
import { PRIZES, difficultyOf, shown, shuffle } from './ladder.ts'
import { pickQuestions } from './rooms.ts'
import type { QRow } from './questions.ts'

export const MODES = ['tempo', 'survival'] as const
type Mode = (typeof MODES)[number]
const TEMPO_DIFFS = [1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 3]

interface Game {
  id: number; host: number; token: string; token_expires: number; status: 'lobby' | 'question' | 'reveal' | 'finished'; mode: Mode; screen: number
  lang: string; level: string | null; cats: string | null; total: number; idx: number; phase_started: number | null; phase_until: number | null
  created_at: number; updated_at: number
}
interface LP { game_id: number; player_id: number; score: number; alive: number; pos: number; ms: number; joined_at: number }

const getGame = (id: number) => get<Game>('SELECT * FROM live_games WHERE id=?', id)
const players = (id: number) => all<LP>('SELECT * FROM live_players WHERE game_id=? ORDER BY joined_at', id)
const newToken = () => crypto.randomBytes(12).toString('base64url')
const pname = (pid: number) => { const p = get<{ name: string; deleted: number }>('SELECT name, deleted FROM players WHERE id=?', pid); return !p || p.deleted ? '—' : p.name }

function mustMember(id: number, pid: number) {
  const g = getGame(id)
  if (!g || (g.host !== pid && !get('SELECT 1 FROM live_players WHERE game_id=? AND player_id=?', id, pid))) throw new HttpError(404, 'not_found')
  return g
}
function mustHost(id: number, pid: number) {
  const g = getGame(id)
  if (!g || g.host !== pid) throw new HttpError(404, 'not_found')
  return g
}

/* ---------- Abonnenten (SSE) ---------- */
interface Sub { res: http.ServerResponse; viewer: number }
const subs = new Map<number, Set<Sub>>()
const timers = new Map<number, ReturnType<typeof setTimeout>>()

export function subscribe(gameId: number, me: PlayerRow, res: http.ServerResponse) {
  const g = mustMember(gameId, me.id)
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' })
  res.write('retry: 2000\n\n')
  const sub: Sub = { res, viewer: me.id }
  if (!subs.has(gameId)) subs.set(gameId, new Set())
  subs.get(gameId)!.add(sub)
  send(sub, g)
  const ping = setInterval(() => { try { res.write(': ping\n\n') } catch { /* Verbindung weg */ } }, 15_000)
  res.on('close', () => { clearInterval(ping); subs.get(gameId)?.delete(sub) })
}
const send = (sub: Sub, g: Game) => { try { sub.res.write(`event: state\ndata: ${JSON.stringify(view(g, sub.viewer))}\n\n`) } catch { /* wird über close entfernt */ } }
function broadcast(gameId: number) {
  const g = getGame(gameId)
  if (!g) return
  for (const s of subs.get(gameId) ?? []) send(s, g)
}
export const closeAll = () => { for (const t of timers.values()) clearTimeout(t); timers.clear(); for (const set of subs.values()) for (const s of set) { try { s.res.end() } catch { /* */ } } subs.clear() }

/* ---------- Spiel anlegen / beitreten ---------- */
export function createLive(me: PlayerRow, mode: unknown, screen: unknown, lang: string): { id: number; token: string } {
  if (!MODES.includes(mode as Mode)) throw new HttpError(400, 'bad_mode')
  return tx(() => {
    for (const old of all<{ id: number }>("SELECT id FROM live_games WHERE host=? AND status<>'finished'", me.id)) finishGame(old.id) // pro Host nur ein laufendes Live-Spiel
    const t = now(), token = newToken()
    const id = Number(run('INSERT INTO live_games(host,token,token_expires,mode,screen,lang,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', me.id, token, t + config.live.joinTokenMs, mode as string, screen ? 1 : 0, lang, t, t).lastInsertRowid)
    if (!screen) run('INSERT INTO live_players(game_id,player_id,joined_at) VALUES(?,?,?)', id, me.id, t) // im Bildschirm-Modus spielt das Host-Gerät nicht mit
    return { id, token }
  })
}

export function joinByToken(me: PlayerRow, rawToken: unknown): number {
  const token = String(rawToken ?? '').slice(0, 64)
  const id = tx(() => {
    const g = get<Game>('SELECT * FROM live_games WHERE token=?', token)
    if (!g || g.status === 'finished') throw new HttpError(404, 'unknown_live')
    if (g.host === me.id || get('SELECT 1 FROM live_players WHERE game_id=? AND player_id=?', g.id, me.id)) return g.id // wieder verbinden ist immer erlaubt
    if (g.status !== 'lobby' || g.token_expires < now()) throw new HttpError(409, 'live_closed')
    if (players(g.id).length >= config.live.maxPlayers) throw new HttpError(409, 'live_full')
    run('INSERT INTO live_players(game_id,player_id,joined_at) VALUES(?,?,?)', g.id, me.id, now())
    return g.id
  })
  broadcast(id)
  return id
}

export function renewToken(me: PlayerRow, id: number) {
  const g = mustHost(id, me.id)
  if (g.status !== 'lobby') throw new HttpError(409, 'live_closed')
  run('UPDATE live_games SET token=?, token_expires=?, updated_at=? WHERE id=?', newToken(), now() + config.live.joinTokenMs, now(), id)
  broadcast(id)
}

export function configure(me: PlayerRow, id: number, opts: { mode?: unknown; screen?: unknown }) {
  const g = mustHost(id, me.id)
  if (g.status !== 'lobby') throw new HttpError(409, 'live_closed')
  if (opts.mode !== undefined) { if (!MODES.includes(opts.mode as Mode)) throw new HttpError(400, 'bad_mode'); run('UPDATE live_games SET mode=? WHERE id=?', opts.mode as string, id) }
  if (opts.screen !== undefined) {
    const screen = opts.screen ? 1 : 0
    run('UPDATE live_games SET screen=? WHERE id=?', screen, id)
    if (screen) run('DELETE FROM live_players WHERE game_id=? AND player_id=?', id, g.host)
    else run('INSERT OR IGNORE INTO live_players(game_id,player_id,joined_at) VALUES(?,?,?)', id, g.host, now())
  }
  broadcast(id)
}

export function kick(me: PlayerRow, id: number, publicId: unknown) {
  const g = mustHost(id, me.id)
  const p = get<{ id: number }>('SELECT id FROM players WHERE public_id=?', String(publicId ?? '').toUpperCase())
  if (!p || p.id === g.host) throw new HttpError(404, 'unknown_player')
  if (g.status === 'lobby') run('DELETE FROM live_players WHERE game_id=? AND player_id=?', id, p.id)
  else run('UPDATE live_players SET alive=0 WHERE game_id=? AND player_id=?', id, p.id)
  broadcast(id)
}

/* ---------- Ablauf ---------- */
export function start(me: PlayerRow, id: number) {
  tx(() => {
    const g = mustHost(id, me.id)
    if (g.status !== 'lobby') throw new HttpError(409, 'live_closed')
    const ps = players(id)
    if (ps.length < 2) throw new HttpError(409, 'live_too_small')
    const eff = effectiveFor(ps.map((p) => p.player_id))
    const diffs = g.mode === 'tempo' ? shuffle(TEMPO_DIFFS).slice(0, config.live.tempoQuestions).sort() : PRIZES.map((_, i) => difficultyOf(i + 1))
    const qs = pickQuestions(g.lang, eff.cats, ps.map((p) => p.player_id), diffs)
    qs.forEach((q, i) => run('INSERT INTO live_questions(game_id,idx,question_id,perm) VALUES(?,?,?,?)', id, i, q.id, JSON.stringify(shuffle([0, 1, 2, 3]))))
    run("UPDATE live_games SET level=?, cats=?, total=?, token_expires=0, updated_at=? WHERE id=?", eff.level, JSON.stringify(eff.cats), qs.length, now(), id)
    openQuestion(id, 0)
  })
  broadcast(id)
}

function schedule(id: number, at: number, fn: () => void) {
  const old = timers.get(id)
  if (old) clearTimeout(old)
  timers.set(id, setTimeout(() => { timers.delete(id); try { fn(); broadcast(id) } catch (e) { console.error('live', e) } }, Math.max(0, at - now())))
}

function openQuestion(id: number, idx: number) {
  const t = now(), until = t + config.live.questionMs
  run("UPDATE live_games SET status='question', idx=?, phase_started=?, phase_until=?, updated_at=? WHERE id=?", idx, t, until, t, id)
  schedule(id, until, () => closeQuestion(id))
}

const eligible = (g: Game) => players(g.id).filter((p) => (g.mode === 'survival' ? p.alive : true))

/** Frage beenden → Auflösung: Punkte und Ausscheiden werden hier festgeschrieben. */
function closeQuestion(id: number) {
  tx(() => {
    const g = getGame(id)
    if (!g || g.status !== 'question') return
    for (const p of eligible(g)) {
      const a = get<{ correct: number; points: number; ms: number }>('SELECT correct, points, ms FROM live_answers WHERE game_id=? AND idx=? AND player_id=?', id, g.idx, p.player_id)
      const ok = !!a?.correct
      if (g.mode === 'tempo') run('UPDATE live_players SET score=score+?, ms=ms+? WHERE game_id=? AND player_id=?', a?.points ?? 0, a?.ms ?? config.live.questionMs, id, p.player_id)
      else if (ok) run('UPDATE live_players SET pos=?, ms=ms+? WHERE game_id=? AND player_id=?', g.idx + 1, a!.ms, id, p.player_id)
      else run('UPDATE live_players SET alive=0, ms=ms+? WHERE game_id=? AND player_id=?', a?.ms ?? config.live.questionMs, id, p.player_id)
    }
    const until = now() + config.live.revealMs
    run("UPDATE live_games SET status='reveal', phase_started=?, phase_until=?, updated_at=? WHERE id=?", now(), until, now(), id)
    schedule(id, until, () => afterReveal(id))
  })
}

function afterReveal(id: number) {
  const g = getGame(id)
  if (!g || g.status !== 'reveal') return
  const alive = players(id).filter((p) => p.alive).length
  const last = g.idx + 1 >= g.total || (g.mode === 'survival' && alive <= 1)
  if (last) finishGame(id)
  else openQuestion(id, g.idx + 1)
}

function finishGame(id: number) {
  const t = timers.get(id); if (t) clearTimeout(t); timers.delete(id)
  run("UPDATE live_games SET status='finished', phase_until=NULL, token_expires=0, updated_at=? WHERE id=?", now(), id)
}

/** Host: Frage sofort beenden bzw. Auflösung überspringen; im Zustand „Auflösung“ geht es zur nächsten Frage. */
export function next(me: PlayerRow, id: number) {
  tx(() => {
    const g = mustHost(id, me.id)
    if (g.status === 'question') closeQuestion(id)
    else if (g.status === 'reveal') afterReveal(id)
    else throw new HttpError(409, 'live_closed')
  })
  broadcast(id)
}
export function end(me: PlayerRow, id: number) {
  mustHost(id, me.id)
  finishGame(id)
  broadcast(id)
}

export function answer(me: PlayerRow, id: number, idx: unknown, choice: unknown) {
  tx(() => {
    const g = mustMember(id, me.id)
    const p = players(id).find((x) => x.player_id === me.id)
    if (!p || g.status !== 'question' || (g.mode === 'survival' && !p.alive)) throw new HttpError(409, 'live_closed')
    if (idx !== g.idx || !Number.isInteger(choice) || (choice as number) < 0 || (choice as number) > 3) throw new HttpError(400, 'bad_answer')
    if (get('SELECT 1 FROM live_answers WHERE game_id=? AND idx=? AND player_id=?', id, g.idx, me.id)) throw new HttpError(409, 'already_answered')
    const rq = get<{ question_id: number; perm: string }>('SELECT question_id, perm FROM live_questions WHERE game_id=? AND idx=?', id, g.idx)!
    const ms = Math.min(config.live.questionMs, now() - g.phase_started!)
    const correct = (JSON.parse(rq.perm) as number[]).indexOf(0) === choice
    const points = g.mode === 'tempo' && correct ? Math.round(1000 * (1 - 0.5 * ms / config.live.questionMs)) : 0
    run('INSERT INTO live_answers(game_id,idx,player_id,choice,ms,correct,points,at) VALUES(?,?,?,?,?,?,?,?)', id, g.idx, me.id, choice as number, ms, correct ? 1 : 0, points, now())
    run('INSERT OR IGNORE INTO seen(player_id,group_id) SELECT ?, group_id FROM questions WHERE id=?', me.id, rq.question_id)
    // Alle Berechtigten haben geantwortet → früher auflösen
    const answered = get<{ n: number }>('SELECT COUNT(*) n FROM live_answers WHERE game_id=? AND idx=?', id, g.idx)!.n
    if (answered >= eligible(g).length) closeQuestion(id)
  })
  broadcast(id)
}

/* ---------- Sichten ---------- */
export function view(g: Game, viewer: number) {
  const ps = players(g.id)
  const isHost = g.host === viewer
  const rq = g.idx >= 0 ? get<{ question_id: number; perm: string }>('SELECT question_id, perm FROM live_questions WHERE game_id=? AND idx=?', g.id, g.idx) : undefined
  const q = rq && get<QRow>('SELECT * FROM questions WHERE id=?', rq.question_id)
  const answers = g.idx >= 0 ? all<{ player_id: number; choice: number; correct: number; points: number; ms: number }>('SELECT player_id, choice, correct, points, ms FROM live_answers WHERE game_id=? AND idx=?', g.id, g.idx) : []
  const reveal = g.status === 'reveal' || g.status === 'finished'
  const rank = [...ps].sort(g.mode === 'tempo' ? (a, b) => b.score - a.score || a.ms - b.ms : (a, b) => b.pos - a.pos || b.alive - a.alive || a.ms - b.ms)
  const mine = answers.find((a) => a.player_id === viewer)
  const correctIdx = rq ? (JSON.parse(rq.perm) as number[]).indexOf(0) : -1
  return {
    id: g.id, status: g.status, mode: g.mode, screen: !!g.screen, lang: g.lang, level: g.level, total: g.total, idx: g.idx, is_host: isHost,
    now: now(), phase_until: g.phase_until, limit_ms: config.live.questionMs,
    token: isHost && g.status === 'lobby' ? g.token : null, token_expires: isHost && g.status === 'lobby' ? g.token_expires : null,
    max_players: config.live.maxPlayers,
    players: rank.map((p, i) => ({ name: pname(p.player_id), public_id: isHost ? get<{ public_id: string }>('SELECT public_id FROM players WHERE id=?', p.player_id)!.public_id : undefined,
      score: p.score, pos: p.pos, alive: !!p.alive, rank: i + 1, is_me: p.player_id === viewer, answered: g.status === 'question' ? answers.some((a) => a.player_id === p.player_id) : undefined })),
    me: ps.some((p) => p.player_id === viewer) ? {
      answered: !!mine, choice: mine && reveal ? mine.choice : undefined, correct: mine && reveal ? !!mine.correct : undefined, points: mine && reveal ? mine.points : undefined,
      alive: !!ps.find((p) => p.player_id === viewer)!.alive, score: ps.find((p) => p.player_id === viewer)!.score, rank: rank.findIndex((p) => p.player_id === viewer) + 1,
    } : null,
    question: q && (g.status === 'question' || reveal) ? {
      text: q.text, options: shown(q, JSON.parse(rq!.perm)), category: q.category,
      ...(reveal ? { correct_index: correctIdx, explanation: q.explanation, counts: [0, 1, 2, 3].map((c) => answers.filter((a) => a.choice === c).length) } : {}),
      prize: g.mode === 'survival' ? PRIZES[g.idx] : null,
    } : null,
  }
}
export const getView = (id: number, me: PlayerRow) => view(mustMember(id, me.id), me.id)

/* ---------- Betrieb ---------- */
/** Nach einem Neustart laufende Spiele fortsetzen (Zeitgeber neu setzen). */
export function resumeLive() {
  for (const g of all<Game>("SELECT * FROM live_games WHERE status IN ('question','reveal')")) {
    if (g.status === 'question') schedule(g.id, g.phase_until ?? now(), () => closeQuestion(g.id))
    else schedule(g.id, g.phase_until ?? now(), () => afterReveal(g.id))
  }
}

/** Aufräumen: alte Lobbys und beendete Spiele verschwinden. */
export function sweepLive() {
  const t = now()
  run("DELETE FROM live_games WHERE (status='lobby' AND created_at<?) OR (status='finished' AND updated_at<?) OR (status IN ('question','reveal') AND updated_at<?)", t - 3 * 3_600_000, t - 24 * 3_600_000, t - 6 * 3_600_000)
}
