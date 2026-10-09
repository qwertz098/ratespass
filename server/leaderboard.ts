// Bestenlisten (Opt-in). Absolut = richtig beantwortete Fragen, relativ = Quote gewusst/(gewusst + nicht gewusst).
// „Mit Bots“ zählt alle Antworten (auch Duelle gegen den Bot und die Solo-Leiter), „nur Menschen“ nur Antworten in Spielen,
// in denen mindestens ein anderer Mensch mitspielt (Duell gegen Mensch, Runden, Live). Die Liste zeigt nur den frei gewählten
// Bestenlisten-Namen von Spielern, die aktiv teilnehmen.
//
// Bot-Schutz (Basis): Nur Antworten mit plausibler Lesezeit zählen (MIN_BASE_MS + MIN_MS_PER_CHAR je Zeichen der Frage), je Spieler
// höchstens DAY_CAP Antworten pro Tag und HOUR_CAP pro Stunde; sichtbar erst nach MIN_AGE_MS Profilalter und MIN_ANSWERS gewerteten
// Antworten. Zusätzlich markiert `flags()` statistisch auffällige Spieler für die manuelle Prüfung im Admin (keine Auto-Sperre).
// Stärkere Maßnahmen: docs/BOTSCHUTZ.md.
import { all, db, get, run, now } from './db.ts'
import { HttpError } from './http.ts'

export const MIN_BASE_MS = 600
export const MIN_MS_PER_CHAR = 2
export const DAY_CAP = 400
export const HOUR_CAP = 120
export const MIN_AGE_MS = 24 * 3_600_000
export const MIN_ANSWERS = 50
export const MIN_RELATIVE = 100

export const SCOPES = ['week', 'month', 'all'] as const
export type Scope = (typeof SCOPES)[number]

/** Alle Antworten mit Zeitstempel und Kennzeichen, ob ein weiterer Mensch mitspielt. Wird von Live-Spielen ergänzt (LIVE_SQL). */
export const ANSWER_SOURCES: string[] = [
  `SELECT rq.question_id qid, a.player_id pid, a.correct ok, a.ms ms, a.served_at at,
          CASE WHEN EXISTS (SELECT 1 FROM players o WHERE o.id = CASE WHEN g.p1=a.player_id THEN g.p2 ELSE g.p1 END AND o.is_bot=0) THEN 1 ELSE 0 END human
   FROM answers a JOIN games g ON g.id=a.game_id JOIN round_questions rq ON rq.game_id=a.game_id AND rq.round=a.round AND rq.idx=a.idx WHERE a.choice IS NOT NULL`,
  `SELECT s.question_id, l.player_id, s.correct, s.ms, s.served_at, 0 FROM ladder_steps s JOIN ladders l ON l.id=s.ladder_id WHERE s.choice IS NOT NULL`,
  `SELECT rq.question_id, a.player_id, a.correct, a.ms, a.served_at, 1 FROM room_answers a JOIN room_questions rq ON rq.room_id=a.room_id AND rq.idx=a.idx WHERE a.choice IS NOT NULL`,
]

export function since(scope: Scope, t = now()): number {
  const d = new Date(t)
  if (scope === 'month') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
  if (scope === 'week') { const day = (d.getUTCDay() + 6) % 7; return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day) }
  return 0
}

export interface Row { pid: number; name: string; n: number; ok: number; is_me?: boolean }

/** Gewertete Antworten je Spieler (nach Plausibilitäts- und Mengenbegrenzung) – unabhängig von Opt-in, Basis für Rangliste und Auffälligkeiten. */
function scored(scope: Scope, humanOnly: boolean): { pid: number; n: number; ok: number }[] {
  const sql = `
    WITH base AS (
      SELECT x.pid, x.ok, x.at FROM (${ANSWER_SOURCES.join(' UNION ALL ')}) x JOIN questions q ON q.id=x.qid
      WHERE x.at >= :since AND x.ms >= :base + :per * LENGTH(q.text) ${humanOnly ? 'AND x.human=1' : ''}
    ), capped AS (
      SELECT pid, ok, ROW_NUMBER() OVER (PARTITION BY pid, at/86400000 ORDER BY at) rd, ROW_NUMBER() OVER (PARTITION BY pid, at/3600000 ORDER BY at) rh FROM base
    )
    SELECT pid, COUNT(*) n, SUM(ok) ok FROM capped WHERE rd<=:dcap AND rh<=:hcap GROUP BY pid`
  return db.prepare(sql).all({ since: since(scope), base: MIN_BASE_MS, per: MIN_MS_PER_CHAR, dcap: DAY_CAP, hcap: HOUR_CAP }) as unknown as { pid: number; n: number; ok: number }[]
}

