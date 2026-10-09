// Admin-Zugang: fester Login aus der Umgebung (ADMIN_USER/ADMIN_PASSWORD) → Session-Cookie; optional ADMIN_TOKEN für Skripte.
import crypto from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { config } from './config.ts'
import { newToken, sha256 } from './auth.ts'

export const MIN_PASSWORD = 12
export const COOKIE = 'rp_admin'

/** Konstantzeit-Vergleich (über Hashes gleicher Länge, daher kein Längen-Leak). */
export const safeEqual = (a: string, b: string) => crypto.timingSafeEqual(Buffer.from(sha256(a)), Buffer.from(sha256(b)))

export const loginEnabled = () => !!config.adminUser && config.adminPassword.length >= MIN_PASSWORD
export const adminEnabled = () => loginEnabled() || !!config.adminToken

/** Beschreibt die Konfiguration für das Startlog (und deckt unsichere Einstellungen auf). */
export function adminStatus(): string {
  const parts: string[] = []
  if (config.adminUser || config.adminPassword) {
    if (!config.adminUser) parts.push('ADMIN_USER fehlt → Login AUS')
    else if (config.adminPassword.length < MIN_PASSWORD) parts.push(`ADMIN_PASSWORD kürzer als ${MIN_PASSWORD} Zeichen → Login AUS`)
    else parts.push('Login an')
  }
  if (config.adminToken) parts.push('Token-Zugang an (Skripte)')
  return parts.length ? parts.join(', ') : 'aus'
}

/** Beide Felder werden immer verglichen (kein früher Abbruch, der verrät, welches Feld stimmt). */
export function credentialsOk(user: string, password: string): boolean {
  if (!loginEnabled()) return false
  const u = safeEqual(user, config.adminUser)
  const p = safeEqual(password, config.adminPassword)
  return u && p
}

/* ---------- Sitzungen (im Speicher; ein Neustart meldet ab) ---------- */
const sessions = new Map<string, number>() // sha256(token) → Ablaufzeit

export function openSession(): string {
  const t = Date.now()
  for (const [k, exp] of sessions) if (exp < t) sessions.delete(k)
  while (sessions.size >= 20) sessions.delete(sessions.keys().next().value!)
  const token = newToken()
  sessions.set(sha256(token), t + config.adminSessionMs)
  return token
}
export function validSession(token: string | undefined): boolean {
  if (!token) return false
  const h = sha256(token)
  const exp = sessions.get(h)
  if (!exp) return false
  if (exp < Date.now()) { sessions.delete(h); return false }
  return true
}
export const closeSession = (token: string | undefined) => { if (token) sessions.delete(sha256(token)) }

/* ---------- Fehlversuche je IP ---------- */
const FAIL_WINDOW = 15 * 60_000
export const MAX_FAILS = 5
const fails = new Map<string, number[]>()
const recent = (ip: string) => (fails.get(ip) ?? []).filter((t) => Date.now() - t < FAIL_WINDOW)
export const loginBlocked = (ip: string) => recent(ip).length >= MAX_FAILS
export const recordFailure = (ip: string) => fails.set(ip, [...recent(ip), Date.now()])
export const clearFailures = (ip: string) => fails.delete(ip)

/* ---------- Cookie ---------- */
export function parseCookie(header: string | undefined, name: string): string | undefined {
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim()
  }
  return undefined
}

/** HTTPS erkennen: direkt (TLS) oder – nur mit TRUST_PROXY – laut X-Forwarded-Proto des Proxys (letzter Eintrag). */
export function isHttps(req: Pick<IncomingMessage, 'headers' | 'socket'>): boolean {
  if ((req.socket as { encrypted?: boolean }).encrypted) return true
  if (!config.trustProxy) return false
  const protos = String(req.headers['x-forwarded-proto'] ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)
  return protos.at(-1) === 'https'
}

export function sessionCookie(token: string, req: Pick<IncomingMessage, 'headers' | 'socket'>, maxAgeSec: number): string {
  return `${COOKIE}=${token}; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${isHttps(req) ? '; Secure' : ''}`
}

/** Schutz vor Cross-Site-Anfragen mit Cookie (zusätzlich zu SameSite=Strict): Origin muss zum Host passen. */
export function sameOriginOk(req: Pick<IncomingMessage, 'headers'>): boolean {
  const origin = req.headers.origin
  if (origin) { try { return new URL(origin).host === req.headers.host } catch { return false } }
  return req.headers['sec-fetch-site'] === 'same-origin'
}
