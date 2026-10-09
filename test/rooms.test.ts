import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { boot, get, all, run, importBatch } from './helpers.ts'

const t = await boot()
test.after(() => t.close())
const { call, newPlayer } = t
for (const f of ['original-001', 'original-002']) {
  const r = importBatch(JSON.parse(fs.readFileSync(new URL(`../batches/${f}.json`, import.meta.url), 'utf8')))
  assert.deepEqual(r.errors, [])
}
const { sweepRooms } = await import('../server/rooms.ts')

const correctIdx = (roomId: number, step: number) =>
  (JSON.parse(get<{ perm: string }>('SELECT perm FROM room_questions WHERE room_id=? AND idx=?', roomId, step - 1)!.perm) as number[]).indexOf(0)

async function lobby(mode: string, host: { token: string }, ...guests: { token: string }[]) {
  const r = await call('POST', '/api/rooms', { mode, lang: 'de' }, host.token)
  assert.equal(r.status, 200, JSON.stringify(r.json))
  for (const g of guests) assert.equal((await call('POST', '/api/rooms/join', { code: r.json.room.code.toLowerCase() }, g.token)).status, 200)
  return r.json.id as number
}
async function answer(token: string, id: number, step: number, ok: boolean) {
  const q = await call('GET', `/api/rooms/${id}/question`, undefined, token)
  assert.equal(q.status, 200, JSON.stringify(q.json)); assert.equal(q.json.step, step)
  assert.ok(!('correct_index' in q.json))
  const right = correctIdx(id, step)
  return call('POST', `/api/rooms/${id}/answer`, { step, choice: ok ? right : (right + 1) % 4 }, token)
}

test('Lobby: Code beitreten, Maximalzahl, Start nur durch den Gastgeber ab 2 Spielern', async () => {
  const [a, b, c] = [await newPlayer('Gastgeber'), await newPlayer('Gast Eins'), await newPlayer('Fremder')]
  const id = await lobby('quiz', a)
  assert.equal((await call('POST', `/api/rooms/${id}/start`, {}, a.token)).status, 409, 'allein starten nicht möglich')
  assert.equal((await call('GET', `/api/rooms/${id}`, undefined, c.token)).status, 404, 'Nichtmitglied sieht nichts')
  assert.equal((await call('POST', '/api/rooms/join', { code: 'XXXXXX' }, c.token)).status, 404)
  const code = (await call('GET', `/api/rooms/${id}`, undefined, a.token)).json.room.code
  assert.equal((await call('POST', '/api/rooms/join', { code }, b.token)).status, 200)
  assert.equal((await call('POST', '/api/rooms/join', { code }, b.token)).status, 200, 'erneutes Beitreten ist harmlos')
  assert.equal((await call('POST', `/api/rooms/${id}/start`, {}, b.token)).status, 403, 'nur der Gastgeber')
  assert.equal((await call('POST', '/api/rooms', { mode: 'chaos' }, a.token)).status, 400)
  // Raum füllen
  for (let i = 0; i < 4; i++) assert.equal((await call('POST', '/api/rooms/join', { code }, (await newPlayer('Zusatz ' + i)).token)).status, 200)
  assert.equal((await call('POST', '/api/rooms/join', { code }, c.token)).status, 409, 'voll (6)')
  // Gast geht, Gastgeber löst Lobby auf
  assert.equal((await call('POST', `/api/rooms/${id}/leave`, {}, b.token)).status, 200)
  assert.equal((await call('POST', `/api/rooms/${id}/leave`, {}, a.token)).status, 200)
  assert.equal(all('SELECT 1 FROM rooms WHERE id=?', id).length, 0)
})

test('Quiz: alle spielen dieselben 12 Fragen; Punkte anderer bleiben bis zum Ende verborgen; Rangliste', async () => {
  const [a, b] = [await newPlayer('Schnell'), await newPlayer('Langsam')]
  const id = await lobby('quiz', a, b)
  assert.equal((await call('POST', `/api/rooms/${id}/start`, {}, a.token)).status, 200)
  assert.equal((await call('GET', `/api/rooms/${id}/question`, undefined, a.token)).json.text, (await call('GET', `/api/rooms/${id}/question`, undefined, b.token)).json.text, 'gleiche Frage')
  assert.equal(all('SELECT 1 FROM room_questions WHERE room_id=?', id).length, 12)
  assert.equal((await call('POST', `/api/rooms/${id}/start`, {}, a.token)).status, 409, 'läuft schon')
  assert.equal((await call('POST', '/api/rooms/join', { code: (await call('GET', `/api/rooms/${id}`, undefined, a.token)).json.room.code }, (await newPlayer('Zu spät')).token)).status, 409)

  let last: any
  for (let s = 1; s <= 12; s++) last = await answer(a.token, id, s, true)
  assert.equal(last.json.over, true); assert.equal(last.json.room.status, 'active', 'b ist noch nicht fertig')
  const mid = (await call('GET', `/api/rooms/${id}`, undefined, b.token)).json.room
  const pa = mid.players.find((p: any) => !p.is_me)
  assert.equal(pa.done, true); assert.equal(pa.score, null, 'Punkte des anderen verborgen'); assert.equal(pa.pos, 12)

  for (let s = 1; s <= 12; s++) last = await answer(b.token, id, s, s % 2 === 0) // 6 richtig
  assert.equal(last.json.room.status, 'finished')
  const end = (await call('GET', `/api/rooms/${id}`, undefined, a.token)).json.room
  const byName = Object.fromEntries(end.players.map((p: any) => [p.name, p]))
  assert.equal(byName.Schnell.score, 12); assert.equal(byName.Schnell.rank, 1)
  assert.equal(byName.Langsam.score, 6); assert.equal(byName.Langsam.rank, 2)
  assert.equal((await call('GET', `/api/rooms/${id}/question`, undefined, a.token)).status, 409)
  const list = (await call('GET', '/api/rooms', undefined, a.token)).json.rooms
  assert.equal(list[0].status, 'finished'); assert.equal(list[0].my_rank, 1)
})

