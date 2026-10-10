// Wordle: tägliches Wort je Sprache (für alle gleich), Gruppen mit eigenem Tageswort (2 Mitglieder = Duell; nur Ein- und Austreten, Punkte gehören der Gruppe),
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
export const KINDS = ['daily', 'group'] as const
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
    run("DELETE FROM wordle_words WHERE word GLOB '*[^a-z]*'") // frühere Fassungen kannten Wörter mit Umlauten
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
  run('DELETE FROM wordle_shares WHERE group_id=?', id)
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
    run('DELETE FROM wordle_shares WHERE group_id=? AND from_pid=?', groupId, pid)
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
  run('DELETE FROM wordle_shares WHERE from_pid=? OR to_pid=?', pid, pid)
  run('DELETE FROM wordle_push WHERE player_id=?', pid)
  run('DELETE FROM wordle_push_log WHERE player_id=?', pid)
}

/** Farbraster (nur Markierungen, nie Buchstaben) eines beendeten Spiels. */
const gridOf = (g: GameRow) => guessesOf(g).map((w) => evaluate(w, g.word))

export function groupView(me: PlayerRow, groupId: number) {
  const g = memberGroup(me.id, groupId), day = dayOf()
  const members = all<{ player_id: number; joined_at: number }>('SELECT player_id, joined_at FROM wordle_members WHERE group_id=? ORDER BY joined_at', g.id)
  const today = new Map(all<GameRow>("SELECT * FROM wordle_games WHERE group_id=? AND kind='group' AND day=?", g.id, day).map((x) => [x.player_id, x]))
  const mineDone = !!today.get(me.id) && today.get(me.id)!.status !== 'playing' // Raster anderer erst, wenn man selbst fertig ist (kein Hinweis auf das heutige Wort)
  return {
    id: g.id, name: g.name, lang: g.lang, code: g.code, is_owner: g.owner === me.id, day, max_members: config.wordle.groupMax,
    push: !!get('SELECT 1 FROM wordle_push WHERE player_id=? AND key=?', me.id, `g:${g.id}`),
    members: members.map((m) => {
      const x = today.get(m.player_id)
      return { name: pname(m.player_id), is_me: m.player_id === me.id, is_owner: m.player_id === g.owner, today: x ? { status: x.status, guesses: guessesOf(x).length } : null,
        grid: x && x.status !== 'playing' && (mineDone || m.player_id === me.id) ? gridOf(x) : undefined }
    }),
    my_game: summary(today.get(me.id)),
    feed: all<ShareRow>('SELECT * FROM wordle_shares WHERE group_id=? AND created_at>=? ORDER BY created_at DESC LIMIT 30', g.id, shareSince()).map((x) => shareView(me.id, x)),
  }
}

/** Dauerwertung einer Gruppe: Punkte aus beendeten Gruppenspielen im Zeitraum. Alle Mitglieder erscheinen; wer an einem Tag nicht spielt, bekommt dafür 0 Punkte
 *  (`missed` zählt diese vergangenen Tage seit Beitritt). Punkte entstehen nur in der Gruppe – es gibt keine Übernahme beim Beitritt oder Austritt. */
