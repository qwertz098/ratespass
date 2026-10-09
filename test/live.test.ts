import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { boot, get, all, run, importBatch } from './helpers.ts'

const t = await boot()
const { call, newPlayer, base } = t
for (const f of ['original-001', 'original-002']) assert.deepEqual(importBatch(JSON.parse(fs.readFileSync(new URL(`../batches/${f}.json`, import.meta.url), 'utf8'))).errors, [])
const { config } = await import('../server/config.ts')
const live = await import('../server/live.ts')
Object.assign(config.live, { questionMs: 700, revealMs: 120, tempoQuestions: 3 })
test.after(() => { live.closeAll(); t.close() })

/** SSE-Client: sammelt `state`-Ereignisse. */
async function watch(token: string, id: number) {
  const states: any[] = []
  const ac = new AbortController()
  const res = await fetch(`${base}/api/live/${id}/events`, { headers: { authorization: `Bearer ${token}` }, signal: ac.signal })
  const status = res.status, type = res.headers.get('content-type'), buffering = res.headers.get('x-accel-buffering')
  if (status === 200) (async () => {
    const reader = res.body!.getReader(), dec = new TextDecoder(); let buf = ''
    try { for (;;) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true }); let i; while ((i = buf.indexOf('\n\n')) >= 0) { const chunk = buf.slice(0, i); buf = buf.slice(i + 2); const d = /^data: (.*)$/m.exec(chunk); if (d && /^event: state/m.test(chunk)) states.push(JSON.parse(d[1])) } } } catch { /* abgebrochen */ }
  })()
  const waitFor = async (pred: (s: any) => boolean, ms = 4000) => { const end = Date.now() + ms; for (;;) { const hit = states.find(pred); if (hit) return hit; if (Date.now() > end) throw new Error('Timeout; letzter Stand: ' + JSON.stringify(states.at(-1)?.status)); await new Promise((r) => setTimeout(r, 15)) } }
  return { states, status, type, buffering, waitFor, close: () => ac.abort() }
}
const correctOf = (gid: number, idx: number) => (JSON.parse(get<{ perm: string }>('SELECT perm FROM live_questions WHERE game_id=? AND idx=?', gid, idx)!.perm) as number[]).indexOf(0)
const answer = (tok: string, gid: number, idx: number, choice: number) => call('POST', `/api/live/${gid}/answer`, { idx, choice }, tok)

test('Beitritt nur per Token des Hosts; Lobby-Regeln', async () => {
  const [h, g, x] = [await newPlayer('Gastgeber'), await newPlayer('Gast'), await newPlayer('Fremder')]
  assert.equal((await call('POST', '/api/live', { mode: 'chaos' }, h.token)).status, 400)
  const c = (await call('POST', '/api/live', { mode: 'tempo', screen: false }, h.token)).json
  assert.match(c.live.token, /^[\w-]{16}$/); assert.equal(c.live.is_host, true); assert.equal(c.live.players.length, 1, 'Host spielt im Handy-Modus mit')
  assert.equal((await call('GET', `/api/live/${c.id}`, undefined, x.token)).status, 404, 'Nichtmitglied sieht nichts')
  const w = await watch(x.token, c.id); assert.equal(w.status, 404)
  assert.equal((await call('POST', '/api/live/join', { token: 'erfunden' }, g.token)).status, 404)
  assert.equal((await call('POST', `/api/live/${c.id}/start`, {}, h.token)).status, 409, 'allein starten nicht möglich')
  const j = await call('POST', '/api/live/join', { token: c.live.token }, g.token)
  assert.equal(j.status, 200); assert.equal(j.json.live.token, null, 'Token nur für den Host sichtbar')
  assert.equal((await call('POST', `/api/live/${c.id}/start`, {}, g.token)).status, 404, 'nur der Host darf starten')
  // Token erneuern macht den alten ungültig
  const old = c.live.token
  await call('POST', `/api/live/${c.id}/renew`, {}, h.token)
  assert.equal((await call('POST', '/api/live/join', { token: old }, x.token)).status, 404)
  const fresh = (await call('GET', `/api/live/${c.id}`, undefined, h.token)).json.live.token
  assert.notEqual(fresh, old)
  // Ablauf der Gültigkeit
  run('UPDATE live_games SET token_expires=1 WHERE id=?', c.id)
  assert.equal((await call('POST', '/api/live/join', { token: fresh }, x.token)).status, 409)
  // Kick in der Lobby
  assert.equal((await call('POST', `/api/live/${c.id}/kick`, { public_id: g.player.public_id }, h.token)).status, 200)
  assert.equal((await call('GET', `/api/live/${c.id}`, undefined, g.token)).status, 404)
  await call('POST', `/api/live/${c.id}/end`, {}, h.token)
})

