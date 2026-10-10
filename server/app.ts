import crypto from 'node:crypto'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { authenticate } from './auth.ts'
import { config } from './config.ts'
import { get } from './db.ts'
import { HttpError, readJson, sendJson, type Ctx } from './http.ts'
import { router } from './api.ts'
import { hasConsent } from './privacy.ts'
import { VERSION } from './version.ts'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2',
  '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
}

const CONSENT_FREE = new Set(['GET /api/me', 'DELETE /api/me', 'POST /api/consent', 'GET /api/export', 'POST /api/logout'])

const CSP = [
  "default-src 'self'", "img-src 'self' data:", "script-src 'self'", "style-src 'self'", "connect-src 'self'",
  "manifest-src 'self'", "worker-src 'self'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
].join('; ')

/**
 * Client-IP. Ohne TRUST_PROXY zählt nur die Socket-Adresse. Mit TRUST_PROXY wird `X-Forwarded-For` ausgewertet – aber von
 * RECHTS: Jeder vertrauenswürdige Proxy hängt die Adresse seines Gegenübers hinten an, alles davor kann der Client frei erfinden.
 * `hops` = Anzahl der Proxys vor der App (nginx/NPM/Caddy: 1; Cloudflare davor: 2).
 */
export function clientIp(req: Pick<http.IncomingMessage, 'headers' | 'socket'>, opts = { trust: config.trustProxy, hops: config.proxyHops }) {
  const socketIp = req.socket.remoteAddress ?? 'unknown'
  if (!opts.trust) return socketIp
  const chain = String(req.headers['x-forwarded-for'] ?? '').split(',').map((x) => x.trim()).filter(Boolean)
  const ip = chain.length >= opts.hops ? chain[chain.length - opts.hops] : undefined
  return ip && ip.length <= 64 ? ip.replace(/^::ffff:/, '') : socketIp
}

/** Version als kleine JS-Dateien (nie zwischengespeichert): `/version.js` für die App (ES-Modul), `/sw-version.js` für den Service Worker. */
function serveVersion(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): boolean {
  const body = pathname === '/version.js' ? `export const VERSION = '${VERSION}'\n` : pathname === '/sw-version.js' ? `self.APP_VERSION = '${VERSION}'\n` : null
  if (body === null) return false
  res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache, no-store', 'content-length': Buffer.byteLength(body) })
  res.end(req.method === 'HEAD' ? undefined : body)
  return true
}

/** Versionsstempel: HTML und JS-Module verweisen auf `…?v=<Version>`. Jede neue Version hat damit neue Adressen, die kein (alter) Service Worker und kein
 *  Browser-Cache kennt – so holt auch ein Gerät mit alter App nach dem ersten Neuladen alles frisch. Bibliotheken (vendor/) und sw.js bleiben unverändert. */
function stamp(rel: string, ext: string, body: string): string {
  if (rel.startsWith('/vendor/') || rel === '/sw.js') return body
  if (ext === '.html') return body.replace(/(src|href)="(\/[\w.\-/]+\.(?:js|css))"/g, (m, a, u) => (u.startsWith('/vendor/') ? m : `${a}="${u}?v=${VERSION}"`))
  if (ext === '.js') return body.replace(/(from\s+['"])(\.\/[\w.-]+\.js)(['"])/g, `$1$2?v=${VERSION}$3`)
  return body
}

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, pathname: string) {
  if (serveVersion(req, res, pathname)) return
  let rel = decodeURIComponent(pathname)
  if (rel === '/reset') rel = '/reset.html'
  if (rel === '/' || /^\/i\/[A-Za-z0-9]+$/.test(rel)) rel = '/index.html'
  if (rel === '/admin') rel = '/admin.html'
  const file = path.join(config.webDir, path.normalize(rel))
  if (!file.startsWith(config.webDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) throw new HttpError(404, 'not_found')
  const ext = path.extname(file)
  if (ext === '.html' || ext === '.js') {
    const body = stamp(rel, ext, fs.readFileSync(file, 'utf8'))
    const etag = `W/"${crypto.createHash('sha1').update(body).digest('hex').slice(0, 16)}"`
    const headers = { 'content-type': TYPES[ext], etag, 'cache-control': 'no-cache' }
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); res.end(); return }
    res.writeHead(200, { ...headers, 'content-length': Buffer.byteLength(body) })
    res.end(req.method === 'HEAD' ? undefined : body)
    return
  }
  const st = fs.statSync(file)
  const etag = `W/"${st.size}-${Math.floor(st.mtimeMs)}"`
  const headers = {
    'content-type': TYPES[ext] ?? 'application/octet-stream', etag,
    'cache-control': ext === '.png' || ext === '.svg' || ext === '.woff2' ? 'public, max-age=86400' : 'no-cache',
  }
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); res.end(); return }
  res.writeHead(200, { ...headers, 'content-length': st.size })
  if (req.method === 'HEAD') res.end()
  else fs.createReadStream(file).pipe(res)
}

export function createApp() {
  return http.createServer(async (req, res) => {
    res.setHeader('content-security-policy', CSP)
    res.setHeader('x-app-version', VERSION)
    res.setHeader('x-content-type-options', 'nosniff')
    res.setHeader('referrer-policy', 'same-origin')
    res.setHeader('permissions-policy', 'camera=(self), microphone=(), geolocation=()')
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const method = req.method ?? 'GET'
      if (url.pathname === '/healthz') {
        get('SELECT 1')
        res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); return
      }
      if (!url.pathname.startsWith('/api/')) {
        if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'method_not_allowed')
        return serveStatic(req, res, url.pathname)
      }
      const m = router.match(method, url.pathname)
      if (m === null) throw new HttpError(404, 'not_found')
      if (m === 'method') throw new HttpError(405, 'method_not_allowed')
      const ctx: Ctx = {
        req, res, url, params: m.params, ip: clientIp(req), player: null,
        body: method === 'GET' || method === 'HEAD' ? {} : await readJson(req),
      }
      if (m.route.auth) {
        ctx.player = authenticate(req.headers.authorization)
        if (!ctx.player) throw new HttpError(401, 'unauthorized')
        // Ohne Zustimmung zur aktuellen Datenschutzerklärung nur Zustimmung, Profilabruf, Export und Löschen erlaubt
        if (config.requireConsent && !CONSENT_FREE.has(`${method} ${url.pathname}`) && !hasConsent(ctx.player.id)) throw new HttpError(403, 'consent_required')
      }
      const out = await m.route.handler(ctx)
      if (!res.headersSent) sendJson(res, 200, out ?? { ok: true })
    } catch (e) {
      if (res.headersSent) return res.end()
      if (e instanceof HttpError) return sendJson(res, e.status, { error: e.code, message: e.message })
      console.error(e)
      sendJson(res, 500, { error: 'internal' })
    }
  })
}