export function groupBoard(me: PlayerRow, groupId: number, rawScope: unknown) {
  const g = memberGroup(me.id, groupId)
  const scope = SCOPES.includes(rawScope as Scope) ? (rawScope as Scope) : 'all', today = dayOf(), from = windowStart(scope, today), yesterday = addDays(today, -1)
  const games = all<{ player_id: number; day: string; status: string; points: number; n: number }>(
    "SELECT player_id, day, status, points, json_array_length(guesses) n FROM wordle_games WHERE group_id=? AND kind='group'", g.id)
  const byPlayer = new Map<number, typeof games>()
  for (const x of games) (byPlayer.get(x.player_id) ?? byPlayer.set(x.player_id, []).get(x.player_id)!).push(x)
  const rows = all<{ player_id: number; joined_at: number }>('SELECT player_id, joined_at FROM wordle_members WHERE group_id=?', g.id).map((m) => {
    const mine = byPlayer.get(m.player_id) ?? [], done = mine.filter((x) => x.status !== 'playing')
    const inWin = done.filter((x) => x.day >= from)
    const won = inWin.filter((x) => x.status === 'won')
    const start = [from, dayOf(m.joined_at)].sort().at(-1)! // Wertung beginnt frühestens am Beitrittstag
    const pastDays = start > yesterday ? 0 : Math.round((Date.parse(yesterday) - Date.parse(start)) / 86_400_000) + 1
    const missed = Math.max(0, pastDays - done.filter((x) => x.day >= start && x.day <= yesterday).length)
    const days = new Set(done.map((x) => x.day)); let d = days.has(today) ? today : yesterday, streak = 0
    while (days.has(d)) { streak++; d = addDays(d, -1) }
    const t = mine.find((x) => x.day === today)
    return { pid: m.player_id, name: pname(m.player_id), points: inWin.reduce((a, x) => a + x.points, 0), played: inWin.length, won: won.length, missed, streak,
      avg_guesses: won.length ? Math.round((won.reduce((a, x) => a + x.n, 0) / won.length) * 10) / 10 : null, today: t ? { status: t.status, guesses: t.n } : null }
  }).sort((a, b) => b.points - a.points || (a.avg_guesses ?? 9) - (b.avg_guesses ?? 9) || b.won - a.won || a.name.localeCompare(b.name))
  let rank = 0
  return { scope, today, rows: rows.map((r, i) => { if (i === 0 || r.points !== rows[i - 1].points || r.avg_guesses !== rows[i - 1].avg_guesses) rank = i + 1; return { rank, name: r.name, points: r.points, played: r.played, won: r.won, avg_guesses: r.avg_guesses, missed: r.missed, streak: r.streak, today: r.today, is_me: r.pid === me.id } }) }
}

/** Duell: eine Gruppe, zu der die andere Person per Push eingeladen wird (Beitritt per Link, nicht automatisch). */
export function duelInvite(me: PlayerRow, publicId: unknown, lang: unknown) {
  const other = get<PlayerRow>('SELECT * FROM players WHERE public_id=? AND deleted=0 AND is_bot=0', String(publicId ?? '').toUpperCase())
  if (!other || other.id === me.id) throw new HttpError(404, 'unknown_player')
  // Je Person läuft höchstens ein Duell: gibt es schon eine Duell-Gruppe der beiden (egal wer sie angelegt hat), wird sie geöffnet statt eine weitere anzulegen
  const names = [`${me.name} ⚔ ${other.name}`.slice(0, 30), `${other.name} ⚔ ${me.name}`.slice(0, 30)]
  const open = get<{ id: number }>(
    `SELECT g.id FROM wordle_groups g JOIN wordle_members m ON m.group_id=g.id AND m.player_id=? WHERE g.name IN (?,?) AND g.lang=?
       AND (g.owner=? OR EXISTS (SELECT 1 FROM wordle_members o WHERE o.group_id=g.id AND o.player_id=?)) ORDER BY g.id DESC LIMIT 1`, me.id, names[0], names[1], String(lang), me.id, other.id)
  if (open) return groupView(me, open.id)
  const group = createGroup(me, names[0], lang)
  inviteMessage(other, me, group.code, group.name)
  return group
}
function inviteMessage(to: PlayerRow, from: PlayerRow, code: string, name: string) {
  const de = to.lang === 'de'
  notifyMessage(to.id, { title: de ? 'Wordle-Duell' : 'Wordle duel', body: de ? `${from.name} lädt dich zu „${name}“ ein.` : `${from.name} invites you to “${name}”.`, url: `/#/wordle/join/${code}`, tag: `wordle-invite-${code}` })
}

/* ---------- Ergebnis teilen (an Kontakt oder Gruppe) ---------- */
const SHARE_DAYS = 14
interface ShareRow { id: number; from_pid: number; to_pid: number | null; group_id: number | null; lang: WordleLang; day: string; status: string; guesses: number; marks: string; seen: number; created_at: number }