test('Mindeststufe im Raum: Experte und Basis spielen auf Basis', async () => {
  const [a, b] = [await newPlayer('Profi'), await newPlayer('Einsteiger')]
  await call('PATCH', '/api/me', { level: 'expert' }, a.token)
  const id = await lobby('quiz', a, b)
  await call('POST', `/api/rooms/${id}/start`, {}, a.token)
  const room = get<{ level: string; cats: string }>('SELECT level, cats FROM rooms WHERE id=?', id)!
  assert.equal(room.level, 'basic')
  assert.ok((JSON.parse(room.cats) as string[]).every((c) => !/^expert_|^(scifi_fantasy|coding|anime|retro_games)$/.test(c)))
})

test('Leiter-Wettkampf: Sicherheitsstufen, Aussteigen und Wertung nach Betrag', async () => {
  const [a, b, c] = [await newPlayer('Ausstieger'), await newPlayer('Absturz'), await newPlayer('Durchhalter')]
  const id = await lobby('ladder', a, b, c)
  await call('POST', `/api/rooms/${id}/start`, {}, a.token)
  assert.equal(all('SELECT 1 FROM room_questions WHERE room_id=?', id).length, 15)
  await answer(a.token, id, 1, true); await answer(a.token, id, 2, true)
  assert.equal((await call('POST', `/api/rooms/${id}/quit`, {}, a.token)).status, 200)
  assert.equal((await answer(b.token, id, 1, false)).json.over, true)
  for (let s = 1; s <= 6; s++) await answer(c.token, id, s, true)
  const r = await answer(c.token, id, 7, false) // fällt auf Sicherheitsstufe 5 = 1000
  assert.equal(r.json.room.status, 'finished')
  const end = (await call('GET', `/api/rooms/${id}`, undefined, a.token)).json.room
  const score = Object.fromEntries(end.players.map((p: any) => [p.name, [p.score, p.rank]]))
  assert.deepEqual(score, { Ausstieger: [200, 2], Absturz: [0, 3], Durchhalter: [1000, 1] })
  assert.equal((await call('POST', `/api/rooms/${id}/quit`, {}, a.token)).status, 409)
})

test('Quiz-Modus kennt kein Aussteigen; Zeitüberschreitung zählt als falsch', async () => {
  const [a, b] = [await newPlayer('Trödler'), await newPlayer('Wartender')]
  const id = await lobby('quiz', a, b)
  await call('POST', `/api/rooms/${id}/start`, {}, a.token)
  assert.equal((await call('POST', `/api/rooms/${id}/quit`, {}, a.token)).status, 400)
  await call('GET', `/api/rooms/${id}/question`, undefined, a.token)
  run('UPDATE room_answers SET served_at=served_at-1000000 WHERE room_id=?', id)
  assert.equal((await call('GET', `/api/rooms/${id}/question`, undefined, a.token)).status, 409, 'abgelaufen')
  const mine = (await call('GET', `/api/rooms/${id}`, undefined, a.token)).json.room.players.find((p: any) => p.is_me)
  assert.equal(mine.pos, 1); assert.equal(mine.score, 0)
  assert.equal((await call('POST', `/api/rooms/${id}/answer`, { step: 5, choice: 0 }, a.token)).status, 409, 'falscher Schritt')
})

test('Frist: überfällige Runden werden mit dem aktuellen Stand gewertet; Lobbys verfallen', async () => {
  const [a, b] = [await newPlayer('Eilig'), await newPlayer('Verschwunden')]
  const id = await lobby('quiz', a, b)
  await call('POST', `/api/rooms/${id}/start`, {}, a.token)
  for (let s = 1; s <= 3; s++) await answer(a.token, id, s, true)
  run('UPDATE rooms SET deadline=1 WHERE id=?', id)
  const old = await lobby('quiz', a)
  run('UPDATE rooms SET updated_at=1 WHERE id=?', old)
  sweepRooms()
  const end = (await call('GET', `/api/rooms/${id}`, undefined, b.token)).json.room
  assert.equal(end.status, 'finished')
  assert.equal(end.players.find((p: any) => p.name === 'Eilig').score, 3)
  assert.equal(all('SELECT 1 FROM rooms WHERE id=?', old).length, 0, 'Lobby verfallen')
})

test('Meldungen nur für beantwortete Fragen; Konto löschen beendet die Teilnahme', async () => {
  const [a, b] = [await newPlayer('Melder Zwei'), await newPlayer('Aussteiger Zwei')]
  const id = await lobby('quiz', a, b)
  await call('POST', `/api/rooms/${id}/start`, {}, a.token)
  await call('GET', `/api/rooms/${id}/question`, undefined, a.token)
  assert.equal((await call('POST', `/api/rooms/${id}/report`, { step: 1 }, a.token)).status, 400)
  await answer(a.token, id, 1, true)
  assert.equal((await call('POST', `/api/rooms/${id}/report`, { step: 1 }, a.token)).status, 200)
  assert.equal((await call('DELETE', '/api/me', undefined, b.token)).status, 200)
  assert.equal(get<{ done: number }>('SELECT done FROM room_players WHERE room_id=? AND player_id=(SELECT id FROM players WHERE name=?)', id, '—')!.done, 1)
})
