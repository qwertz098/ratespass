// Überarbeitungs-Meldungen: Reviewer (vom Admin bestimmte Spieler) und der Admin markieren Fragen oder Antworten
// als „falsch“ oder „Formulierung“. Die Frage bleibt dabei im Spiel; der Admin entscheidet in der Moderation.
import { all, get, run, now } from './db.ts'
import { HttpError } from './http.ts'
import type { QRow } from './questions.ts'

export const PARTS = ['question', 'answers'] as const
export const KINDS = ['wrong', 'wording'] as const

export function fileReview(questionId: number, playerId: number | null, part: unknown, kind: unknown, note: unknown): number {
  if (!PARTS.includes(part as never) || !KINDS.includes(kind as never)) throw new HttpError(400, 'bad_review')
  if (!get('SELECT 1 FROM questions WHERE id=?', questionId)) throw new HttpError(404, 'not_found')
  const text = String(note ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 300)
  const dup = get<{ id: number }>(
    "SELECT id FROM reviews WHERE question_id=? AND IFNULL(player_id,0)=? AND part=? AND kind=? AND status='open'", questionId, playerId ?? 0, part as string, kind as string)
  if (dup) {
    if (text) run('UPDATE reviews SET note=? WHERE id=?', text, dup.id)
    return dup.id
  }
  return Number(run('INSERT INTO reviews(question_id,player_id,part,kind,note,created_at) VALUES(?,?,?,?,?,?)',
    questionId, playerId, part as string, kind as string, text, now()).lastInsertRowid)
}

export const resolveReview = (id: number, status: 'resolved' | 'dismissed') => {
  const r = run("UPDATE reviews SET status=?, resolved_at=? WHERE id=? AND status='open'", status, now(), id)
  if (!r.changes) throw new HttpError(404, 'not_found')
}

export const questionOut = (q: QRow) => ({ ...q, wrong: JSON.parse(q.wrong) as string[] })

export function listReviews(status: string) {
  const rows = all<{ id: number; question_id: number; part: string; kind: string; note: string; status: string; created_at: number; pname: string | null; ppub: string | null }>(
    `SELECT r.*, p.name pname, p.public_id ppub FROM reviews r LEFT JOIN players p ON p.id=r.player_id
     WHERE r.status=? ORDER BY r.id LIMIT 100`, status)
  return rows.map((r) => {
    const q = get<QRow>('SELECT * FROM questions WHERE id=?', r.question_id)!
    return {
      id: r.id, part: r.part, kind: r.kind, note: r.note, status: r.status, created_at: r.created_at,
      by: r.ppub ? { name: r.pname, public_id: r.ppub } : null, // null = Admin
      question_id: q.id,
      group: all<QRow>('SELECT * FROM questions WHERE group_id=? ORDER BY lang', q.group_id).map(questionOut),
    }
  })
}