/** Das eigene beendete Tages-Wordle (nur Markierungen, nie Buchstaben) an einen Kontakt (`public_id`) oder in eine eigene Gruppe (`group_id`) schicken; erneutes Teilen überschreibt. */
export function shareResult(me: PlayerRow, gameId: unknown, target: { public_id?: unknown; group_id?: unknown }) {
  const g = get<GameRow>('SELECT * FROM wordle_games WHERE id=? AND player_id=?', Number(gameId), me.id)
  if (!g || g.kind !== 'daily') throw new HttpError(404, 'not_found')
  if (g.status === 'playing') throw new HttpError(409, 'not_finished')
  const marks = JSON.stringify(gridOf(g)), t = now()
  const hasUser = target.public_id !== undefined && target.public_id !== null, hasGroup = target.group_id !== undefined && target.group_id !== null
  if (hasUser === hasGroup) throw new HttpError(400, 'bad_target')
  return tx(() => {
    if (hasUser) {
      const other = get<PlayerRow>('SELECT p.* FROM players p JOIN contacts c ON c.contact_id=p.id WHERE c.player_id=? AND p.public_id=? AND p.deleted=0 AND p.is_bot=0', me.id, String(target.public_id).toUpperCase())
      if (!other || other.id === me.id) throw new HttpError(404, 'unknown_player')
      run('DELETE FROM wordle_shares WHERE from_pid=? AND to_pid=? AND lang=? AND day=?', me.id, other.id, g.lang, g.day)
      run('INSERT INTO wordle_shares(from_pid,to_pid,lang,day,status,guesses,marks,created_at) VALUES(?,?,?,?,?,?,?,?)', me.id, other.id, g.lang, g.day, g.status, guessesOf(g).length, marks, t)
      const de = other.lang === 'de'
      notifyMessage(other.id, { title: 'Wordle', body: de ? `${me.name} hat sein Wordle geteilt.` : `${me.name} shared a Wordle result.`, url: '/#/wordle', tag: `wordle-share-${me.id}` })
    } else {
      const grp = memberGroup(me.id, target.group_id)
      run('DELETE FROM wordle_shares WHERE from_pid=? AND group_id=? AND lang=? AND day=?', me.id, grp.id, g.lang, g.day)
      run('INSERT INTO wordle_shares(from_pid,group_id,lang,day,status,guesses,marks,created_at) VALUES(?,?,?,?,?,?,?,?)', me.id, grp.id, g.lang, g.day, g.status, guessesOf(g).length, marks, t)
    }
    return { ok: true }
  })
}

/** Ansicht eines Shares. Das Raster eines geteilten Tages-Wordles sieht nur, wer dasselbe Wordle (Sprache, Tag) selbst schon beendet hat – sonst nur Ausgang und Versuche. */
function shareView(viewer: number, x: ShareRow) {
  const mine = x.from_pid === viewer ? undefined : myGame(viewer, 'daily', x.lang, x.day)
  const open = x.from_pid === viewer || (!!mine && mine.status !== 'playing')
  return { id: x.id, name: pname(x.from_pid), is_me: x.from_pid === viewer, lang: x.lang, day: x.day, status: x.status, guesses: x.guesses, grid: open ? (JSON.parse(x.marks) as string[]) : undefined, locked: !open, seen: !!x.seen, at: x.created_at }
}
const shareSince = () => now() - SHARE_DAYS * 86_400_000
const unseenShares = (pid: number) => get<{ n: number }>('SELECT COUNT(*) n FROM wordle_shares WHERE to_pid=? AND seen=0 AND created_at>=?', pid, shareSince())!.n
/** Eingang: an mich gerichtete Shares der letzten Tage (markiert sie als gesehen). */
export function inbox(me: PlayerRow) {
  const rows = all<ShareRow>('SELECT * FROM wordle_shares WHERE to_pid=? AND created_at>=? ORDER BY created_at DESC LIMIT 50', me.id, shareSince())
  const items = rows.map((x) => shareView(me.id, x))
  run('UPDATE wordle_shares SET seen=1 WHERE to_pid=? AND seen=0', me.id)
  return { items }
}
/** Aufräumen: Shares verfallen nach 14 Tagen. */
export const sweepShares = () => run('DELETE FROM wordle_shares WHERE created_at<?', shareSince())

/** Eigener Platz und Gesamtpunkte in einer Gruppe (für die Übersicht). */
function standing(groupId: number, pid: number) {
  const pts = new Map(all<{ player_id: number; p: number }>("SELECT player_id, SUM(points) p FROM wordle_games WHERE group_id=? AND kind='group' AND status<>'playing' GROUP BY player_id", groupId).map((r) => [r.player_id, r.p]))
  const mine = pts.get(pid) ?? 0
  const members = all<{ player_id: number }>('SELECT player_id FROM wordle_members WHERE group_id=?', groupId)
  return { points: mine, rank: 1 + members.filter((m) => (pts.get(m.player_id) ?? 0) > mine).length }
}