test('Tempo-Quiz: Echtzeit-Zustände, Antwort wird erst in der Auflösung verraten, Punkte nach Tempo, früher Abschluss', async () => {
  const [h, g] = [await newPlayer('Moderator'), await newPlayer('Mitspieler')]
  const c = (await call('POST', '/api/live', { mode: 'tempo', screen: false }, h.token)).json
  await call('POST', '/api/live/join', { token: c.live.token }, g.token)
  const wh = await watch(h.token, c.id), wg = await watch(g.token, c.id)
  assert.equal(wh.status, 200); assert.match(wh.type!, /text\/event-stream/); assert.equal(wh.buffering, 'no')
  await wg.waitFor((s) => s.status === 'lobby' && s.players.length === 2)
  assert.equal((await call('POST', `/api/live/${c.id}/start`, {}, h.token)).status, 200)
  const q0 = await wg.waitFor((s) => s.status === 'question' && s.idx === 0)
  assert.equal(q0.total, 3); assert.equal(q0.question.options.length, 4)
  assert.ok(!('correct_index' in q0.question) && q0.question.counts === undefined, 'noch keine Lösung')
  assert.equal(q0.token, null, 'QR-Token nach Start nicht mehr')
  // beide richtig → sofort Auflösung (ohne die 700 ms abzuwarten)
  const t0 = Date.now()
  assert.equal((await answer(g.token, c.id, 0, correctOf(c.id, 0))).status, 200)
  assert.equal((await answer(g.token, c.id, 0, 1)).status, 409, 'nur eine Antwort je Frage')
  assert.equal((await answer(h.token, c.id, 1, 0)).status, 400, 'falscher Index')
  await answer(h.token, c.id, 0, (correctOf(c.id, 0) + 1) % 4)
  const r0 = await wg.waitFor((s) => s.status === 'reveal' && s.idx === 0)
  assert.ok(Date.now() - t0 < 600, 'früh aufgelöst')
  assert.equal(r0.question.correct_index, correctOf(c.id, 0)); assert.equal(r0.me.correct, true); assert.ok(r0.me.points >= 500 && r0.me.points <= 1000)
  assert.equal(r0.question.counts.reduce((a: number, b: number) => a + b, 0), 2)
  const rh = await wh.waitFor((s) => s.status === 'reveal' && s.idx === 0); assert.equal(rh.me.correct, false); assert.equal(rh.me.points, 0)
  // restliche Fragen: der Mitspieler antwortet immer richtig, der Host nie → am Ende gewinnt der Mitspieler
  for (let i = 1; i < 3; i++) { await wg.waitFor((s) => s.status === 'question' && s.idx === i); await answer(g.token, c.id, i, correctOf(c.id, i)) }
  const fin = await wg.waitFor((s) => s.status === 'finished', 6000)
  assert.equal(fin.players[0].name, 'Mitspieler'); assert.ok(fin.players[0].score > fin.players[1].score); assert.equal(fin.players[1].score, 0)
  wh.close(); wg.close()
  const counted = all("SELECT 1 FROM live_answers WHERE game_id=?", c.id).length
  assert.ok(counted >= 4)
})

