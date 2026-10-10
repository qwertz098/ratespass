// Mehrspieler-Räume (asynchron): 2–6 Spieler spielen dieselben Fragen, jeder in seinem eigenen Tempo.
//  - Modus `quiz`: 12 Fragen (je 4 leicht/mittel/schwer), Wertung = richtige Antworten, bei Gleichstand die schnellere Gesamtzeit.
//  - Modus `ladder`: alle steigen dieselbe Millionen-Leiter hinauf (Regeln wie server/ladder.ts); Wertung = erreichter Betrag.
// Es gilt die niedrigste Einstellung aller Teilnehmer (Level, Schnitt der Extra-Kategorien), festgehalten beim Start.
// Andere Teilnehmer sehen bis zum Ende nur den Fortschritt, nie Antworten oder Punkte – so lässt sich nicht abschreiben.
import { SERVABLE_SQL } from './categories.ts'
import { all, get, run, tx, now } from './db.ts'
import { randomCode, type PlayerRow } from './auth.ts'
import { HttpError } from './http.ts'
import { notifyPlayer } from './push.ts'
import { effectiveFor } from './settings.ts'
import { GRACE_MS, PRIZES, SAFE_STEPS, difficultyOf, guaranteed, limitMs, prizeAt, shown, shuffle } from './ladder.ts'
import type { QRow } from './questions.ts'

export const MODES = ['quiz', 'ladder'] as const
type Mode = (typeof MODES)[number]
export const MAX_PLAYERS = 6
export const QUIZ_DIFFICULTIES = [1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3]
export const QUIZ_LIMIT_MS = 20_000
const DEADLINE_MS = 48 * 3_600_000
const LOBBY_TTL_MS = 24 * 3_600_000
const MAX_OPEN_ROOMS = 8

interface RoomRow {
  id: number; code: string; mode: Mode; lang: string; host: number; status: 'lobby' | 'active' | 'finished'
  level: string | null; cats: string | null; total: number; created_at: number; updated_at: number; deadline: number | null
}
interface RP { room_id: number; player_id: number; joined_at: number; pos: number; done: number; score: number; ms: number }

const limitFor = (r: RoomRow, idx: number) => (r.mode === 'quiz' ? QUIZ_LIMIT_MS : limitMs(idx + 1))
const nameOf = (id: number) => get<{ name: string }>('SELECT name FROM players WHERE id=?', id)?.name ?? ''
const members = (id: number) => all<RP>('SELECT * FROM room_players WHERE room_id=? ORDER BY joined_at', id)

function mustMember(roomId: number, pid: number) {
  const room = get<RoomRow>('SELECT * FROM rooms WHERE id=?', roomId)
  const rp = room && get<RP>('SELECT * FROM room_players WHERE room_id=? AND player_id=?', roomId, pid)
  if (!room || !rp) throw new HttpError(404, 'not_found')
  return { room, rp }
}

export function createRoom(me: PlayerRow, mode: unknown, lang: string): number {
  if (!MODES.includes(mode as Mode)) throw new HttpError(400, 'bad_mode')
  return tx(() => {
    const open = get<{ n: number }>("SELECT COUNT(*) n FROM room_players rp JOIN rooms r ON r.id=rp.room_id WHERE rp.player_id=? AND r.status<>'finished'", me.id)!.n
    if (open >= MAX_OPEN_ROOMS) throw new HttpError(429, 'too_many_rooms')
    const t = now()
    for (;;) {
      try {
        const r = run('INSERT INTO rooms(code,mode,lang,host,created_at,updated_at) VALUES(?,?,?,?,?,?)', randomCode(6), mode as string, lang, me.id, t, t)
        const id = Number(r.lastInsertRowid)
        run('INSERT INTO room_players(room_id,player_id,joined_at) VALUES(?,?,?)', id, me.id, t)
        return id
      } catch (e: any) { if (!String(e?.message).includes('UNIQUE')) throw e }
    }
  })
}

export function joinRoom(me: PlayerRow, rawCode: unknown): number {
  const code = String(rawCode ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12)
  return tx(() => {
    const room = get<RoomRow>('SELECT * FROM rooms WHERE code=?', code)
    if (!room) throw new HttpError(404, 'unknown_room')
    if (get('SELECT 1 FROM room_players WHERE room_id=? AND player_id=?', room.id, me.id)) return room.id
    if (room.status !== 'lobby') throw new HttpError(409, 'room_started')
    if (members(room.id).length >= MAX_PLAYERS) throw new HttpError(409, 'room_full')
    run('INSERT INTO room_players(room_id,player_id,joined_at) VALUES(?,?,?)', room.id, me.id, now())
    run('UPDATE rooms SET updated_at=? WHERE id=?', now(), room.id)
    return room.id
  })
}