/* ---------- Hub und Bestenliste ---------- */
export function hub(me: PlayerRow) {
  const day = dayOf()
  const groups = all<GroupRow>('SELECT g.* FROM wordle_groups g JOIN wordle_members m ON m.group_id=g.id WHERE m.player_id=? ORDER BY g.name', me.id)
  const push = new Set(all<{ key: string }>('SELECT key FROM wordle_push WHERE player_id=?', me.id).map((r) => r.key))
  return {
    day, tz: config.wordle.tz, inbox_unseen: unseenShares(me.id),
    langs: WORDLE_LANGS.map((lang) => ({ lang, daily: summary(myGame(me.id, 'daily', lang, day)), streak: streakOf(me.id, lang, day), push: push.has(`daily:${lang}`) })),
    groups: groups.map((g) => ({ id: g.id, name: g.name, lang: g.lang, is_owner: g.owner === me.id, members: memberCount(g.id), code: g.code, today: summary(myGame(me.id, 'group', g.lang, day, g.id)), push: push.has(`g:${g.id}`), ...standing(g.id, me.id) })),
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

/* ---------- Erinnerung um 9 Uhr (lokale Zeit, optional) ---------- */
const validTz = (tz: unknown): tz is string => {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true } catch { return false }
}
/** Merkt sich die Zeitzone des Geräts (für „9 Uhr“). Ungültige Werte werden ignoriert. */
export function rememberTz(pid: number, tz: unknown) {
  if (validTz(tz)) run('UPDATE players SET tz=? WHERE id=? AND (tz IS NULL OR tz<>?)', tz, pid, tz)
}
const PUSH_KEY = /^(daily:(de|en)|g:\d+)$/
/** Erinnerung für ein Wordle ein- oder ausschalten (`daily:de`, `daily:en` oder `g:<Gruppe>`). */
export function setPush(me: PlayerRow, key: unknown, on: unknown, tz: unknown) {
  if (typeof key !== 'string' || !PUSH_KEY.test(key)) throw new HttpError(400, 'bad_key')
  if (key.startsWith('g:')) memberGroup(me.id, Number(key.slice(2)))
  if (on) {
    if (!validTz(tz) && !get('SELECT 1 FROM players WHERE id=? AND tz IS NOT NULL', me.id)) throw new HttpError(400, 'bad_tz')
    rememberTz(me.id, tz)
    run('INSERT OR IGNORE INTO wordle_push(player_id,key) VALUES(?,?)', me.id, key)
  } else run('DELETE FROM wordle_push WHERE player_id=? AND key=?', me.id, key)
  return { key, on: !!on }
}

const localParts = (t: number, tz: string) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(t).map((x) => [x.type, x.value]))
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) }
}
const PUSH_TEXT = {
  de: { daily: ['Dein Wordle wartet', 'Das heutige Wordle ({lang}) ist bereit – 6 Versuche, 5 Buchstaben.'], streak: ' Halte deine Serie von {n} Tagen!', group: ['Neues Wordle in „{name}“', 'Das heutige Gruppen-Wordle wartet auf dich.'], langs: { de: 'Deutsch', en: 'Englisch' } },
  en: { daily: ['Your Wordle is waiting', 'Today’s Wordle ({lang}) is ready – 6 tries, 5 letters.'], streak: ' Keep your {n}-day streak going!', group: ['New Wordle in “{name}”', 'Today’s group Wordle is waiting for you.'], langs: { de: 'German', en: 'English' } },
} as const

