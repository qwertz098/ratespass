process.env.DB_PATH = ':memory:'
process.env.ADMIN_TOKEN = 'test-admin-token'
process.env.CONSENT_REQUIRED ??= '0' // Zustimmung testet test/privacy.test.ts gezielt
process.env.PUSH_ALLOW_INSECURE = '1' // erlaubt nur http://127.0.0.1 für den Fake-Push-Dienst im Test

export const { createApp } = await import('../server/app.ts')
export const { db, all, get, run } = await import('../server/db.ts')
export const { importBatch } = await import('../server/questions.ts')
import fs from 'node:fs'

export async function boot(seed = true) {
  if (seed) {
    const r = importBatch(JSON.parse(fs.readFileSync(new URL('../batches/seed-000.json', import.meta.url), 'utf8')))
    if (r.errors.length) throw new Error(r.errors.join('\n'))
  }
  const server = createApp()
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(server.address() as any).port}`
  const call = async (method: string, path: string, body?: unknown, token?: string, headers: Record<string, string> = {}) => {
    const res = await fetch(base + path, {
      method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    let json: any
    try { json = JSON.parse(text) } catch { json = text }
    return { status: res.status, json, headers: res.headers }
  }
  const newPlayer = async (name?: string) => {
    const r = await call('POST', '/api/players', { name, lang: 'de' })
    return { token: r.json.token as string, player: r.json.player }
  }
  return { server, base, call, newPlayer, close: () => { server.close(); server.closeAllConnections() } }
}

/** Findet im Test per DB die richtige Antwort-Position der aktuellen Frage (nur für Tests). */
export function correctIndexFor(gameId: number, round: number, idx: number): number {
  const rq = get<{ perm: string }>('SELECT perm FROM round_questions WHERE game_id=? AND round=? AND idx=?', gameId, round, idx)!
  return (JSON.parse(rq.perm) as number[]).indexOf(0)
}
