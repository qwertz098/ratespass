import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { boot, get, all, run, importBatch } from './helpers.ts'

const t = await boot()
const { call, newPlayer, base } = t
for (const f of ['original-001', 'original-002']) assert.deepEqual(importBatch(JSON.parse(fs.readFileSync(new URL(`../batches/${f}.json`, import.meta.url), 'utf8'))).errors, [])
const { config } = await import('../server/config.ts')
const live = await import('../server/live.ts')
Object.assign(config.live, { questionMs: 700, revealMs: 120, tempoQuestions: 3, raceQuestions: 14, betQuestions: 3, betMs: 400 })
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

const wrongOf = (gid: number, idx: number) => (correctOf(gid, idx) + 1) % 4

test('Rennen: richtig = 1 Feld, schnellste richtige +1, Ziel bei 12 Feldern beendet das Spiel', async () => {
  const [h, a, b] = [await newPlayer('Renn Host'), await newPlayer('Renn Schnell'), await newPlayer('Renn Langsam')]
  const c = (await call('POST', '/api/live', { mode: 'race', screen: true }, h.token)).json
  for (const p of [a, b]) await call('POST', '/api/live/join', { token: c.live.token }, p.token)
  const w = await watch(h.token, c.id)
  await call('POST', `/api/live/${c.id}/start`, {}, h.token)
  assert.equal(all('SELECT 1 FROM live_questions WHERE game_id=?', c.id).length, 14)
  for (let i = 0; i < 6; i++) {
    await w.waitFor((s) => s.status === 'question' && s.idx === i)
    await answer(a.token, c.id, i, correctOf(c.id, i)); await answer(b.token, c.id, i, i % 2 ? correctOf(c.id, i) : wrongOf(c.id, i))
    await w.waitFor((s) => s.status === 'reveal' && s.idx === i)
  }
  const fin = await w.waitFor((s) => s.status === 'finished', 4000)
  assert.equal(fin.race_length, 12)
  assert.equal(fin.players[0].name, 'Renn Schnell'); assert.ok(fin.players[0].pos >= 12, 'Ziel erreicht')
  assert.ok(fin.players[1].pos < fin.players[0].pos); assert.equal(fin.idx, 5, 'Spiel endet in der Frage, in der das Ziel erreicht wird')
  w.close()
})

