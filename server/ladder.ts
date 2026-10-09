// Millionen-Leiter (Solo): 15 Fragen mit steigender Schwierigkeit, Sicherheitsstufen bei Frage 5 und 10, Aussteigen.
// Angelehnt an das bekannte Fernsehformat, aber mit eigenem Namen, eigener Währung und ohne Joker.
// Der Server bestimmt Fragen und Zeit; die richtige Antwort wird erst nach der Antwort verraten.
import crypto from 'node:crypto'
import { SERVABLE_SQL } from './categories.ts'
import { all, get, run, tx, now } from './db.ts'
import type { PlayerRow } from './auth.ts'
import { HttpError } from './http.ts'
import { effectiveFor } from './settings.ts'
import type { QRow } from './questions.ts'

export const PRIZES = [100, 200, 300, 500, 1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 125_000, 250_000, 500_000, 1_000_000] as const
export const STEPS = PRIZES.length
export const SAFE_STEPS = [5, 10] as const
const GRACE_MS = 4_000
/** Zeit je Frage in ms: Fragen 1–5 30 s, 6–10 45 s, 11–15 60 s. */
export const limitMs = (step: number) => (step <= 5 ? 30_000 : step <= 10 ? 45_000 : 60_000)
/** Schwierigkeit der Frage: 1–5 leicht, 6–10 mittel, 11–15 schwer. */
export const difficultyOf = (step: number) => (step <= 5 ? 1 : step <= 10 ? 2 : 3)

export interface LadderRow {
  id: number; player_id: number; lang: string; level: string; cats: string
  step: number; status: 'active' | 'won' | 'lost' | 'quit' | 'abandoned'; prize: number | null; created_at: number; updated_at: number
}

const shuffle = <T>(a: T[]): T[] => {
  const r = [...a]
  for (let i = r.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [r[i], r[j]] = [r[j], r[i]] }
  return r
}

const prizeAt = (answered: number) => (answered > 0 ? PRIZES[answered - 1] : 0)
/** Gesicherter Betrag, wenn die nächste Frage (Nr. answered+1) falsch beantwortet wird. */
export const guaranteed = (answered: number) => prizeAt(Math.max(0, ...SAFE_STEPS.filter((s) => s <= answered)))

function mustLadder(id: number, pid: number): LadderRow {
  const l = get<LadderRow>('SELECT * FROM ladders WHERE id=?', id)
  if (!l || l.player_id !== pid) throw new HttpError(404, 'not_found')
  return l
}

function finish(l: LadderRow, status: 'won' | 'lost' | 'quit' | 'abandoned', prize: number) {
  run('UPDATE ladders SET status=?, prize=?, updated_at=? WHERE id=?', status, prize, now(), l.id)
  run('UPDATE players SET best_ladder=MAX(best_ladder, ?) WHERE id=?', prize, l.player_id)
}

export function startLadder(me: PlayerRow, lang: string): number {
  return tx(() => {
    const open = get<{ id: number }>("SELECT id FROM ladders WHERE player_id=? AND status='active' ORDER BY id DESC LIMIT 1", me.id)
    if (open) return open.id // eine laufende Leiter wird fortgesetzt
    const eff = effectiveFor([me.id])
    const t = now()
    const r = run('INSERT INTO ladders(player_id,lang,level,cats,created_at,updated_at) VALUES(?,?,?,?,?,?)', me.id, lang, eff.level, JSON.stringify(eff.cats), t, t)
    return Number(r.lastInsertRowid)
  })
}

function pickQuestion(l: LadderRow, step: number): QRow {
  const cats = JSON.parse(l.cats) as string[]
  const used = new Set(all<{ group_id: string }>(
    'SELECT q.group_id FROM ladder_steps s JOIN questions q ON q.id=s.question_id WHERE s.ladder_id=?', l.id).map((r) => r.group_id))
  const seen = new Set(all<{ group_id: string }>('SELECT group_id FROM seen WHERE player_id=?', l.player_id).map((r) => r.group_id))
  const marks = cats.map(() => '?').join(',')
  const base = `SELECT * FROM questions WHERE lang=? AND status='active' AND ${SERVABLE_SQL} AND category IN (${marks})`
  const want = difficultyOf(step)
  for (const diff of [want, want === 1 ? 2 : want - 1, 3, 2, 1]) {
    const cands = all<QRow>(base + ' AND difficulty=?', l.lang, ...cats, diff).filter((q) => !used.has(q.group_id))
    if (!cands.length) continue
    const fresh = cands.filter((q) => !seen.has(q.group_id))
    return shuffle(fresh.length ? fresh : cands)[0]
  }
  throw new HttpError(503, 'no_questions')
}

const shown = (q: QRow, perm: number[]) => {
  const all4 = [q.correct, ...(JSON.parse(q.wrong) as string[])]
  return perm.map((i) => all4[i])
}

export function ladderView(l: LadderRow) {
  const steps = all<{ step: number; correct: number | null; choice: number | null }>('SELECT step, correct, choice FROM ladder_steps WHERE ladder_id=? ORDER BY step', l.id)
  return {
    id: l.id, status: l.status, lang: l.lang, level: l.level, answered: l.step,
    current: l.status === 'active' ? l.step + 1 : null,
    prizes: PRIZES, safe_steps: SAFE_STEPS, guaranteed: l.status === 'active' ? guaranteed(l.step) : null,
    banked: l.status === 'active' ? prizeAt(l.step) : null, // Betrag beim Aussteigen vor der nächsten Frage
    prize: l.prize, history: steps.filter((s) => s.choice !== null).map((s) => ({ step: s.step, correct: !!s.correct })),
  }
}

