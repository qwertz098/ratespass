// Wordle: tägliches Wort je Sprache (für alle gleich), ein Bonus-Wordle pro Tag, Gruppen mit eigenem Tageswort (2 Mitglieder = Duell),
// Bestenlisten (global mit Opt-in-Name, je Gruppe) und Streaks. Die Auswertung geschieht nur auf dem Server; das gesuchte Wort
// verlässt ihn erst nach Spielende.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.ts'
import { all, get, run, tx, now } from './db.ts'
import { HttpError } from './http.ts'
import type { PlayerRow } from './auth.ts'
import { WORDLE_LANGS, isWordleLang, normalizeWord, type WordleLang } from './wordle-words.ts'
import { notifyMessage } from './push.ts'

export const MAX_GUESSES = 6
export const KINDS = ['daily', 'bonus', 'group'] as const
export type Kind = (typeof KINDS)[number]
export const SCOPES = ['day', 'week', 'month', 'all'] as const
export type Scope = (typeof SCOPES)[number]
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/* ---------- Tage ---------- */
/** Kalendertag (JJJJ-MM-TT) in der Wordle-Zeitzone. */
export const dayOf = (t = now(), tz = config.wordle.tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(t)
export const addDays = (day: string, n: number) => new Date(Date.parse(day + 'T12:00:00Z') + n * 86_400_000).toISOString().slice(0, 10)
const windowStart = (scope: Scope, today: string) => (scope === 'day' ? today : scope === 'week' ? addDays(today, -6) : scope === 'month' ? addDays(today, -29) : '0000-00-00')

/* ---------- Wortlisten ---------- */
let loaded = false
/** Liest wordlists/*.txt in die Datenbank (nur Neues; Sperren bleiben bestehen). */
export function loadWordlists(dir = config.wordle.dir) {
  tx(() => {
    for (const lang of WORDLE_LANGS) {
      const read = (n: string) => { const f = path.join(dir, `${lang}.${n}.txt`); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').map((w) => normalizeWord(lang, w)).filter((w): w is string => !!w) : [] }
      for (const w of read('words')) run('INSERT OR IGNORE INTO wordle_words(lang,word,solution) VALUES(?,?,0)', lang, w)
      for (const w of read('solutions')) run('INSERT INTO wordle_words(lang,word,solution) VALUES(?,?,1) ON CONFLICT(lang,word) DO UPDATE SET solution=1', lang, w)
    }
  })
  loaded = true
}
export function ensureWords() {
  if (loaded) return
  if (!get('SELECT 1 FROM wordle_words LIMIT 1')) loadWordlists()
  loaded = true
}
const isValidWord = (lang: string, w: string) => !!get('SELECT 1 FROM wordle_words WHERE lang=? AND word=? AND banned=0', lang, w)
const solutions = (lang: string) => all<{ word: string }>('SELECT word FROM wordle_words WHERE lang=? AND solution=1 AND banned=0', lang).map((r) => r.word)
const pick = (pool: string[]) => pool[crypto.randomInt(pool.length)]

/** Wort des Tages je Sprache und Geltungsbereich (`global` oder `g:<Gruppe>`); wird beim ersten Zugriff gezogen und gespeichert. */
export function wordFor(lang: WordleLang, day: string, scope: string): string {
  const hit = get<{ word: string }>('SELECT word FROM wordle_daily WHERE lang=? AND day=? AND scope=?', lang, day, scope)
  if (hit) return hit.word
  ensureWords()
  const recent = new Set(all<{ word: string }>('SELECT word FROM wordle_daily WHERE lang=? AND scope=? AND day>=?', lang, scope, addDays(day, -365)).map((r) => r.word))
  let pool = solutions(lang)
  if (!pool.length) throw new HttpError(503, 'no_words')
  const fresh = pool.filter((w) => !recent.has(w))
  if (fresh.length) pool = fresh
  run('INSERT OR IGNORE INTO wordle_daily(lang,day,scope,word) VALUES(?,?,?,?)', lang, day, scope, pick(pool))
  return get<{ word: string }>('SELECT word FROM wordle_daily WHERE lang=? AND day=? AND scope=?', lang, day, scope)!.word
}

/** Persönliches Bonus-Wort: nicht das Tageswort, nicht aus den letzten 365 Tagen dieses Spielers. */
function bonusWord(pid: number, lang: WordleLang, day: string): string {
  ensureWords()
  const skip = new Set(all<{ word: string }>("SELECT word FROM wordle_games WHERE player_id=? AND kind='bonus' AND lang=? AND day>=?", pid, lang, addDays(day, -365)).map((r) => r.word))
  skip.add(wordFor(lang, day, 'global'))
  const pool = solutions(lang).filter((w) => !skip.has(w))
  if (!pool.length) throw new HttpError(503, 'no_words')
  return pick(pool)
}

/** Auswertung: je Buchstabe c = richtig, p = im Wort an anderer Stelle, a = nicht (mehr) vorhanden; Doppelbuchstaben zählen korrekt. */
export function evaluate(guess: string, answer: string): string {
  const g = [...guess], a = [...answer], res: string[] = g.map(() => 'a'), left = new Map<string, number>()
  g.forEach((ch, i) => { if (ch === a[i]) res[i] = 'c'; else left.set(a[i], (left.get(a[i]) ?? 0) + 1) })
  g.forEach((ch, i) => { if (res[i] !== 'c' && (left.get(ch) ?? 0) > 0) { res[i] = 'p'; left.set(ch, left.get(ch)! - 1) } })
  return res.join('')
}

/* ---------- Spiele ---------- */
interface GameRow {
  id: number; player_id: number; kind: Kind; lang: WordleLang; day: string; group_id: number; word: string; guesses: string
  status: 'playing' | 'won' | 'lost'; points: number; started_at: number; last_at: number; finished_at: number | null
}
const guessesOf = (g: GameRow) => JSON.parse(g.guesses) as string[]
export const gameView = (g: GameRow) => ({
  id: g.id, kind: g.kind, lang: g.lang, day: g.day, group_id: g.group_id || null, status: g.status, points: g.points, max: MAX_GUESSES,
  guesses: guessesOf(g).map((w) => ({ word: w, marks: evaluate(w, g.word) })), finished: g.status !== 'playing', ...(g.status !== 'playing' ? { answer: g.word } : {}),
})
const summary = (g: GameRow | undefined) => (g ? { id: g.id, status: g.status, guesses: guessesOf(g).length, points: g.points } : null)

const myGame = (pid: number, kind: Kind, lang: string, day: string, group = 0) =>
  get<GameRow>('SELECT * FROM wordle_games WHERE player_id=? AND kind=? AND lang=? AND day=? AND group_id=?', pid, kind, lang, day, group)

/** Spiel des Tages holen oder anlegen (ein Spiel je Spieler, Art, Sprache, Tag und Gruppe). */
export function startGame(me: PlayerRow, kind: unknown, lang: unknown, groupId?: unknown) {
  if (!KINDS.includes(kind as Kind)) throw new HttpError(400, 'bad_kind')
  return tx(() => {
    const day = dayOf()
    let language: WordleLang, gid = 0, word: string
    if (kind === 'group') {
      const g = memberGroup(me.id, groupId)
      language = g.lang; gid = g.id
      word = wordFor(language, day, `g:${g.id}`)
    } else {
      if (!isWordleLang(lang)) throw new HttpError(400, 'bad_lang')
      language = lang
      word = kind === 'daily' ? wordFor(language, day, 'global') : ''
    }
    const have = myGame(me.id, kind as Kind, language, day, gid)
    if (have) return gameView(have)
    if (kind === 'bonus') word = bonusWord(me.id, language, day)
    const t = now()
    const id = Number(run('INSERT INTO wordle_games(player_id,kind,lang,day,group_id,word,started_at,last_at) VALUES(?,?,?,?,?,?,?,?)', me.id, kind as string, language, day, gid, word, t, t).lastInsertRowid)
    return gameView(get<GameRow>('SELECT * FROM wordle_games WHERE id=?', id)!)
  })
}

function mustGame(me: PlayerRow, id: number): GameRow {
  const g = get<GameRow>('SELECT * FROM wordle_games WHERE id=? AND player_id=?', id, me.id)
  if (!g) throw new HttpError(404, 'not_found')
  return g
}
export const getGame = (me: PlayerRow, id: number) => gameView(mustGame(me, id))

export function guess(me: PlayerRow, id: number, raw: unknown) {
  return tx(() => {
    const g = mustGame(me, id)
    if (g.status !== 'playing') throw new HttpError(409, 'game_over')
    const w = normalizeWord(g.lang, raw)
    if (!w) throw new HttpError(400, 'bad_word')
    ensureWords()
    if (!isValidWord(g.lang, w)) throw new HttpError(422, 'not_in_list')
    const list = guessesOf(g)
    if (list.length && now() - g.last_at < config.wordle.minGuessMs) throw new HttpError(429, 'too_fast')
    list.push(w)
    const won = w === g.word, lost = !won && list.length >= MAX_GUESSES
    const status = won ? 'won' : lost ? 'lost' : 'playing'
    run('UPDATE wordle_games SET guesses=?, status=?, points=?, last_at=?, finished_at=? WHERE id=?', JSON.stringify(list), status, won ? MAX_GUESSES + 1 - list.length : 0, now(), status === 'playing' ? null : now(), id)
    return gameView(get<GameRow>('SELECT * FROM wordle_games WHERE id=?', id)!)
  })
}

/** Aufeinanderfolgende Tage mit gelöstem Tages-Wordle (heute oder gestern endend). */
export function streakOf(pid: number, lang: string, today = dayOf()): number {
  const days = new Set(all<{ day: string }>("SELECT day FROM wordle_games WHERE player_id=? AND kind='daily' AND lang=? AND status='won' ORDER BY day DESC LIMIT 800", pid, lang).map((r) => r.day))
  let d = days.has(today) ? today : addDays(today, -1), n = 0
  while (days.has(d)) { n++; d = addDays(d, -1) }
  return n
}

/* ---------- Gruppen ---------- */
interface GroupRow { id: number; name: string; lang: WordleLang; owner: number; code: string; created_at: number }
const MAX_MEMBERSHIPS = 30
const pname = (pid: number) => { const p = get<{ name: string; deleted: number }>('SELECT name, deleted FROM players WHERE id=?', pid); return !p || p.deleted ? '—' : p.name }

function cleanGroupName(raw: unknown): string {
  const n = String(raw ?? '').normalize('NFC').replace(/\s+/g, ' ').trim()
  if (n.length < 2 || n.length > 30 || /[\u0000-\u001f\u007f<>]/.test(n)) throw new HttpError(400, 'bad_group_name')
  return n
}
function memberGroup(pid: number, groupId: unknown): GroupRow {
  const g = get<GroupRow>('SELECT g.* FROM wordle_groups g JOIN wordle_members m ON m.group_id=g.id WHERE g.id=? AND m.player_id=?', Number(groupId), pid)
  if (!g) throw new HttpError(404, 'unknown_group')
  return g
}
const memberCount = (gid: number) => get<{ n: number }>('SELECT COUNT(*) n FROM wordle_members WHERE group_id=?', gid)!.n

export function createGroup(me: PlayerRow, name: unknown, lang: unknown) {
  if (!isWordleLang(lang)) throw new HttpError(400, 'bad_lang')
  const n = cleanGroupName(name)
  return tx(() => {
    if (get<{ n: number }>('SELECT COUNT(*) n FROM wordle_members WHERE player_id=?', me.id)!.n >= MAX_MEMBERSHIPS) throw new HttpError(409, 'too_many_groups')
    let code = ''
    for (let i = 0; i < 10; i++) {
      code = Array.from({ length: 8 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('')
      if (!get('SELECT 1 FROM wordle_groups WHERE code=?', code)) break
    }
    const t = now()
    const id = Number(run('INSERT INTO wordle_groups(name,lang,owner,code,created_at) VALUES(?,?,?,?,?)', n, lang, me.id, code, t).lastInsertRowid)
    run('INSERT INTO wordle_members(group_id,player_id,joined_at) VALUES(?,?,?)', id, me.id, t)
    return groupView(me, id)
  })
}

export function joinGroup(me: PlayerRow, rawCode: unknown) {
  const code = String(rawCode ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  return tx(() => {
    const g = get<GroupRow>('SELECT * FROM wordle_groups WHERE code=?', code)
    if (!g) throw new HttpError(404, 'unknown_group')
    if (!get('SELECT 1 FROM wordle_members WHERE group_id=? AND player_id=?', g.id, me.id)) {
      if (memberCount(g.id) >= config.wordle.groupMax) throw new HttpError(409, 'group_full')
      if (get<{ n: number }>('SELECT COUNT(*) n FROM wordle_members WHERE player_id=?', me.id)!.n >= MAX_MEMBERSHIPS) throw new HttpError(409, 'too_many_groups')
      run('INSERT INTO wordle_members(group_id,player_id,joined_at) VALUES(?,?,?)', g.id, me.id, now())
    }
    return groupView(me, g.id)
  })
}

function removeGroup(id: number) {
  run('DELETE FROM wordle_games WHERE group_id=?', id)
  run("DELETE FROM wordle_push WHERE key=?", `g:${id}`)
  run("DELETE FROM wordle_daily WHERE scope=?", `g:${id}`)
  run('DELETE FROM wordle_members WHERE group_id=?', id)
  run('DELETE FROM wordle_groups WHERE id=?', id)
}

/** Austreten: Spiele und Push-Option des Mitglieds in dieser Gruppe entfallen; Eigentümer wechselt, leere Gruppen verschwinden. */
export function leaveGroup(pid: number, groupId: number) {
  tx(() => {
    const g = get<GroupRow>('SELECT g.* FROM wordle_groups g JOIN wordle_members m ON m.group_id=g.id WHERE g.id=? AND m.player_id=?', groupId, pid)
    if (!g) throw new HttpError(404, 'unknown_group')
    run('DELETE FROM wordle_games WHERE group_id=? AND player_id=?', groupId, pid)
    run('DELETE FROM wordle_push WHERE player_id=? AND key=?', pid, `g:${groupId}`)
    run('DELETE FROM wordle_members WHERE group_id=? AND player_id=?', groupId, pid)
    const next = get<{ player_id: number }>('SELECT player_id FROM wordle_members WHERE group_id=? ORDER BY joined_at LIMIT 1', groupId)
    if (!next) removeGroup(groupId)
    else if (g.owner === pid) run('UPDATE wordle_groups SET owner=? WHERE id=?', next.player_id, groupId)
  })
}
export function deleteGroup(me: PlayerRow, groupId: number) {
  tx(() => {
    const g = memberGroup(me.id, groupId)
    if (g.owner !== me.id) throw new HttpError(404, 'unknown_group')
    removeGroup(g.id)
  })
}
/** Beim Löschen eines Profils: alles Wordle-Bezogene entfernen. */
export function erasePlayerWordle(pid: number) {
  for (const m of all<{ group_id: number }>('SELECT group_id FROM wordle_members WHERE player_id=?', pid)) leaveGroup(pid, m.group_id)
  run('DELETE FROM wordle_games WHERE player_id=?', pid)
  run('DELETE FROM wordle_push WHERE player_id=?', pid)
  run('DELETE FROM wordle_push_log WHERE player_id=?', pid)
}

export function groupView(me: PlayerRow, groupId: number) {
  const g = memberGroup(me.id, groupId), day = dayOf()
  const members = all<{ player_id: number; joined_at: number }>('SELECT player_id, joined_at FROM wordle_members WHERE group_id=? ORDER BY joined_at', g.id)
  const today = new Map(all<GameRow>("SELECT * FROM wordle_games WHERE group_id=? AND kind='group' AND day=?", g.id, day).map((x) => [x.player_id, x]))
  return {
    id: g.id, name: g.name, lang: g.lang, code: g.code, is_owner: g.owner === me.id, day, max_members: config.wordle.groupMax,
    members: members.map((m) => ({ name: pname(m.player_id), is_me: m.player_id === me.id, is_owner: m.player_id === g.owner, today: summary(today.get(m.player_id)) ? { status: today.get(m.player_id)!.status, guesses: guessesOf(today.get(m.player_id)!).length } : null })),
    my_game: summary(today.get(me.id)),
  }
}

/** Gruppen-Bestenliste: Punkte aus beendeten Gruppenspielen im Zeitraum; alle Mitglieder erscheinen. */
export function groupBoard(me: PlayerRow, groupId: number, rawScope: unknown) {
  const g = memberGroup(me.id, groupId)
  const scope = SCOPES.includes(rawScope as Scope) ? (rawScope as Scope) : 'week', today = dayOf()
  const stats = new Map(all<{ player_id: number; pts: number; played: number; won: number; avg: number | null }>(
    `SELECT player_id, SUM(points) pts, COUNT(*) played, SUM(status='won') won, AVG(CASE WHEN status='won' THEN json_array_length(guesses) END) avg
     FROM wordle_games WHERE group_id=? AND kind='group' AND status<>'playing' AND day>=? GROUP BY player_id`, g.id, windowStart(scope, today)).map((r) => [r.player_id, r]))
  const rows = all<{ player_id: number }>('SELECT player_id FROM wordle_members WHERE group_id=?', g.id).map((m) => {
    const s = stats.get(m.player_id)
    return { pid: m.player_id, name: pname(m.player_id), points: s?.pts ?? 0, played: s?.played ?? 0, won: s?.won ?? 0, avg_guesses: s?.avg ? Math.round(s.avg * 10) / 10 : null }
  }).sort((a, b) => b.points - a.points || (a.avg_guesses ?? 9) - (b.avg_guesses ?? 9) || b.won - a.won || a.name.localeCompare(b.name))
  let rank = 0
  return { scope, rows: rows.map((r, i) => { if (i === 0 || r.points !== rows[i - 1].points || r.avg_guesses !== rows[i - 1].avg_guesses) rank = i + 1; return { rank, name: r.name, points: r.points, played: r.played, won: r.won, avg_guesses: r.avg_guesses, is_me: r.pid === me.id } }) }
}

/** Duell: eine Gruppe, zu der die andere Person per Push eingeladen wird (Beitritt per Link, nicht automatisch). */
export function duelInvite(me: PlayerRow, publicId: unknown, lang: unknown) {
  const other = get<PlayerRow>('SELECT * FROM players WHERE public_id=? AND deleted=0 AND is_bot=0', String(publicId ?? '').toUpperCase())
  if (!other || other.id === me.id) throw new HttpError(404, 'unknown_player')
  const group = createGroup(me, `${me.name} ⚔ ${other.name}`.slice(0, 30), lang)
  inviteMessage(other, me, group.code, group.name)
  return group
}
function inviteMessage(to: PlayerRow, from: PlayerRow, code: string, name: string) {
  const de = to.lang === 'de'
  notifyMessage(to.id, { title: de ? 'Wordle-Duell' : 'Wordle duel', body: de ? `${from.name} lädt dich zu „${name}“ ein.` : `${from.name} invites you to “${name}”.`, url: `/#/wordle/join/${code}`, tag: `wordle-invite-${code}` })
}

/* ---------- Hub und Bestenliste ---------- */
export function hub(me: PlayerRow) {
  const day = dayOf()
  const groups = all<GroupRow>('SELECT g.* FROM wordle_groups g JOIN wordle_members m ON m.group_id=g.id WHERE m.player_id=? ORDER BY g.name', me.id)
  const push = new Set(all<{ key: string }>('SELECT key FROM wordle_push WHERE player_id=?', me.id).map((r) => r.key))
  return {
    day, tz: config.wordle.tz,
    langs: WORDLE_LANGS.map((lang) => ({ lang, daily: summary(myGame(me.id, 'daily', lang, day)), bonus: summary(myGame(me.id, 'bonus', lang, day)), streak: streakOf(me.id, lang, day), push: push.has(`daily:${lang}`) })),
    groups: groups.map((g) => ({ id: g.id, name: g.name, lang: g.lang, is_owner: g.owner === me.id, members: memberCount(g.id), code: g.code, today: summary(myGame(me.id, 'group', g.lang, day, g.id)), push: push.has(`g:${g.id}`) })),
  }
}

/** Globale Bestenliste (nur Teilnehmer mit Bestenlisten-Namen, nur Tages-Wordle): Punkte im Zeitraum. */
export function board(me: PlayerRow, lang: unknown, rawScope: unknown, limit = 50) {
  if (!isWordleLang(lang)) throw new HttpError(400, 'bad_lang')
  const scope = SCOPES.includes(rawScope as Scope) ? (rawScope as Scope) : 'week', today = dayOf()
  const rows = all<{ id: number; name: string; pts: number; played: number; won: number; avg: number | null }>(
    `SELECT p.id, p.lb_name name, SUM(g.points) pts, COUNT(*) played, SUM(g.status='won') won, AVG(CASE WHEN g.status='won' THEN json_array_length(g.guesses) END) avg
     FROM wordle_games g JOIN players p ON p.id=g.player_id
     WHERE g.kind='daily' AND g.lang=? AND g.status<>'playing' AND g.day>=? AND p.lb_name IS NOT NULL AND p.lb_banned=0 AND p.deleted=0
     GROUP BY p.id ORDER BY pts DESC, avg IS NULL, avg ASC, won DESC, name`, lang, windowStart(scope, today))
  const list = rows.map((r, i) => ({ rank: 0, id: r.id, name: r.name, points: r.pts, played: r.played, won: r.won, avg_guesses: r.avg ? Math.round(r.avg * 10) / 10 : null, i }))
  list.forEach((r, i) => { r.rank = i > 0 && r.points === list[i - 1].points && r.avg_guesses === list[i - 1].avg_guesses ? list[i - 1].rank : i + 1 })
  const top = list.slice(0, limit).map((r) => ({ rank: r.rank, name: r.name, points: r.points, played: r.played, won: r.won, avg_guesses: r.avg_guesses, streak: streakOf(r.id, lang, today), is_me: r.id === me.id }))
  const mine = list.find((r) => r.id === me.id)
  return { lang, scope, top, me: { participating: !!get('SELECT 1 FROM players WHERE id=? AND lb_name IS NOT NULL AND lb_banned=0', me.id), rank: mine?.rank ?? null, points: mine?.points ?? 0, played: mine?.played ?? 0 }, total: list.length }
}