test('Einsatz: Kategorie vorab, Einsatz setzen, richtig +Einsatz, falsch −Einsatz (nie unter 0), letzte Frage doppelt', async () => {
  const [h, a, b] = [await newPlayer('Wett Host'), await newPlayer('Wett Mutig'), await newPlayer('Wett Pleite')]
  const c = (await call('POST', '/api/live', { mode: 'bet', screen: true }, h.token)).json
  for (const p of [a, b]) await call('POST', '/api/live/join', { token: c.live.token }, p.token)
  const w = await watch(a.token, c.id)
  await call('POST', `/api/live/${c.id}/start`, {}, h.token)
  const bet = (tok: string, idx: number, amount: unknown) => call('POST', `/api/live/${c.id}/bet`, { idx, amount }, tok)
  // Frage 1: Einsatzphase zeigt nur die Kategorie, keine Frage
  const b0 = await w.waitFor((s) => s.status === 'bet' && s.idx === 0)
  assert.ok(b0.question.category && b0.question.text === undefined && b0.question.options === undefined, 'nur Kategorie sichtbar')
  assert.equal(b0.me.score, 1000, 'Startkapital')
  assert.equal((await answer(a.token, c.id, 0, 0)).status, 409, 'in der Einsatzphase kann nicht geantwortet werden')
  assert.equal((await bet(a.token, 0, 250)).status, 400, 'nur feste Stufen')
  assert.equal((await bet(a.token, 1, 100)).status, 409, 'falscher Index')
  assert.equal((await bet(a.token, 0, 300)).status, 200); assert.equal((await bet(b.token, 0, -1)).status, 200, 'All-in')
  await w.waitFor((s) => s.status === 'question' && s.idx === 0, 1000) // alle haben gesetzt → sofort Frage
  await answer(a.token, c.id, 0, correctOf(c.id, 0)); await answer(b.token, c.id, 0, wrongOf(c.id, 0))
  const r0 = await w.waitFor((s) => s.status === 'reveal' && s.idx === 0)
  assert.equal(r0.me.points, 300); assert.equal(r0.me.score, 1300)
  assert.deepEqual(r0.players.map((p: any) => [p.name, p.score]), [['Wett Mutig', 1300], ['Wett Pleite', 0]], 'All-in falsch = 0, nie negativ')
  // Frage 2: ohne Einsatz gilt 100; Pleite darf trotzdem spielen
  await w.waitFor((s) => s.status === 'question' && s.idx === 1, 2000) // Einsatzphase läuft ab (400 ms)
  await answer(a.token, c.id, 1, wrongOf(c.id, 1)); await answer(b.token, c.id, 1, correctOf(c.id, 1))
  const r1 = await w.waitFor((s) => s.status === 'reveal' && s.idx === 1)
  assert.equal(r1.players.find((p: any) => p.name === 'Wett Mutig').score, 1200, '−100 Standard-Einsatz')
  assert.equal(r1.players.find((p: any) => p.name === 'Wett Pleite').score, 100)
  // Frage 3 = Finale: doppelter Einsatz
  const b2 = await w.waitFor((s) => s.status === 'bet' && s.idx === 2); assert.equal(b2.bet.final, true)
  await bet(a.token, 2, 500); await bet(b.token, 2, 100)
  await w.waitFor((s) => s.status === 'question' && s.idx === 2, 1000)
  await answer(a.token, c.id, 2, correctOf(c.id, 2)); await answer(b.token, c.id, 2, wrongOf(c.id, 2))
  const fin = await w.waitFor((s) => s.status === 'finished', 4000)
  assert.deepEqual(fin.players.map((p: any) => [p.name, p.score]), [['Wett Mutig', 2200], ['Wett Pleite', 0]])
  assert.equal(all('SELECT 1 FROM live_bets WHERE game_id=?', c.id).length, 6)
  w.close()
})

test('Teams: Teamwahl in der Lobby, automatischer Ausgleich, Teamwertung als Durchschnitt; nicht für Survival/Rennen', async () => {
  const [h, a, b, d] = [await newPlayer('Team Host'), await newPlayer('Team A'), await newPlayer('Team B'), await newPlayer('Team C')]
  const c = (await call('POST', '/api/live', { mode: 'tempo', screen: true }, h.token)).json
  for (const p of [a, b, d]) await call('POST', '/api/live/join', { token: c.live.token }, p.token)
  const set = (teams: unknown, mode?: unknown) => call('POST', `/api/live/${c.id}/settings`, { teams, mode }, h.token)
  assert.equal((await set(5)).status, 400)
  assert.equal((await set(2)).status, 200)
  assert.equal((await call('POST', `/api/live/${c.id}/team`, { team: 3 }, a.token)).status, 400, 'nur vorhandene Teams')
  assert.equal((await call('POST', `/api/live/${c.id}/team`, { team: 1 }, a.token)).json.live.me.team, 1)
  assert.equal((await set(2, 'race')).json.live.teams, 0, 'Rennen ohne Teams')
  assert.equal((await set(2, 'bet')).json.live.teams, 2, 'Einsatz mit Teams')
  assert.equal((await set(0, 'tempo')).json.live.teams, 0)
  await set(2, 'tempo'); await call('POST', `/api/live/${c.id}/team`, { team: 1 }, a.token)
  const w = await watch(h.token, c.id)
  await call('POST', `/api/live/${c.id}/start`, {}, h.token)
  const teamOf = (n: string, s: any) => s.players.find((p: any) => p.name === n).team
  const q0 = await w.waitFor((s) => s.status === 'question' && s.idx === 0)
  assert.equal(teamOf('Team A', q0), 1, 'gewähltes Team bleibt'); assert.ok([1, 2].includes(teamOf('Team B', q0)) && [1, 2].includes(teamOf('Team C', q0)))
  const sizes = [1, 2].map((t) => q0.players.filter((p: any) => p.team === t).length); assert.deepEqual(sizes.sort(), [1, 2], '3 Spieler: 2 + 1')
  for (const p of [a, b, d]) await answer(p.token, c.id, 0, correctOf(c.id, 0))
  const r0 = await w.waitFor((s) => s.status === 'reveal' && s.idx === 0)
  assert.equal(r0.team_rank.length, 2); const big = r0.team_rank.find((t: any) => t.members === 2), small = r0.team_rank.find((t: any) => t.members === 1)
  assert.ok(Math.abs(big.value - small.value) < 400, 'Durchschnitt statt Summe: größeres Team hat keinen Vorteil durch Kopfzahl')
  assert.ok(big.value < 2 * Math.min(...r0.players.map((p: any) => p.score)) + 1000)
  await call('POST', `/api/live/${c.id}/end`, {}, h.token); w.close()
})