export const getLadderView = (id: number, me: PlayerRow) => ladderView(mustLadder(id, me.id))

function recordAnswer(l: LadderRow, step: number, choice: number, ms: number) {
  const s = get<{ question_id: number; perm: string }>('SELECT question_id, perm FROM ladder_steps WHERE ladder_id=? AND step=?', l.id, step)!
  const q = get<QRow>('SELECT * FROM questions WHERE id=?', s.question_id)!
  const correctIdx = (JSON.parse(s.perm) as number[]).indexOf(0)
  const correct = choice === correctIdx
  run('UPDATE ladder_steps SET choice=?, correct=?, ms=? WHERE ladder_id=? AND step=?', choice, correct ? 1 : 0, ms, l.id, step)
  run('INSERT OR IGNORE INTO seen(player_id,group_id) VALUES(?,?)', l.player_id, q.group_id)
  if (!correct) finish(l, 'lost', guaranteed(l.step))
  else if (step >= STEPS) { run('UPDATE ladders SET step=? WHERE id=?', step, l.id); finish({ ...l, step }, 'won', PRIZES[STEPS - 1]) }
  else run('UPDATE ladders SET step=?, updated_at=? WHERE id=?', step, now(), l.id)
  return { correct, correct_index: correctIdx, explanation: q.explanation, question_id: q.id }
}

export function currentQuestion(id: number, me: PlayerRow) {
  const res = tx(() => {
    const l = mustLadder(id, me.id)
    if (l.status !== 'active') throw new HttpError(409, 'ladder_over')
    const step = l.step + 1
    let s = get<{ question_id: number; perm: string; served_at: number }>('SELECT question_id, perm, served_at FROM ladder_steps WHERE ladder_id=? AND step=?', l.id, step)
    if (!s) {
      const q = pickQuestion(l, step)
      s = { question_id: q.id, perm: JSON.stringify(shuffle([0, 1, 2, 3])), served_at: now() }
      run('INSERT INTO ladder_steps(ladder_id,step,question_id,perm,served_at) VALUES(?,?,?,?,?)', l.id, step, s.question_id, s.perm, s.served_at)
    }
    const elapsed = now() - s.served_at
    if (elapsed > limitMs(step) + GRACE_MS) { recordAnswer(l, step, -1, elapsed); return null } // Zeit abgelaufen: als falsch werten (Ausnahme erst nach dem Commit)
    const q = get<QRow>('SELECT * FROM questions WHERE id=?', s.question_id)!
    return {
      step, total: STEPS, prize: PRIZES[step - 1], category: q.category, text: q.text, options: shown(q, JSON.parse(s.perm)),
      limit_ms: limitMs(step), remaining_ms: Math.max(0, limitMs(step) - elapsed),
    }
  })
  if (!res) throw new HttpError(409, 'ladder_over')
  return res
}

export function submitAnswer(id: number, me: PlayerRow, step: unknown, choice: unknown) {
  return tx(() => {
    const l = mustLadder(id, me.id)
    if (l.status !== 'active') throw new HttpError(409, 'ladder_over')
    if (!Number.isInteger(step) || !Number.isInteger(choice) || (choice as number) < -1 || (choice as number) > 3) throw new HttpError(400, 'bad_answer')
    if (step !== l.step + 1) throw new HttpError(409, 'wrong_question')
    const s = get<{ served_at: number; choice: number | null }>('SELECT served_at, choice FROM ladder_steps WHERE ladder_id=? AND step=?', l.id, step as number)
    if (!s) throw new HttpError(409, 'not_served')
    const ms = now() - s.served_at
    const lim = limitMs(step as number)
    const res = recordAnswer(l, step as number, ms > lim + GRACE_MS ? -1 : (choice as number), Math.min(ms, lim))
    return { ...res, ladder: ladderView(get<LadderRow>('SELECT * FROM ladders WHERE id=?', id)!) }
  })
}

/** Aussteigen: der Betrag der zuletzt richtig beantworteten Frage wird mitgenommen. */
export function quit(id: number, me: PlayerRow) {
  return tx(() => {
    const l = mustLadder(id, me.id)
    if (l.status !== 'active') throw new HttpError(409, 'ladder_over')
    finish(l, 'quit', prizeAt(l.step))
    return ladderView(get<LadderRow>('SELECT * FROM ladders WHERE id=?', id)!)
  })
}

/** Frage-ID eines bereits beantworteten Leiter-Schritts (Voraussetzung für Meldungen/Reviews). */
export function answeredQuestionId(id: number, me: PlayerRow, step: unknown): number {
  mustLadder(id, me.id)
  if (!Number.isInteger(step)) throw new HttpError(400, 'bad_report')
  const s = get<{ question_id: number }>('SELECT question_id FROM ladder_steps WHERE ladder_id=? AND step=? AND choice IS NOT NULL', id, step as number)
  if (!s) throw new HttpError(400, 'bad_report')
  return s.question_id
}

/** Seit über 24 Stunden unberührte Leitern verfallen; gewertet wird der gesicherte Betrag. */
export function sweepLadders() {
  tx(() => {
    for (const l of all<LadderRow>("SELECT * FROM ladders WHERE status='active' AND updated_at<?", now() - 86_400_000)) finish(l, 'abandoned', guaranteed(l.step))
  })
}
