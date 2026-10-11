// Chat mit Freunden: einfache Textnachrichten zwischen gegenseitigen Kontakten.
//  - Gegenseitig = beide haben einander als Kontakt (Hinzufügen per Code/Link/QR legt beide Richtungen an). Wer jemanden entfernt, blockiert ihn zugleich:
//    der Entfernte kann die Gegenrichtung nicht wieder anlegen, der Verlauf wird gelöscht.
//  - Nachrichten werden `chat.retentionDays` Tage gespeichert, sind nur für beide Beteiligten lesbar und werden beim Löschen des Profils entfernt.
import { all, get, run, tx, now } from './db.ts'
import { config } from './config.ts'
import { HttpError } from './http.ts'
import { notifyMessage } from './push.ts'
import type { PlayerRow } from './auth.ts'

const pub = (p: Pick<PlayerRow, 'public_id' | 'name'>) => ({ public_id: p.public_id, name: p.name })

export const mutual = (a: number, b: number) =>
  !!get('SELECT 1 FROM contacts WHERE player_id=? AND contact_id=?', a, b) && !!get('SELECT 1 FROM contacts WHERE player_id=? AND contact_id=?', b, a)

function friendOf(me: PlayerRow, publicId: unknown): PlayerRow {
  const f = get<PlayerRow>('SELECT * FROM players WHERE public_id=? AND deleted=0 AND is_bot=0', String(publicId ?? '').toUpperCase())
  if (!f || f.id === me.id) throw new HttpError(404, 'unknown_player')
  if (!mutual(me.id, f.id)) throw new HttpError(403, 'not_friends')
  return f
}

const view = (m: { id: number; from_id: number; body: string; created_at: number }, me: number) => ({ id: m.id, mine: m.from_id === me, text: m.body, at: m.created_at })

export function send(me: PlayerRow, publicId: unknown, text: unknown) {
  const f = friendOf(me, publicId)
  const body = String(text ?? '').replace(/\r\n?/g, '\n').trim()
  if (!body) throw new HttpError(400, 'empty_message')
  if ([...body].length > config.chat.maxLength) throw new HttpError(400, 'message_too_long')
  const t = now()
  const id = Number(run('INSERT INTO chat_messages(from_id,to_id,body,created_at) VALUES(?,?,?,?)', me.id, f.id, body, t).lastInsertRowid)
  const de = f.lang === 'de'
  notifyMessage(f.id, { title: de ? 'Neue Nachricht' : 'New message', body: de ? `${me.name} hat dir geschrieben.` : `${me.name} wrote to you.`, url: `/#/chat/${me.public_id}`, tag: `chat-${me.public_id}` })
  return view({ id, from_id: me.id, body, created_at: t }, me.id)
}

/** Verlauf mit einem Freund (neueste höchstens 200, `after` = nur Neueres); Eingehendes gilt damit als gelesen. */
export function thread(me: PlayerRow, publicId: unknown, after = 0) {
  const f = friendOf(me, publicId)
  const rows = all<{ id: number; from_id: number; body: string; created_at: number }>(
    `SELECT * FROM (SELECT id, from_id, body, created_at FROM chat_messages WHERE id>? AND ((from_id=? AND to_id=?) OR (from_id=? AND to_id=?)) ORDER BY id DESC LIMIT 200) ORDER BY id`, after, me.id, f.id, f.id, me.id)
  run('UPDATE chat_messages SET read_at=? WHERE to_id=? AND from_id=? AND read_at IS NULL', now(), me.id, f.id)
  return { friend: pub(f), messages: rows.map((m) => view(m, me.id)), max_length: config.chat.maxLength, retention_days: config.chat.retentionDays }
}

/** Unterhaltungen (neueste zuerst) mit letzter Nachricht und Zahl ungelesener. */
export function conversations(me: PlayerRow) {
  const rows = all<{ partner: number; last_id: number; unread: number }>(
    `SELECT partner, MAX(id) last_id, SUM(unread) unread FROM (
       SELECT CASE WHEN from_id=? THEN to_id ELSE from_id END partner, id, CASE WHEN to_id=? AND read_at IS NULL THEN 1 ELSE 0 END unread
       FROM chat_messages WHERE from_id=? OR to_id=?) GROUP BY partner ORDER BY last_id DESC`, me.id, me.id, me.id, me.id)
  const out = []
  for (const r of rows) {
    const p = get<PlayerRow>('SELECT * FROM players WHERE id=? AND deleted=0', r.partner)
    if (!p || !mutual(me.id, p.id)) continue
    const m = get<{ id: number; from_id: number; body: string; created_at: number }>('SELECT id, from_id, body, created_at FROM chat_messages WHERE id=?', r.last_id)!
    out.push({ friend: pub(p), last: view(m, me.id), unread: r.unread })
  }
  return { conversations: out, unread: unreadTotal(me) }
}

export const unreadTotal = (me: PlayerRow) => get<{ n: number }>('SELECT COUNT(*) n FROM chat_messages WHERE to_id=? AND read_at IS NULL', me.id)!.n

/** Freund entfernen: Verlauf löschen und die Person blockieren (sie kann die Gegenrichtung nicht neu anlegen). */
export function removeFriend(me: PlayerRow, publicId: string) {
  tx(() => {
    const f = get<{ id: number }>('SELECT id FROM players WHERE public_id=?', publicId.toUpperCase())
    run('DELETE FROM contacts WHERE player_id=? AND contact_id=?', me.id, f?.id ?? -1)
    if (!f) return
    run('DELETE FROM chat_messages WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?)', me.id, f.id, f.id, me.id)
    run('INSERT OR IGNORE INTO chat_blocks(player_id,blocked_id) VALUES(?,?)', me.id, f.id)
  })
}

/** Gegenseitiges Hinzufügen (Code/Link/QR): beide Richtungen, es sei denn, die andere Person hat mich entfernt/blockiert. */
export function addFriend(me: PlayerRow, other: PlayerRow) {
  tx(() => {
    run('INSERT OR IGNORE INTO contacts(player_id,contact_id,created_at) VALUES(?,?,?)', me.id, other.id, now())
    run('DELETE FROM chat_blocks WHERE player_id=? AND blocked_id=?', me.id, other.id) // wer jemanden bewusst wieder hinzufügt, hebt die eigene Sperre auf
    if (!get('SELECT 1 FROM chat_blocks WHERE player_id=? AND blocked_id=?', other.id, me.id)) run('INSERT OR IGNORE INTO contacts(player_id,contact_id,created_at) VALUES(?,?,?)', other.id, me.id, now())
  })
}

export function sweepChat(): number {
  return Number(run('DELETE FROM chat_messages WHERE created_at<?', now() - config.chat.retentionDays * 86_400_000).changes)
}

export function forgetChat(pid: number) {
  run('DELETE FROM chat_messages WHERE from_id=? OR to_id=?', pid, pid)
  run('DELETE FROM chat_blocks WHERE player_id=? OR blocked_id=?', pid, pid)
}

/** Eigene Nachrichten für den Profil-Export (Auskunft). */
export function exportFor(me: PlayerRow) {
  return all<{ id: number; from_id: number; to_id: number; body: string; created_at: number }>('SELECT id, from_id, to_id, body, created_at FROM chat_messages WHERE from_id=? OR to_id=? ORDER BY id', me.id, me.id)
    .map((m) => ({ with: get<{ name: string }>('SELECT name FROM players WHERE id=?', m.from_id === me.id ? m.to_id : m.from_id)?.name ?? '—', mine: m.from_id === me.id, text: m.body, at: new Date(m.created_at).toISOString() }))
}