test('Sofa-Modus: liefert Fragen mit Lösung, speichert nichts, begrenzt die Anzahl', async () => {
  const p = await newPlayer('Sofa Spieler')
  const before = all('SELECT 1 FROM seen').length
  const r = await call('GET', '/api/sofa?n=9', undefined, p.token)
  assert.equal(r.status, 200); assert.equal(r.json.questions.length, 9)
  for (const q of r.json.questions) { assert.equal(q.options.length, 4); assert.ok(q.correct_index >= 0 && q.correct_index < 4); assert.ok(q.text && q.category) }
  assert.equal(new Set(r.json.questions.map((q: any) => q.text)).size, 9, 'keine doppelten Fragen')
  assert.equal((await call('GET', '/api/sofa?n=500', undefined, p.token)).json.questions.length, 60, 'Obergrenze')
  assert.equal((await call('GET', '/api/sofa', undefined, p.token)).json.questions.length, 12, 'Standard')
  assert.equal(all('SELECT 1 FROM seen').length, before, 'zählt nicht als gesehen/Statistik')
  assert.equal((await call('GET', '/api/sofa')).status, 401, 'nur mit Profil (Lastbegrenzung)')
})

test('Quizshow: Schnellster Finger wählt den Kandidaten, Joker (50:50, Publikum), Aussteigen, Publikumspunkte, Kandidatenwechsel bis alle dran waren', async () => {
  const [h, a, b, d] = [await newPlayer('Show Host'), await newPlayer('Kandidatin A'), await newPlayer('Publikum B'), await newPlayer('Publikum C')]
  const c = (await call('POST', '/api/live', { mode: 'show', screen: true }, h.token)).json
  for (const p of [a, b, d]) await call('POST', '/api/live/join', { token: c.live.token }, p.token)
  const w = await watch(h.token, c.id)
  const show = (tok: string, action: string) => call('POST', `/api/live/${c.id}/show`, { action }, tok)
  await call('POST', `/api/live/${c.id}/start`, {}, h.token)
  // Qualifikation: A ist am schnellsten richtig, B etwas später, C falsch
  const q0 = await w.waitFor((s) => s.status === 'question' && s.idx === 0)
  assert.equal(q0.show.stage, 'qualify'); assert.equal(q0.show.candidate, null)
  await answer(a.token, c.id, 0, correctOf(c.id, 0)); await new Promise((r) => setTimeout(r, 20)); await answer(b.token, c.id, 0, correctOf(c.id, 0)); await answer(d.token, c.id, 0, wrongOf(c.id, 0))
  const r0 = await w.waitFor((s) => s.status === 'reveal' && s.idx === 0)
  assert.equal(r0.show.candidate.name, 'Kandidatin A')
  // Leiterstufe 1: Kandidatin hat Joker, Publikum stimmt ab
  const q1 = await w.waitFor((s) => s.status === 'question' && s.idx === 1)
  assert.equal(q1.show.stage, 'climb'); assert.equal(q1.show.step, 1); assert.equal(q1.question.prize, 100)
  assert.equal((await show(b.token, 'fifty')).status, 409, 'nur die Kandidatin')
  await answer(b.token, c.id, 1, correctOf(c.id, 1)); await answer(d.token, c.id, 1, wrongOf(c.id, 1))
  const f = await show(a.token, 'fifty'); assert.equal(f.status, 200)
  assert.equal((await show(a.token, 'fifty')).status, 409, 'Joker nur einmal')
  const st1 = (await call('GET', `/api/live/${c.id}`, undefined, a.token)).json.live
  assert.equal(st1.question.hidden.length, 2); assert.ok(!st1.question.hidden.includes(correctOf(c.id, 1)), '50:50 versteckt nie die richtige Antwort')
  assert.equal((await answer(a.token, c.id, 1, st1.question.hidden[0])).status, 400, 'ausgeblendete Antwort nicht wählbar')
  assert.equal(st1.show.audience, null, 'Publikumsvoten erst nach dem Joker')
  assert.equal((await show(a.token, 'audience')).status, 200)
  const st2 = (await call('GET', `/api/live/${c.id}`, undefined, a.token)).json.live
  assert.equal(st2.show.audience.reduce((x: number, y: number) => x + y, 0), 100); assert.equal(st2.show.audience[correctOf(c.id, 1)], 50)
  assert.equal(st2.me.answered, false, 'Kandidatin hat noch nicht geantwortet')
  assert.equal((await answer(a.token, c.id, 1, correctOf(c.id, 1))).status, 200, 'Antwort der Kandidatin beendet die Frage sofort')
  const r1 = await w.waitFor((s) => s.status === 'reveal' && s.idx === 1)
  assert.equal(r1.players.find((p: any) => p.name === 'Publikum B').score, 100, 'Publikum richtig = 100 Punkte')
  // Stufe 2: Aussteigen → 100
  const q2 = await w.waitFor((s) => s.status === 'question' && s.idx === 2); assert.equal(q2.show.step, 2)
  assert.equal((await show(a.token, 'quit')).status, 200)
  const r2 = await w.waitFor((s) => s.status === 'reveal' && s.idx === 2)
  assert.deepEqual(r2.show.results.map((r: any) => [r.name, r.prize, r.how]), [['Kandidatin A', 100, 'quit']])
  // Nächste Qualifikation ohne A: B ist schneller
  const q3 = await w.waitFor((s) => s.status === 'question' && s.idx === 3); assert.equal(q3.show.stage, 'qualify')
  assert.equal((await answer(a.token, c.id, 3, 0)).status, 409, 'wer schon dran war, schaut zu')
  await answer(b.token, c.id, 3, correctOf(c.id, 3)); await new Promise((r) => setTimeout(r, 20)); await answer(d.token, c.id, 3, correctOf(c.id, 3))
  await w.waitFor((s) => s.status === 'question' && s.idx === 4 && s.show.candidate?.name === 'Publikum B')
  // B liegt falsch auf Stufe 1 → nichts gesichert → 0; C ist der Letzte und direkt dran
  await answer(b.token, c.id, 4, wrongOf(c.id, 4))
  const r4 = await w.waitFor((s) => s.status === 'reveal' && s.idx === 4)
  assert.deepEqual(r4.show.results.map((r: any) => [r.name, r.prize, r.how]), [['Kandidatin A', 100, 'quit'], ['Publikum B', 0, 'lost']])
  const q5 = await w.waitFor((s) => s.status === 'question' && s.idx === 5); assert.equal(q5.show.stage, 'climb'); assert.equal(q5.show.candidate.name, 'Publikum C')
  await show(d.token, 'quit')
  const fin = await w.waitFor((s) => s.status === 'finished', 4000)
  assert.equal(fin.show.results.length, 3); assert.equal(fin.players[0].name, 'Kandidatin A', 'A hat 100 + Publikumspunkte')
  w.close()
})