export function leaveRoom(me: PlayerRow, roomId: number) {
  tx(() => {
    const { room } = mustMember(roomId, me.id)
    if (room.status !== 'lobby') throw new HttpError(409, 'room_started')
    if (room.host === me.id) run('DELETE FROM rooms WHERE id=?', room.id) // Gastgeber verlässt die Lobby: Raum wird aufgelöst
    else run('DELETE FROM room_players WHERE room_id=? AND player_id=?', room.id, me.id)
  })
}

/** Wählt je gewünschter Schwierigkeit eine Frage aus den Kategorien (bevorzugt solchen, die keiner der Spieler schon kennt). */
export function pickQuestions(lang: string, cats: string[], pids: number[], diffs: number[], exclude: Iterable<string> = []): QRow[] {
  const marks = cats.map(() => '?').join(',')
  const pool = all<QRow>(`SELECT * FROM questions WHERE lang=? AND status='active' AND ${SERVABLE_SQL} AND category IN (${marks})`, lang, ...cats)
  const seen = new Set(all<{ group_id: string }>(`SELECT DISTINCT group_id FROM seen WHERE player_id IN (${pids.map(() => '?').join(',')})`, ...pids).map((r) => r.group_id))
  const used = new Set<string>(exclude), out: QRow[] = []
  for (const want of diffs) {
    let pick: QRow | undefined
    for (const d of [want, want === 1 ? 2 : want - 1, 3, 2, 1]) {
      const c = pool.filter((q) => q.difficulty === d && !used.has(q.group_id))
      if (!c.length) continue
      const fresh = c.filter((q) => !seen.has(q.group_id))
      pick = shuffle(fresh.length ? fresh : c)[0]
      break
    }
    if (!pick) throw new HttpError(503, 'no_questions')
    used.add(pick.group_id); out.push(pick)
  }
  return out
}

export function startRoom(me: PlayerRow, roomId: number) {
  tx(() => {
    const { room } = mustMember(roomId, me.id)
    if (room.host !== me.id) throw new HttpError(403, 'not_host')
    if (room.status !== 'lobby') throw new HttpError(409, 'room_started')
    const ps = members(roomId)
    if (ps.length < 2) throw new HttpError(409, 'room_too_small')
    const eff = effectiveFor(ps.map((p) => p.player_id))
    const qs = pickQuestions(room.lang, eff.cats, ps.map((p) => p.player_id), room.mode === 'quiz' ? QUIZ_DIFFICULTIES : PRIZES.map((_, i) => difficultyOf(i + 1)))
    qs.forEach((q, i) => run('INSERT INTO room_questions(room_id,idx,question_id,perm) VALUES(?,?,?,?)', roomId, i, q.id, JSON.stringify(shuffle([0, 1, 2, 3]))))
    run("UPDATE rooms SET status='active', level=?, cats=?, total=?, deadline=?, updated_at=? WHERE id=?", eff.level, JSON.stringify(eff.cats), qs.length, now() + DEADLINE_MS, now(), roomId)
    for (const p of ps) if (p.player_id !== me.id) notifyPlayer(p.player_id, 'room_start', roomId, me.name)
  })
}

function recordAnswer(room: RoomRow, rp: RP, idx: number, choice: number, ms: number) {
  const rq = get<{ question_id: number; perm: string }>('SELECT question_id, perm FROM room_questions WHERE room_id=? AND idx=?', room.id, idx)!
  const q = get<QRow>('SELECT * FROM questions WHERE id=?', rq.question_id)!
  const correctIdx = (JSON.parse(rq.perm) as number[]).indexOf(0)
  const correct = choice === correctIdx
  run('UPDATE room_answers SET choice=?, correct=?, ms=? WHERE room_id=? AND idx=? AND player_id=?', choice, correct ? 1 : 0, ms, room.id, idx, rp.player_id)
  run('INSERT OR IGNORE INTO seen(player_id,group_id) VALUES(?,?)', rp.player_id, q.group_id)
  let score = rp.score, done = 0
  if (room.mode === 'quiz') {
    score += correct ? 1 : 0
    done = idx + 1 >= room.total ? 1 : 0
  } else if (correct) {
    score = PRIZES[idx]
    done = idx + 1 >= room.total ? 1 : 0
  } else { score = guaranteed(idx); done = 1 }
  run('UPDATE room_players SET pos=?, done=?, score=?, ms=ms+? WHERE room_id=? AND player_id=?', idx + 1, done, score, ms, room.id, rp.player_id)
  run('UPDATE rooms SET updated_at=? WHERE id=?', now(), room.id)
  if (done) checkFinished(room.id)
  return { correct, correct_index: correctIdx, explanation: q.explanation, question_id: q.id }
}