test('Survival-Leiter mit Bildschirm-Modus: Falsche scheiden aus, Ende wenn einer übrig ist', async () => {
  const [h, a, b, c3] = [await newPlayer('Bildschirm'), await newPlayer('Immer Richtig'), await newPlayer('Sofort Raus'), await newPlayer('Zweite Runde')]
  const c = (await call('POST', '/api/live', { mode: 'survival', screen: true }, h.token)).json
  assert.equal(c.live.players.length, 0, 'Bildschirm-Modus: Host spielt nicht mit')
  for (const p of [a, b, c3]) await call('POST', '/api/live/join', { token: c.live.token }, p.token)
  assert.equal((await answer(h.token, c.id, 0, 0)).status, 409, 'Host im Bildschirm-Modus kann nicht antworten')
  const wh = await watch(h.token, c.id)
  await call('POST', `/api/live/${c.id}/start`, {}, h.token)
  assert.equal(all('SELECT 1 FROM live_questions WHERE game_id=?', c.id).length, 15, 'Leiter mit 15 Stufen')
  await wh.waitFor((s) => s.status === 'question' && s.idx === 0)
  await answer(a.token, c.id, 0, correctOf(c.id, 0)); await answer(b.token, c.id, 0, (correctOf(c.id, 0) + 1) % 4); await answer(c3.token, c.id, 0, correctOf(c.id, 0))
  const r0 = await wh.waitFor((s) => s.status === 'reveal' && s.idx === 0)
  assert.deepEqual(r0.players.map((p: any) => [p.name, p.alive]).sort(), [['Immer Richtig', true], ['Sofort Raus', false], ['Zweite Runde', true]])
  await wh.waitFor((s) => s.status === 'question' && s.idx === 1)
  assert.equal((await answer(b.token, c.id, 1, 0)).status, 409, 'Ausgeschiedene antworten nicht mehr')
  await answer(a.token, c.id, 1, correctOf(c.id, 1)); await answer(c3.token, c.id, 1, (correctOf(c.id, 1) + 1) % 4)
  const fin = await wh.waitFor((s) => s.status === 'finished', 6000)
  assert.equal(fin.players[0].name, 'Immer Richtig'); assert.equal(fin.players[0].alive, true); assert.equal(fin.players[0].pos, 2)
  assert.equal(fin.players.find((p: any) => p.name === 'Zweite Runde').pos, 1)
  assert.equal(fin.question.prize, 200)
  wh.close()
})

test('Zeitablauf: ohne Antworten löst der Server selbst auf; Host kann überspringen und beenden', async () => {
  const [h, g] = [await newPlayer('Wartender Host'), await newPlayer('Schlafmütze')]
  const c = (await call('POST', '/api/live', { mode: 'tempo' }, h.token)).json
  await call('POST', '/api/live/join', { token: c.live.token }, g.token)
  const w = await watch(g.token, c.id)
  await call('POST', `/api/live/${c.id}/start`, {}, h.token)
  const t0 = Date.now()
  const r = await w.waitFor((s) => s.status === 'reveal' && s.idx === 0)
  assert.ok(Date.now() - t0 >= 550, 'erst nach Ablauf der Fragezeit'); assert.equal(r.me.correct, undefined, 'keine Antwort abgegeben')
  await w.waitFor((s) => s.status === 'question' && s.idx === 1)
  assert.equal((await call('POST', `/api/live/${c.id}/next`, {}, g.token)).status, 404, 'nur Host')
  await call('POST', `/api/live/${c.id}/next`, {}, h.token) // Frage sofort beenden
  await w.waitFor((s) => s.status === 'reveal' && s.idx === 1, 1000)
  assert.equal((await call('POST', `/api/live/${c.id}/end`, {}, h.token)).status, 200)
  await w.waitFor((s) => s.status === 'finished')
  assert.equal((await call('POST', '/api/live/join', { token: c.live.token }, (await newPlayer('Zu Spät')).token)).status, 404)
  w.close()
})

test('Neustart: Zeitgeber werden aus der Datenbank wieder aufgenommen; Leaderboard zählt Live-Antworten', async () => {
  const [h, g] = [await newPlayer('Neustart Host'), await newPlayer('Neustart Gast')]
  const c = (await call('POST', '/api/live', { mode: 'tempo' }, h.token)).json
  await call('POST', '/api/live/join', { token: c.live.token }, g.token)
  await call('POST', `/api/live/${c.id}/start`, {}, h.token)
  live.closeAll() // simuliert Prozessende: alle Zeitgeber weg
  await new Promise((r) => setTimeout(r, 900)) // Fragezeit abgelaufen
  assert.equal(get<{ status: string }>('SELECT status FROM live_games WHERE id=?', c.id)!.status, 'question', 'ohne Zeitgeber passiert nichts')
  live.resumeLive()
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(get<{ status: string }>('SELECT status FROM live_games WHERE id=?', c.id)!.status, 'reveal', 'abgelaufene Phase wird sofort nachgeholt')
  // Leaderboard-Quelle kennt Live-Antworten
  const { ANSWER_SOURCES } = await import('../server/leaderboard.ts')
  assert.ok(ANSWER_SOURCES.some((s) => s.includes('live_answers')))
  const { db } = await import('./helpers.ts')
  assert.doesNotThrow(() => db.prepare(`SELECT COUNT(*) FROM (${ANSWER_SOURCES.join(' UNION ALL ')})`).get())
})