const cache = new Map<string, { at: number; rows: Row[] }>()
export const clearCache = () => cache.clear()

/** Teilnehmende Spieler mit Wertung (ohne Mindestanzahl-Filter), je nach Variante sortiert. */
function standings(scope: Scope, humanOnly: boolean): Row[] {
  const key = `${scope}|${humanOnly}`
  const hit = cache.get(key)
  if (hit && now() - hit.at < 60_000) return hit.rows
  const players = new Map(all<{ id: number; lb_name: string; created_at: number }>(
    'SELECT id, lb_name, created_at FROM players WHERE lb_name IS NOT NULL AND lb_banned=0 AND deleted=0 AND is_bot=0').map((p) => [p.id, p]))
  const rows: Row[] = scored(scope, humanOnly).filter((r) => players.has(r.pid)).map((r) => ({ pid: r.pid, name: players.get(r.pid)!.lb_name, n: r.n, ok: r.ok ?? 0 }))
  cache.set(key, { at: now(), rows })
  return rows
}

export function ranking(scope: Scope, humanOnly: boolean, kind: 'abs' | 'rel', viewer: number, limit = 50) {
  const rows = standings(scope, humanOnly)
  const young = (pid: number) => now() - (get<{ created_at: number }>('SELECT created_at FROM players WHERE id=?', pid)?.created_at ?? 0) < MIN_AGE_MS
  const minN = kind === 'rel' ? MIN_RELATIVE : MIN_ANSWERS
  const eligible = rows.filter((r) => r.n >= minN && !young(r.pid))
  eligible.sort(kind === 'abs' ? (a, b) => b.ok - a.ok || a.n - b.n : (a, b) => b.ok / b.n - a.ok / a.n || b.n - a.n)
  const top = eligible.slice(0, limit).map((r, i) => ({ rank: i + 1, name: r.name, ok: r.ok, n: r.n, rate: Math.round((r.ok / r.n) * 1000) / 10, is_me: r.pid === viewer }))
  const mine = rows.find((r) => r.pid === viewer) ?? (get('SELECT 1 FROM players WHERE id=? AND lb_name IS NOT NULL AND lb_banned=0', viewer) ? { pid: viewer, name: '', n: 0, ok: 0 } : undefined)
  const idx = eligible.findIndex((r) => r.pid === viewer)
  return {
    top,
    me: mine ? { rank: idx >= 0 ? idx + 1 : null, ok: mine.ok, n: mine.n, rate: mine.n ? Math.round((mine.ok / mine.n) * 1000) / 10 : null, needs: Math.max(0, minN - mine.n), young: young(viewer) } : null,
    total: eligible.length, rules: { min_answers: MIN_ANSWERS, min_relative: MIN_RELATIVE, day_cap: DAY_CAP },
  }
}

/* ---------- Teilnahme (Opt-in) ---------- */
const RESERVED = ['admin', 'administrator', 'ratespass', 'ratespaß', 'robo', 'bot', 'moderator', 'system', 'support']
export function cleanLbName(raw: unknown): string {
  const n = String(raw ?? '').normalize('NFC').replace(/\s+/g, ' ').trim()
  if (n.length < 3 || n.length > 20 || !/^[\p{L}\p{N}][\p{L}\p{N} ._·-]*$/u.test(n) || !/\p{L}/u.test(n) || RESERVED.includes(n.toLowerCase())) throw new HttpError(400, 'bad_lb_name')
  return n
}

