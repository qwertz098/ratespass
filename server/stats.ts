// Auswertung „Lösungen vs. Alter“: Wie oft wird eine Frage richtig beantwortet, insgesamt und je Altersgruppe?
// Grundlage sind alle Antworten menschlicher Spieler aus Duellen, Millionen-Leiter und Mehrspieler-Runden.
// Das Geburtsjahr ist freiwillig und wird nur als Jahr gespeichert; Altersgruppen mit weniger als MIN_GROUP Antworten
// werden nicht ausgewiesen, damit keine Einzelpersonen erkennbar werden. Auswertung nur für den Admin.
import { all, db, get } from './db.ts'
import { HttpError } from './http.ts'
import { CATEGORIES } from './categories.ts'

export const MIN_GROUP = 5
/** Gemessene Lösungsquote → Schwierigkeit (bei 4 Antworten liegt die Ratequote bei 25 %). */
export const EASY_RATE = 0.75
export const MEDIUM_RATE = 0.5
export const BANDS = ['<18', '18-29', '30-44', '45-59', '60+', '?'] as const
const BAND_SQL = `CASE WHEN p.birth_year IS NULL THEN '?'
  WHEN :year - p.birth_year < 18 THEN '<18' WHEN :year - p.birth_year < 30 THEN '18-29' WHEN :year - p.birth_year < 45 THEN '30-44'
  WHEN :year - p.birth_year < 60 THEN '45-59' ELSE '60+' END`

export function cleanBirthYear(v: unknown): number | null {
  if (v === null || v === '' ) return null
  const y = Number(v), now = new Date().getFullYear()
  if (!Number.isInteger(y) || y < 1900 || y > now - 5) throw new HttpError(400, 'bad_birth_year')
  return y
}

/** Alle gewerteten Antworten: Frage-ID, Spieler, richtig/falsch, Zeit. Zeitüberschreitungen zählen als falsch. */
const ANSWERS = `
  SELECT rq.question_id qid, a.player_id pid, a.correct ok, a.ms ms FROM answers a
    JOIN round_questions rq ON rq.game_id=a.game_id AND rq.round=a.round AND rq.idx=a.idx WHERE a.choice IS NOT NULL
  UNION ALL SELECT s.question_id, l.player_id, s.correct, s.ms FROM ladder_steps s JOIN ladders l ON l.id=s.ladder_id WHERE s.choice IS NOT NULL
  UNION ALL SELECT rq.question_id, a.player_id, a.correct, a.ms FROM room_answers a
    JOIN room_questions rq ON rq.room_id=a.room_id AND rq.idx=a.idx WHERE a.choice IS NOT NULL`
const year = () => ({ year: new Date().getFullYear() })
/** SQL mit benannten Parametern (:name); es werden nur die Parameter übergeben, die im Text vorkommen. */
const named = <T>(sql: string, params: Record<string, string | number>): T[] =>
  db.prepare(sql).all(Object.fromEntries(Object.entries(params).filter(([k]) => sql.includes(':' + k)))) as unknown as T[]

const rate = (ok: number, n: number) => (n ? Math.round((ok / n) * 1000) / 1000 : null)
const hidden = (n: number) => n < MIN_GROUP

export function overview() {
  const y = year()
  const base = `FROM (${ANSWERS}) x JOIN questions q ON q.id=x.qid JOIN players p ON p.id=x.pid WHERE p.is_bot=0`
  const byDiff = named<{ difficulty: number; n: number; ok: number }>(`SELECT q.difficulty, COUNT(*) n, SUM(x.ok) ok ${base} GROUP BY q.difficulty ORDER BY q.difficulty`, y)
  const matrix = named<{ difficulty: number; band: string; n: number; ok: number }>(
    `SELECT q.difficulty, ${BAND_SQL} band, COUNT(*) n, SUM(x.ok) ok ${base} GROUP BY q.difficulty, band`, y)
  const byCat = named<{ category: string; n: number; ok: number }>(`SELECT q.category, COUNT(*) n, SUM(x.ok) ok ${base} GROUP BY q.category ORDER BY q.category`, y)
  const players = get<{ total: number; with_year: number }>('SELECT COUNT(*) total, SUM(birth_year IS NOT NULL) with_year FROM players WHERE is_bot=0 AND deleted=0')!
  return {
    min_group: MIN_GROUP, thresholds: { easy: EASY_RATE, medium: MEDIUM_RATE }, bands: BANDS,
    players: { total: players.total, with_year: players.with_year ?? 0 },
    by_difficulty: byDiff.map((r) => ({ difficulty: r.difficulty, n: r.n, rate: rate(r.ok, r.n) })),
    by_difficulty_age: matrix.map((r) => ({ difficulty: r.difficulty, band: r.band, n: hidden(r.n) ? null : r.n, rate: hidden(r.n) ? null : rate(r.ok, r.n) })),
    by_category: byCat.filter((r) => (CATEGORIES as readonly string[]).includes(r.category)).map((r) => ({ category: r.category, n: r.n, rate: rate(r.ok, r.n) })),
  }
}

