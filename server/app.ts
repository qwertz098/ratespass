import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { authenticate } from './auth.ts'
import { config } from './config.ts'
import { get } from './db.ts'
import { HttpError, readJson, sendJson, type Ctx } from './http.ts'
import { router } from './api.ts'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
}

const CSP = [
  "default-src 'self'", "img-src 'self' data:", "script-src 'self'", "style-src 'self'", "connect-src 'self'",
  "manifest-src 'self'", "worker-src 'self'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
].join('; ')

function clientIp(req: http.IncomingMessage) {
  if (config.trustProxy) {
    const xf = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim()
    if (xf) return xf
  }
  return req.socket.remoteAddress ?? 'unknown'
}

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, pathname: string) {
  let rel = decodeURIComponent(pathname)
  if (rel === '/' || /^\/i\/[A-Za-z0-9]+$/.test(rel)) rel = '/index.html'
  if (rel === '/admin') rel = '/admin.html'
  const file = path.join(config.webDir, path.normalize(rel))
  if (!file.startsWith(config.webDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) throw new HttpError(404, 'not_found')
  const st = fs.statSync(file)
  const etag = `W/"${st.size}-${Math.floor(st.mtimeMs)}"`
  const ext = path.extname(file)
  const headers = {
    'content-type': TYPES[ext] ?? 'application/octet-stream', etag,
    'cache-control': ext === '.png' || ext === '.svg' ? 'public, max-age=86400' : 'no-cache',
  }
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); res.end(); return }
  res.writeHead(200, { ...headers, 'content-length': st.size })
  if (req.method === 'HEAD') res.end()
  else fs.createReadStream(file).pipe(res)
}

export function createApp() {
  return http.createServer(async (req, res) => {
    res.setHeader('content-security-policy', CSP)
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
