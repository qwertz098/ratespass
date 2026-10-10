import crypto from 'node:crypto'
import { promisify } from 'node:util'
import { get, run, now } from './db.ts'
import { HttpError } from './http.ts'

export interface PlayerRow {
  id: number
  public_id: string
  name: string
  lang: string
  is_bot: number
  reviewer: number
  level: string
  disabled_cats: string
  best_ladder: number
  birth_year: number | null
  lb_name: string | null
  lb_key: string | null
  lb_optin_at: number | null
  lb_follow: number
  tz: string | null
  lb_banned: number
  deleted: number
  username: string | null
  pw_hash: string | null
  created_at: number
  last_seen: number | null
}

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex')
export const newToken = () => crypto.randomBytes(32).toString('base64url')

export function randomCode(len: number) {
  let s = ''
  for (let i = 0; i < len; i++) s += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]
  return s
}

export async function hashPassword(pw: string) {
  const salt = crypto.randomBytes(16)
  const h = await scrypt(pw, salt, 32)
  return `scrypt$${salt.toString('base64')}$${h.toString('base64')}`
}

export async function verifyPassword(pw: string, stored: string) {
  const [alg, salt, hash] = stored.split('$')
  if (alg !== 'scrypt') return false
  const h = await scrypt(pw, Buffer.from(salt, 'base64'), 32)
  const expected = Buffer.from(hash, 'base64')
  return h.length === expected.length && crypto.timingSafeEqual(h, expected)
}

export function createPlayer(name: string, lang: string): PlayerRow {
  for (;;) {
    const publicId = randomCode(8)
    try {
      const r = run('INSERT INTO players(public_id,name,lang,created_at) VALUES(?,?,?,?)', publicId, name, lang, now())
      return get<PlayerRow>('SELECT * FROM players WHERE id=?', Number(r.lastInsertRowid))!
    } catch (e: any) {
      if (!String(e?.message).includes('UNIQUE')) throw e
    }
  }
}

export function createSession(playerId: number, label: string | null = null) {
  const token = newToken()
  run('INSERT INTO sessions(token_hash,player_id,label,created_at) VALUES(?,?,?,?)', sha256(token), playerId, label, now())
  return token
}

export function authenticate(header: string | undefined): PlayerRow | null {
  const m = /^Bearer ([\w-]{20,100})$/.exec(header ?? '')
  if (!m) return null
  const p = get<PlayerRow>(
    'SELECT p.* FROM sessions s JOIN players p ON p.id=s.player_id WHERE s.token_hash=? AND p.deleted=0',
    sha256(m[1]),
  )
  if (!p) return null
  if (!p.last_seen || now() - p.last_seen > 60_000) run('UPDATE players SET last_seen=? WHERE id=?', now(), p.id)
  return p
}

export const cleanName = (n: unknown) => {
  const s = String(n ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().replace(/\s+/g, ' ')
  if (s.length < 2 || s.length > 24) throw new HttpError(400, 'bad_name')
  return s
}