function checkFinished(roomId: number) {
  if (all('SELECT 1 FROM room_players WHERE room_id=? AND done=0', roomId).length === 0) finalize(roomId)
}

/** Beendet den Raum; wer noch nicht fertig ist, wird mit dem gesicherten Stand (Leiter) bzw. den bisherigen Punkten (Quiz) gewertet. */
function finalize(roomId: number) {
  const room = get<RoomRow>('SELECT * FROM rooms WHERE id=?', roomId)
  if (!room || room.status === 'finished') return
  if (room.mode === 'ladder') for (const p of members(roomId).filter((x) => !x.done)) run('UPDATE room_players SET score=? WHERE room_id=? AND player_id=?', guaranteed(p.pos), roomId, p.player_id)
  run("UPDATE room_players SET done=1 WHERE room_id=?", roomId)
  run("UPDATE rooms SET status='finished', updated_at=? WHERE id=?", now(), roomId)
  for (const p of members(roomId)) notifyPlayer(p.player_id, 'room_done', roomId, nameOf(room.host))
}

export function currentQuestion(roomId: number, me: PlayerRow) {
  const res = tx(() => {
    const { room, rp } = mustMember(roomId, me.id)
    if (room.status !== 'active' || rp.done) throw new HttpError(409, 'room_over')
    const idx = rp.pos
    const rq = get<{ question_id: number; perm: string }>('SELECT question_id, perm FROM room_questions WHERE room_id=? AND idx=?', room.id, idx)!
    let a = get<{ served_at: number }>('SELECT served_at FROM room_answers WHERE room_id=? AND idx=? AND player_id=?', room.id, idx, me.id)
    if (!a) {
      a = { served_at: now() }
      run('INSERT INTO room_answers(room_id,idx,player_id,served_at) VALUES(?,?,?,?)', room.id, idx, me.id, a.served_at)
    }
    const lim = limitFor(room, idx), elapsed = now() - a.served_at
    if (elapsed > lim + GRACE_MS) { recordAnswer(room, rp, idx, -1, lim); return null }
    const q = get<QRow>('SELECT * FROM questions WHERE id=?', rq.question_id)!
    return {
      step: idx + 1, total: room.total, prize: room.mode === 'ladder' ? PRIZES[idx] : null, category: q.category, text: q.text,
      options: shown(q, JSON.parse(rq.perm)), limit_ms: lim, remaining_ms: Math.max(0, lim - elapsed),
    }
  })
  if (!res) throw new HttpError(409, 'room_over')
  return res
}

export function submitAnswer(roomId: number, me: PlayerRow, step: unknown, choice: unknown) {
  return tx(() => {
    const { room, rp } = mustMember(roomId, me.id)
    if (room.status !== 'active' || rp.done) throw new HttpError(409, 'room_over')
    if (!Number.isInteger(step) || !Number.isInteger(choice) || (choice as number) < -1 || (choice as number) > 3) throw new HttpError(400, 'bad_answer')
    if (step !== rp.pos + 1) throw new HttpError(409, 'wrong_question')
    const a = get<{ served_at: number }>('SELECT served_at FROM room_answers WHERE room_id=? AND idx=? AND player_id=?', room.id, rp.pos, me.id)
    if (!a) throw new HttpError(409, 'not_served')
    const lim = limitFor(room, rp.pos), ms = now() - a.served_at
    const res = recordAnswer(room, rp, rp.pos, ms > lim + GRACE_MS ? -1 : (choice as number), Math.min(ms, lim))
    const mine = get<RP>('SELECT * FROM room_players WHERE room_id=? AND player_id=?', room.id, me.id)!
    return { ...res, over: !!mine.done, room: roomView(get<RoomRow>('SELECT * FROM rooms WHERE id=?', room.id)!, me.id) }
  })
}

