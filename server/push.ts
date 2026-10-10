// Web Push ohne Abhängigkeiten: VAPID (RFC 8292) + Nachrichtenverschlüsselung aes128gcm (RFC 8291/8188).
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.ts'
import { afterCommit, all, get, run, now } from './db.ts'

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url')

/* ---------- VAPID-Schlüssel ---------- */
interface VapidKeys { publicKey: string; privateKey: crypto.KeyObject }
let vapid: VapidKeys | undefined

function loadVapid(): VapidKeys {
  const file = process.env.VAPID_FILE ?? path.join(config.dataDir, 'vapid.json')
  let jwk: crypto.JsonWebKey | undefined
  if (config.dbPath !== ':memory:' && fs.existsSync(file)) jwk = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!jwk) {
    jwk = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'jwk' })
    if (config.dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify(jwk), { mode: 0o600 })
    }
  }
  const privateKey = crypto.createPrivateKey({ key: jwk, format: 'jwk' })
  const publicKey = b64u(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url')]))
  return { publicKey, privateKey }
}
export const vapidPublicKey = () => (vapid ??= loadVapid()).publicKey

export function vapidAuthorization(audience: string): string {
  const keys = (vapid ??= loadVapid())
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }))
  const body = b64u(JSON.stringify({ aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: config.vapidSubject }))
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' })
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${keys.publicKey}`
}

/* ---------- Verschlüsselung (aes128gcm) ---------- */
export function encryptPayload(p256dh: string, authSecret: string, payload: Buffer): Buffer {
  const uaPublic = Buffer.from(p256dh, 'base64url')
  const auth = Buffer.from(authSecret, 'base64url')
  const ecdh = crypto.createECDH('prime256v1')
  ecdh.generateKeys()
  const asPublic = ecdh.getPublicKey()
  const shared = ecdh.computeSecret(uaPublic)
  const salt = crypto.randomBytes(16)
  const hkdf = (ikm: Buffer, s: Buffer, info: Buffer, len: number) => Buffer.from(crypto.hkdfSync('sha256', ikm, s, info, len))
  const ikm = hkdf(shared, auth, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32)
  const cek = hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16)
  const nonce = hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12)
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce)
  // Letzter (einziger) Datensatz endet mit dem Trennbyte 0x02
  const body = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()])
  const header = Buffer.alloc(21)
  salt.copy(header, 0)
  header.writeUInt32BE(4096, 16)
  header[20] = asPublic.length
  return Buffer.concat([header, asPublic, body])
}

/* ---------- Endpoint-Prüfung (SSRF-Schutz) ---------- */
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/,
  /(^|\.)push\.apple\.com$/, /(^|\.)notify\.windows\.com$/,
]
export function validEndpoint(endpoint: unknown): endpoint is string {
  if (typeof endpoint !== 'string' || endpoint.length > 2048) return false
  let u: URL
  try { u = new URL(endpoint) } catch { return false }
  if (u.username || u.password) return false
  if (config.pushAllowInsecure && u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost')) return true
  if (u.protocol !== 'https:' || u.port) return false
  const host = u.hostname.toLowerCase()
  return PUSH_HOSTS.some((re) => re.test(host)) || config.pushExtraHosts.includes(host)
}
export const validKeys = (p256dh: unknown, auth: unknown) => {
  if (typeof p256dh !== 'string' || typeof auth !== 'string') return false
  const k = Buffer.from(p256dh, 'base64url'), a = Buffer.from(auth, 'base64url')
  return k.length === 65 && k[0] === 4 && a.length === 16
}

/* ---------- Senden ---------- */
interface Sub { endpoint: string; p256dh: string; auth: string }
export interface PushMessage { title: string; body: string; url: string; tag: string }

async function sendOne(sub: Sub, msg: PushMessage): Promise<number> {
  const payload = Buffer.from(JSON.stringify(msg))
  const body = encryptPayload(sub.p256dh, sub.auth, payload)
  const res = await fetch(sub.endpoint, {
    method: 'POST', body: new Uint8Array(body), redirect: 'error', signal: AbortSignal.timeout(10_000),
    headers: {
      authorization: vapidAuthorization(new URL(sub.endpoint).origin),
      'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream',
      ttl: '86400', urgency: 'normal', topic: msg.tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32),
    },
  })
  await res.arrayBuffer().catch(() => {})
  return res.status
}

const inflight = new Set<Promise<void>>()
/** Wartet auf laufende Zustellungen (für Tests und sauberes Beenden). */
export const flushPush = async () => { while (inflight.size) await Promise.allSettled([...inflight]) }

export async function deliver(playerId: number, msg: PushMessage): Promise<number> {
  const subs = all<Sub>('SELECT endpoint,p256dh,auth FROM push_subs WHERE player_id=?', playerId)
  let ok = 0
  await Promise.all(subs.map(async (s) => {
    try {
      const status = await sendOne(s, msg)
      if (status >= 200 && status < 300) { ok++; run('UPDATE push_subs SET last_ok=?, fails=0 WHERE endpoint=?', now(), s.endpoint) }
      else if (status === 404 || status === 410) run('DELETE FROM push_subs WHERE endpoint=?', s.endpoint)
      else bumpFail(s.endpoint, `HTTP ${status}`)
    } catch (e: any) { bumpFail(s.endpoint, e?.message ?? String(e)) }
  }))
  return ok
}
function bumpFail(endpoint: string, why: string) {
  run('UPDATE push_subs SET fails=fails+1 WHERE endpoint=?', endpoint)
  run('DELETE FROM push_subs WHERE endpoint=? AND fails>=5', endpoint)
  console.warn(`push: Zustellung fehlgeschlagen (${why})`)
}

/* ---------- Texte & Auslöser ---------- */
export type PushKind = 'challenge' | 'turn' | 'matched' | 'won' | 'lost' | 'draw' | 'resigned' | 'timeout' | 'room_start' | 'room_done' | 'remind' | 'replaced'
const TEXT: Record<'de' | 'en', Record<PushKind, [string, string]>> = {
  de: {
    challenge: ['Neue Herausforderung', '{name} fordert dich zu einem Duell heraus.'],
    turn: ['Du bist dran', '{name} hat gespielt – jetzt bist du dran.'],
    matched: ['Gegner gefunden', '{name} spielt gegen dich – leg los!'],
    won: ['Spiel beendet', 'Du hast gegen {name} gewonnen! 🎉'],
    lost: ['Spiel beendet', '{name} hat gewonnen.'],
    draw: ['Spiel beendet', 'Unentschieden gegen {name}.'],
    resigned: ['Gegner hat aufgegeben', '{name} hat aufgegeben – du gewinnst!'],
    timeout: ['Spiel beendet', 'Das Spiel gegen {name} wurde wegen Inaktivität beendet.'],
    remind: ['Du bist dran', '{name} wartet auf deinen Zug.'],
    replaced: ['Duell mit Bot fortgesetzt', '{name} hat euer Duell mit einem Bot fortgesetzt, weil du länger nicht gespielt hast.'],
    room_start: ['Raum gestartet', '{name} hat die Runde gestartet – jetzt spielen!'],
    room_done: ['Runde beendet', 'Die Runde von {name} ist beendet – sieh dir die Rangliste an.'],
  },
  en: {
    challenge: ['New challenge', '{name} challenges you to a duel.'],
    turn: ['Your turn', '{name} has played – now it’s your turn.'],
    matched: ['Opponent found', '{name} is playing you – go!'],
    won: ['Game over', 'You beat {name}! 🎉'],
    lost: ['Game over', '{name} won.'],
    draw: ['Game over', 'A draw against {name}.'],
    resigned: ['Opponent resigned', '{name} resigned – you win!'],
    timeout: ['Game over', 'The game against {name} ended due to inactivity.'],
    remind: ['Your turn', '{name} is waiting for your move.'],
    replaced: ['Duel continued with a bot', '{name} continued your duel with a bot because you have not played for a while.'],
    room_start: ['Room started', '{name} has started the round – play now!'],
    room_done: ['Round finished', '{name}’s round is over – check the ranking.'],
  },
}

export function messageFor(lang: string, kind: PushKind, gameId: number, name: string): PushMessage {
  const [title, body] = TEXT[lang === 'de' ? 'de' : 'en'][kind]
  const room = kind.startsWith('room_')
  return { title, body: body.replace('{name}', name), url: `/#/${room ? 'room' : 'game'}/${gameId}`, tag: `${room ? 'room' : 'game'}-${gameId}` }
}

/** Benachrichtigt einen Spieler nach dem Commit der laufenden Transaktion. Bots und Spieler ohne Abo werden ausgelassen. */
export function notifyPlayer(playerId: number | null, kind: PushKind, gameId: number, otherName: string) {
  if (!playerId) return
  afterCommit(() => {
    const p = get<{ lang: string; is_bot: number; deleted: number }>('SELECT lang,is_bot,deleted FROM players WHERE id=?', playerId)
    if (!p || p.is_bot || p.deleted) return
    if (!get('SELECT 1 FROM push_subs WHERE player_id=? LIMIT 1', playerId)) return
    const job: Promise<void> = deliver(playerId, messageFor(p.lang, kind, gameId, otherName)).then(() => {}, (e) => console.warn('push', e)).finally(() => inflight.delete(job))
    inflight.add(job)
  })
}