export const suggestionFor = (r: number | null, n: number, minN: number): 1 | 2 | 3 | null =>
  r === null || n < minN ? null : r >= EASY_RATE ? 1 : r >= MEDIUM_RATE ? 2 : 3

interface Opts { category?: string; lang?: string; difficulty?: number; minN: number; sort: string; limit: number }

/** Je Fragengruppe (alle Sprachen zusammen, da die Schwierigkeit gruppenweit gilt). */
export function questionStats(o: Opts) {
  const y = year()
  const where = ['p.is_bot=0']
  const args: Record<string, string | number> = { ...y }
  if (o.category) { where.push('q.category=:cat'); args.cat = o.category }
  if (o.lang) { where.push('q.lang=:lang'); args.lang = o.lang }
  if (o.difficulty) { where.push('q.difficulty=:diff'); args.diff = o.difficulty }
  const rows = named<{ group_id: string; qid: number; text: string; category: string; difficulty: number; n: number; ok: number; ms: number }>(
    `SELECT q.group_id, MIN(q.id) qid, q.text, q.category, q.difficulty, COUNT(*) n, SUM(x.ok) ok, AVG(x.ms) ms
     FROM (${ANSWERS}) x JOIN questions q ON q.id=x.qid JOIN players p ON p.id=x.pid WHERE ${where.join(' AND ')}
     GROUP BY q.group_id HAVING COUNT(*) >= :minN`, { ...args, minN: o.minN })
  const ages = named<{ group_id: string; band: string; n: number; ok: number }>(
    `SELECT q.group_id, ${BAND_SQL} band, COUNT(*) n, SUM(x.ok) ok
     FROM (${ANSWERS}) x JOIN questions q ON q.id=x.qid JOIN players p ON p.id=x.pid WHERE ${where.join(' AND ')} GROUP BY q.group_id, band`, args)
  const byGroup = new Map<string, Record<string, { n: number | null; rate: number | null }>>()
  for (const a of ages) {
    const m = byGroup.get(a.group_id) ?? {}
    m[a.band] = hidden(a.n) ? { n: null, rate: null } : { n: a.n, rate: rate(a.ok, a.n) }
    byGroup.set(a.group_id, m)
  }
  const list = rows.map((r) => {
    const rt = rate(r.ok, r.n)
    const suggested = suggestionFor(rt, r.n, Math.max(10, o.minN))
    return { group_id: r.group_id, id: r.qid, text: r.text, category: r.category, difficulty: r.difficulty, n: r.n, rate: rt, avg_ms: Math.round(r.ms), by_age: byGroup.get(r.group_id) ?? {}, suggested, gap: suggested ? Math.abs(suggested - r.difficulty) : 0 }
  })
  const sorters: Record<string, (a: (typeof list)[number], b: (typeof list)[number]) => number> = {
    gap: (a, b) => b.gap - a.gap || b.n - a.n, n: (a, b) => b.n - a.n, rate: (a, b) => (a.rate ?? 0) - (b.rate ?? 0),
  }
  list.sort(sorters[o.sort] ?? sorters.gap)
  return { min_group: MIN_GROUP, questions: list.slice(0, o.limit), total: list.length }
}

/** Empfohlene Schwierigkeit einer Gruppe aus den Messwerten (null: zu wenige Antworten). */
export function suggestDifficulty(groupId: string, minN: number): 1 | 2 | 3 | null {
  const r = get<{ n: number; ok: number }>(
    `SELECT COUNT(*) n, SUM(x.ok) ok FROM (${ANSWERS}) x JOIN questions q ON q.id=x.qid JOIN players p ON p.id=x.pid WHERE p.is_bot=0 AND q.group_id=?`, groupId)
  return r && r.n ? suggestionFor(rate(r.ok, r.n), r.n, minN) : null
}