/** Leiter-Modus: aussteigen und den aktuellen Betrag mitnehmen. */
export function quit(roomId: number, me: PlayerRow) {
  return tx(() => {
    const { room, rp } = mustMember(roomId, me.id)
    if (room.mode !== 'ladder') throw new HttpError(400, 'bad_mode')
    if (room.status !== 'active' || rp.done) throw new HttpError(409, 'room_over')
    run('UPDATE room_players SET done=1, score=? WHERE room_id=? AND player_id=?', prizeAt(rp.pos), room.id, me.id)
    checkFinished(room.id)
    return roomView(get<RoomRow>('SELECT * FROM rooms WHERE id=?', room.id)!, me.id)
  })
}

export function answeredQuestionId(roomId: number, me: PlayerRow, step: unknown): number {
  mustMember(roomId, me.id)
  if (!Number.isInteger(step)) throw new HttpError(400, 'bad_report')
  const r = get<{ question_id: number }>(
    `SELECT rq.question_id FROM room_answers a JOIN room_questions rq ON rq.room_id=a.room_id AND rq.idx=a.idx
     WHERE a.room_id=? AND a.idx=? AND a.player_id=? AND a.choice IS NOT NULL`, roomId, (step as number) - 1, me.id)
  if (!r) throw new HttpError(400, 'bad_report')
  return r.question_id
}

export function roomView(room: RoomRow, viewer: number) {
  const ps = members(room.id)
  const finished = room.status === 'finished'
  const rank = [...ps].sort((a, b) => b.score - a.score || a.ms - b.ms)
  const info = (p: RP) => {
    const pl = get<PlayerRow>('SELECT * FROM players WHERE id=?', p.player_id)!
    const reveal = finished || p.player_id === viewer // Punkte anderer erst nach Rundenende
    return {
      name: pl.deleted ? '—' : pl.name, public_id: pl.public_id, is_me: p.player_id === viewer, is_host: p.player_id === room.host,
      pos: p.pos, done: !!p.done, score: reveal ? p.score : null, ms: reveal ? p.ms : null, rank: finished ? rank.indexOf(p) + 1 : null,
    }
  }
  return {
    id: room.id, code: room.code, mode: room.mode, lang: room.lang, status: room.status, level: room.level, total: room.total,
    is_host: room.host === viewer, deadline: room.deadline, max_players: MAX_PLAYERS, players: ps.map(info),
    ...(room.mode === 'ladder' ? { prizes: PRIZES, safe_steps: SAFE_STEPS } : {}),
    created_at: room.created_at, updated_at: room.updated_at,
  }
}

export const getRoomView = (id: number, me: PlayerRow) => roomView(mustMember(id, me.id).room, me.id)

export function listRooms(me: PlayerRow) {
  const rows = all<RoomRow>(
    `SELECT r.* FROM rooms r JOIN room_players rp ON rp.room_id=r.id WHERE rp.player_id=? AND (r.status<>'finished' OR r.updated_at>?)
     ORDER BY r.updated_at DESC LIMIT 30`, me.id, now() - 7 * 86_400_000)
  return rows.map((r) => {
    const v = roomView(r, me.id)
    const mine = v.players.find((p) => p.is_me)!
    return { id: r.id, code: r.code, mode: r.mode, status: r.status, players: v.players.length, my_done: mine.done, my_rank: mine.rank, updated_at: r.updated_at }
  })
}

/** Aufräumen: verwaiste Lobbys verfallen, überfällige Runden werden mit dem aktuellen Stand gewertet. */
export function sweepRooms() {
  tx(() => {
    const t = now()
    run("DELETE FROM rooms WHERE status='lobby' AND updated_at<?", t - LOBBY_TTL_MS)
    for (const r of all<{ id: number }>("SELECT id FROM rooms WHERE status='active' AND deadline<?", t)) finalize(r.id)
  })
}

/** Konto gelöscht: Lobbys des Spielers verschwinden, laufende Runden werden für ihn beendet. */
export function forgetPlayer(pid: number) {
  tx(() => {
    run("DELETE FROM rooms WHERE host=? AND status='lobby'", pid)
    run("DELETE FROM room_players WHERE player_id=? AND room_id IN (SELECT id FROM rooms WHERE status='lobby')", pid)
    for (const r of all<{ room_id: number }>("SELECT rp.room_id FROM room_players rp JOIN rooms r ON r.id=rp.room_id WHERE rp.player_id=? AND r.status='active' AND rp.done=0", pid)) {
      run('UPDATE room_players SET done=1 WHERE room_id=? AND player_id=?', r.room_id, pid)
      checkFinished(r.room_id)
    }
  })
}
