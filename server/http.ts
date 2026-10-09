import type { IncomingMessage, ServerResponse } from 'node:http'
import type { PlayerRow } from './auth.ts'

export class HttpError extends Error {
  status: number
  code: string
  constructor(status: number, code: string, message?: string) {
    super(message ?? code)
    this.status = status
    this.code = code
  }
}

export interface Ctx {
  req: IncomingMessage
  res: ServerResponse
  url: URL
  params: Record<string, string>
  body: any
  ip: string
  player: PlayerRow | null
}

export type Handler = (ctx: Ctx) => unknown | Promise<unknown>
interface Route { method: string; re: RegExp; keys: string[]; handler: Handler; auth: boolean }

export class Router {
  routes: Route[] = []
  add(method: string, pattern: string, handler: Handler, opts: { auth?: boolean } = {}) {
    const keys: string[] = []
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '/?$')
    this.routes.push({ method, re, keys, handler, auth: opts.auth ?? true })
  }
  get = (p: string, h: Handler, o?: { auth?: boolean }) => this.add('GET', p, h, o)
  post = (p: string, h: Handler, o?: { auth?: boolean }) => this.add('POST', p, h, o)
  patch = (p: string, h: Handler, o?: { auth?: boolean }) => this.add('PATCH', p, h, o)
  delete = (p: string, h: Handler, o?: { auth?: boolean }) => this.add('DELETE', p, h, o)
  match(method: string, path: string) {
    let pathMatched = false
    for (const r of this.routes) {
      const m = r.re.exec(path)
      if (!m) continue
      pathMatched = true
      if (r.method !== method) continue
      const params: Record<string, string> = {}
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])))
      return { route: r, params }
    }
    return pathMatched ? 'method' : null
  }
}

export async function readJson(req: IncomingMessage, limit = 64 * 1024): Promise<any> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    size += (c as Buffer).length
    if (size > limit) throw new HttpError(413, 'too_large')
    chunks.push(c as Buffer)
  }
  if (!size) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'bad_json')
  }
}

export function sendJson(res: ServerResponse, status: number, data: unknown, headers: Record<string, string> = {}) {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...headers,
  })
  res.end(body)
}

const hits = new Map<string, number[]>()
/** Einfaches In-Memory-Rate-Limit (Fenster in ms). */
export function rateLimit(key: string, max: number, windowMs: number) {
  const t = Date.now()
  const arr = (hits.get(key) ?? []).filter((x) => t - x < windowMs)
  if (arr.length >= max) throw new HttpError(429, 'rate_limited')
  arr.push(t)
  hits.set(key, arr)
}
setInterval(() => {
  const t = Date.now()
  for (const [k, v] of hits) if (!v.some((x) => t - x < 3_600_000)) hits.delete(k)
}, 600_000).unref()