export function join(playerId: number, rawName: unknown) {
  const p = get<{ lb_banned: number }>('SELECT lb_banned FROM players WHERE id=?', playerId)!
  if (p.lb_banned) throw new HttpError(403, 'lb_banned')
  const name = cleanLbName(rawName)
  try { run('UPDATE players SET lb_name=?, lb_key=?, lb_optin_at=COALESCE(lb_optin_at, ?) WHERE id=?', name, name.toLocaleLowerCase('de'), now(), playerId) } catch (e: any) {
    if (String(e?.message).includes('UNIQUE')) throw new HttpError(409, 'lb_name_taken')
    throw e
  }
  clearCache()
  return name
}
export function leave(playerId: number) {
  run('UPDATE players SET lb_name=NULL, lb_key=NULL, lb_optin_at=NULL WHERE id=?', playerId)
  clearCache()
}

/* ---------- Auffälligkeiten (nur Anzeige für den Admin) ---------- */
export interface Flag { pid: number; public_id: string; name: string; n: number; rate: number; expected: number; excess: number; cv: number | null; hours: number; flags: string[]; banned: boolean; participating: boolean }

/** Statistische Auffälligkeiten ab 200 Antworten: fast fehlerfrei, deutlich besser als andere bei denselben Fragen, gleichförmige Antwortzeiten, Rund-um-die-Uhr-Aktivität. */
export function flags(minN = 200): Flag[] {
  const sql = `
    WITH qrate AS (
      SELECT x.qid, AVG(x.ok) r FROM (${ANSWER_SOURCES.join(' UNION ALL ')}) x JOIN players p ON p.id=x.pid WHERE p.is_bot=0 GROUP BY x.qid HAVING COUNT(*)>=10
    )
    SELECT x.pid, COUNT(*) n, AVG(x.ok) rate, AVG(qr.r) expected, AVG(x.ms) mean, AVG(1.0*x.ms*x.ms) sq,
           COUNT(DISTINCT (x.at/3600000) % 24) hours
    FROM (${ANSWER_SOURCES.join(' UNION ALL ')}) x JOIN qrate qr ON qr.qid=x.qid
    GROUP BY x.pid HAVING COUNT(*) >= :minN`
  const rows = db.prepare(sql).all({ minN }) as unknown as { pid: number; n: number; rate: number; expected: number; mean: number; sq: number; hours: number }[]
  const out: Flag[] = []
  for (const r of rows) {
    const p = get<{ public_id: string; name: string; lb_name: string | null; lb_banned: number; deleted: number; is_bot: number }>('SELECT public_id, name, lb_name, lb_banned, deleted, is_bot FROM players WHERE id=?', r.pid)
    if (!p || p.deleted || p.is_bot) continue
    const sd = Math.sqrt(Math.max(0, r.sq - r.mean * r.mean)), cv = r.mean > 0 ? sd / r.mean : null
    const f: string[] = []
    if (r.rate > 0.97) f.push('Quote über 97 %')
    if (r.rate - r.expected > 0.25) f.push('weit besser als andere bei denselben Fragen')
    if (cv !== null && cv < 0.12) f.push('auffällig gleichförmige Antwortzeiten')
    if (r.hours >= 22) f.push('Aktivität rund um die Uhr')
    if (f.length) out.push({ pid: r.pid, public_id: p.public_id, name: p.lb_name ?? p.name, n: r.n, rate: Math.round(r.rate * 1000) / 1000, expected: Math.round(r.expected * 1000) / 1000, excess: Math.round((r.rate - r.expected) * 1000) / 1000, cv: cv === null ? null : Math.round(cv * 1000) / 1000, hours: r.hours, flags: f, banned: !!p.lb_banned, participating: !!p.lb_name })
  }
  return out.sort((a, b) => b.flags.length - a.flags.length || b.excess - a.excess)
}

export function ban(publicId: string, banned: boolean) {
  const r = run('UPDATE players SET lb_banned=?, lb_name=CASE WHEN ? THEN NULL ELSE lb_name END, lb_key=CASE WHEN ? THEN NULL ELSE lb_key END WHERE public_id=?', banned ? 1 : 0, banned ? 1 : 0, banned ? 1 : 0, publicId.toUpperCase())
  if (!r.changes) throw new HttpError(404, 'unknown_player')
  clearCache()
}