export interface DuePush { pid: number; key: string; localDay: string; title: string; body: string; url: string; tag: string }
/** Wer ist jetzt (lokal 9:00–9:59) dran, hat die Erinnerung an, noch nicht gespielt und heute noch keine bekommen? */
export function dueNotifications(at = now()): DuePush[] {
  const today = dayOf(at), out: DuePush[] = []
  const rows = all<{ player_id: number; key: string; tz: string; lang: string }>(
    'SELECT w.player_id, w.key, p.tz, p.lang FROM wordle_push w JOIN players p ON p.id=w.player_id WHERE p.deleted=0 AND p.is_bot=0 AND p.tz IS NOT NULL')
  for (const r of rows) {
    const local = localParts(at, r.tz)
    if (local.hour !== 9) continue
    if (get('SELECT 1 FROM wordle_push_log WHERE player_id=? AND key=? AND day=?', r.player_id, r.key, local.day)) continue
    const T = PUSH_TEXT[r.lang === 'de' ? 'de' : 'en']
    if (r.key.startsWith('daily:')) {
      const lang = r.key.slice(6) as WordleLang, g = myGame(r.player_id, 'daily', lang, today)
      if (g && g.status !== 'playing') continue
      const streak = streakOf(r.player_id, lang, today)
      out.push({ pid: r.player_id, key: r.key, localDay: local.day, title: T.daily[0], body: T.daily[1].replace('{lang}', T.langs[lang]) + (streak ? T.streak.replace('{n}', String(streak)) : ''), url: '/#/wordle', tag: `wordle-${lang}` })
    } else {
      const gid = Number(r.key.slice(2)), grp = get<GroupRow>('SELECT g.* FROM wordle_groups g JOIN wordle_members m ON m.group_id=g.id WHERE g.id=? AND m.player_id=?', gid, r.player_id)
      if (!grp) continue
      const g = myGame(r.player_id, 'group', grp.lang, today, gid)
      if (g && g.status !== 'playing') continue
      out.push({ pid: r.player_id, key: r.key, localDay: local.day, title: T.group[0].replace('{name}', grp.name), body: T.group[1], url: `/#/wordle/group/${gid}`, tag: `wordle-g${gid}` })
    }
  }
  return out
}
/** Minütlich aufgerufen: sendet fällige Erinnerungen genau einmal je Wordle und lokalem Tag. */
export function wordlePushTick(at = now(), send: (pid: number, msg: { title: string; body: string; url: string; tag: string }) => void = notifyMessage): number {
  const due = dueNotifications(at)
  for (const d of due) {
    run('INSERT OR IGNORE INTO wordle_push_log(player_id,key,day,at) VALUES(?,?,?,?)', d.pid, d.key, d.localDay, at)
    send(d.pid, { title: d.title, body: d.body, url: d.url, tag: d.tag })
  }
  run('DELETE FROM wordle_push_log WHERE at<?', at - 3 * 86_400_000)
  return due.length
}

/* ---------- Admin: Statistik und Wortlisten ---------- */
const guessDist = (rows: { n: number; c: number }[]) => { const d = [0, 0, 0, 0, 0, 0]; for (const r of rows) if (r.n >= 1 && r.n <= 6) d[r.n - 1] = r.c; return d }

export function adminOverview(days = 14) {
  const today = dayOf(), from = addDays(today, -(Math.min(60, Math.max(1, days)) - 1))
  const active = (d: number) => get<{ n: number }>('SELECT COUNT(DISTINCT player_id) n FROM wordle_games WHERE day>=?', addDays(today, -(d - 1)))!.n
  const langs = WORDLE_LANGS.map((lang) => {
    const words = get<{ total: number; sol: number; banned: number }>('SELECT COUNT(*) total, SUM(solution) sol, SUM(banned) banned FROM wordle_words WHERE lang=?', lang)!
    const daily = all<{ day: string; plays: number; finished: number; won: number; avg: number | null }>(
      `SELECT day, COUNT(*) plays, SUM(status<>'playing') finished, SUM(status='won') won, AVG(CASE WHEN status='won' THEN json_array_length(guesses) END) avg
       FROM wordle_games WHERE kind='daily' AND lang=? AND day>=? GROUP BY day ORDER BY day DESC`, lang, from).map((r) => {
      const dist = guessDist(all<{ n: number; c: number }>("SELECT json_array_length(guesses) n, COUNT(*) c FROM wordle_games WHERE kind='daily' AND lang=? AND day=? AND status='won' GROUP BY n", lang, r.day))
      return { day: r.day, word: get<{ word: string }>("SELECT word FROM wordle_daily WHERE lang=? AND day=? AND scope='global'", lang, r.day)?.word ?? null, plays: r.plays, finished: r.finished, won: r.won, win_rate: r.finished ? Math.round((r.won / r.finished) * 100) : null, avg_guesses: r.avg ? Math.round(r.avg * 10) / 10 : null, dist, lost: r.finished - r.won }
    })
    const upcoming = Array.from({ length: 7 }, (_, i) => addDays(today, i)).map((day) => {
      const w = get<{ word: string; forced: number }>("SELECT word, forced FROM wordle_daily WHERE lang=? AND day=? AND scope='global'", lang, day)
      return { day, word: w?.word ?? null, forced: !!w?.forced }
    })
    return { lang, words: { valid: words.total, solutions: words.sol ?? 0, banned: words.banned ?? 0 }, daily, upcoming }
  })
  const groups = all<{ id: number; name: string; lang: string; members: number; plays7: number }>(
    `SELECT g.id, g.name, g.lang, (SELECT COUNT(*) FROM wordle_members m WHERE m.group_id=g.id) members,
            (SELECT COUNT(*) FROM wordle_games x WHERE x.group_id=g.id AND x.day>=?) plays7 FROM wordle_groups g ORDER BY plays7 DESC, members DESC LIMIT 15`, addDays(today, -6))
  const push = Object.fromEntries(all<{ k: string; n: number }>("SELECT CASE WHEN key LIKE 'g:%' THEN 'groups' ELSE key END k, COUNT(*) n FROM wordle_push GROUP BY k").map((r) => [r.k, r.n]))
  const flags = all<{ player_id: number; n: number; ones: number; fast: number }>(
    `SELECT player_id, COUNT(*) n, SUM(status='won' AND json_array_length(guesses)=1) ones, SUM(status='won' AND json_array_length(guesses)>=3 AND finished_at-started_at<5000) fast
     FROM wordle_games WHERE kind='daily' AND status<>'playing' GROUP BY player_id HAVING n>=5 AND (ones*2>=n OR fast*2>=n) ORDER BY n DESC LIMIT 30`).map((r) => {
    const p = get<{ public_id: string; name: string; lb_name: string | null }>('SELECT public_id, name, lb_name FROM players WHERE id=?', r.player_id)
    return { public_id: p?.public_id, name: p?.lb_name ?? p?.name, games: r.n, solved_first_try: r.ones, solved_fast: r.fast }
  })
  return {
    today, tz: config.wordle.tz, langs, flags, push,
    players: { active_1: active(1), active_7: active(7), active_30: active(30), games_today: get<{ n: number }>('SELECT COUNT(*) n FROM wordle_games WHERE day=?', today)!.n },
    groups: { total: get<{ n: number }>('SELECT COUNT(*) n FROM wordle_groups')!.n, members: get<{ n: number }>('SELECT COUNT(*) n FROM wordle_members')!.n, top: groups },
    pushes_sent_3d: get<{ n: number }>('SELECT COUNT(*) n FROM wordle_push_log')!.n,
  }
}

export function adminWords(lang: unknown, query: unknown) {
  if (!isWordleLang(lang)) throw new HttpError(400, 'bad_lang')
  const q = String(query ?? '').toLowerCase().replace(/[^a-z]/g, '').slice(0, 5)
  return { words: q ? all('SELECT word, solution, banned FROM wordle_words WHERE lang=? AND word LIKE ? ORDER BY word LIMIT 50', lang, q + '%') : all('SELECT word, solution, banned FROM wordle_words WHERE lang=? AND banned=1 ORDER BY word LIMIT 100', lang) }
}
/** Wort sperren (weder Lösung noch Eingabe) oder wieder freigeben. */
export function adminBan(lang: unknown, word: unknown, banned: unknown) {
  if (!isWordleLang(lang)) throw new HttpError(400, 'bad_lang')
  const w = normalizeWord(lang, word)
  if (!w || !get('SELECT 1 FROM wordle_words WHERE lang=? AND word=?', lang, w)) throw new HttpError(404, 'unknown_word')
  run('UPDATE wordle_words SET banned=? WHERE lang=? AND word=?', banned === false ? 0 : 1, lang, w)
  return { word: w, banned: banned !== false }
}
/** Globales Tageswort für einen künftigen Tag festlegen (oder heute, solange noch niemand gespielt hat). */
export function adminForce(lang: unknown, day: unknown, word: unknown) {
  if (!isWordleLang(lang)) throw new HttpError(400, 'bad_lang')
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day) || day < dayOf()) throw new HttpError(400, 'bad_day')
  const w = normalizeWord(lang, word)
  if (!w || !isValidWord(lang, w)) throw new HttpError(404, 'unknown_word')
  if (get('SELECT 1 FROM wordle_games WHERE kind=\'daily\' AND lang=? AND day=? LIMIT 1', lang, day)) throw new HttpError(409, 'day_started')
  run("INSERT INTO wordle_daily(lang,day,scope,word,forced) VALUES(?,?,'global',?,1) ON CONFLICT(lang,day,scope) DO UPDATE SET word=excluded.word, forced=1", lang, day, w)
  return { lang, day, word: w }
}
